import ts from "typescript";
import type { ComponentAnalysis } from "../types.js";

/**
 * Layer-specific AST analysis: hooks/composables (signature, query keys,
 * adapter calls), services/adapters (API endpoints, DTOs), and store
 * identity (Pinia / Zustand / Redux Toolkit).
 */

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH"]);

function isAdapterOrServiceName(name: string): boolean {
  return /(?:Adapter|Service)/i.test(name);
}

function extractHookSignature(
  params: ts.NodeArray<ts.ParameterDeclaration>,
  returnType: ts.TypeNode | undefined,
  sourceFile: ts.SourceFile
): Pick<ComponentAnalysis, "parameters" | "returnType"> {
  const result: Pick<ComponentAnalysis, "parameters" | "returnType"> = {};
  if (params.length > 0) {
    result.parameters = params.map((p) => {
      if (ts.isIdentifier(p.name)) return p.name.text;
      if (ts.isObjectBindingPattern(p.name)) {
        return p.name.elements
          .map((e) => (ts.isIdentifier(e.name) ? e.name.text : ""))
          .filter(Boolean)
          .join(", ");
      }
      return p.name.getText(sourceFile);
    });
  }
  if (returnType) {
    result.returnType = returnType.getText(sourceFile);
  }
  return result;
}

/** Hook/composable analysis: signature, React Query keys, adapter/service calls. */
export function analyzeHook(sourceFile: ts.SourceFile): Partial<ComponentAnalysis> {
  const result: Partial<ComponentAnalysis> = {};
  const queryKeys: string[] = [];
  const adapterCalls = new Set<string>();

  const visit = (node: ts.Node) => {
    // Function declaration hooks: export function useXxx(...) { ... }
    if (ts.isFunctionDeclaration(node) && node.name?.text.startsWith("use")) {
      Object.assign(result, extractHookSignature(node.parameters, node.type, sourceFile));
    }

    // Arrow function hooks: export const useXxx = (...) => { ... }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text.startsWith("use") &&
      node.initializer &&
      ts.isArrowFunction(node.initializer)
    ) {
      Object.assign(result, extractHookSignature(node.initializer.parameters, node.initializer.type, sourceFile));
    }

    // React Query keys
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "queryKey" &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      queryKeys.push(node.initializer.getText(sourceFile));
    }

    // Adapter/service calls: direct function calls
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && isAdapterOrServiceName(node.expression.text)) {
      adapterCalls.add(node.expression.text);
    }

    // Adapter/service calls: property access (someAdapter.method())
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      isAdapterOrServiceName(node.expression.expression.text)
    ) {
      adapterCalls.add(node.expression.expression.text);
    }

    // Adapter/service detection from imports
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const src = node.moduleSpecifier.text;
      if (src.includes("services") || src.includes("adapters")) {
        const match = src.match(/\/(\w+)$/);
        if (match) adapterCalls.add(match[1]);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (queryKeys.length > 0) result.queryKeys = queryKeys;
  if (adapterCalls.size > 0) result.adapterCalls = Array.from(adapterCalls).sort();

  return result;
}

/** Service/adapter analysis: API endpoints, DTO usage, mock detection. */
export function analyzeServiceOrAdapter(
  sourceFile: ts.SourceFile,
  content: string
): Partial<ComponentAnalysis> {
  const result: Partial<ComponentAnalysis> = {};
  const endpoints: string[] = [];
  const dtos = new Set<string>();

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      endpoints.push(...extractEndpointsFromCall(node, sourceFile));
    }

    // Detect DTO type references
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && /Dto$/.test(node.typeName.text)) {
      dtos.add(node.typeName.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (endpoints.length > 0) {
    result.apiEndpoints = [...new Set(endpoints)];
  }

  // Mock detection
  result.hasMockImplementation =
    (/Mock\w+Adapter|mock\w+/i.test(content) && /Api\w+Adapter|Real\w+/i.test(content)) ||
    /useMockData|config\.useMock/i.test(content);

  if (dtos.size > 0) {
    result.dtosUsed = Array.from(dtos).sort();
  }

  return result;
}

/**
 * Pull endpoint(s) from a single call expression. Handles three shapes:
 *   1. HTTP client verb — `client.get("/x")`            → "GET /x"
 *   2. `fetch("/x")` / `fetch(\`${base}/x\`)`           → "/x"
 *   3. Custom HTTP wrapper — `authedJson("GET", "/x")`,
 *      `request("/x")`, `apiClient.call("POST", "/x")`  → "GET /x" / "/x"
 *
 * (3) only fires inside service/adapter files (this module's only use), so
 * a path-shaped string argument to any call is almost certainly an endpoint.
 * The HTTP method is lifted from a sibling method-literal arg when present.
 */
function extractEndpointsFromCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile
): string[] {
  // 1. Standard client verb: x.get(...) / x.post(...)
  if (ts.isPropertyAccessExpression(node.expression)) {
    const verb = node.expression.name.text.toUpperCase();
    if (HTTP_METHODS.has(verb)) {
      const path = getEndpointText(node.arguments[0], sourceFile);
      return path ? [`${verb} ${path}`] : [];
    }
  }

  // 2. fetch(...)
  if (ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
    const path = node.arguments[0]
      ? getEndpointText(node.arguments[0], sourceFile)
      : undefined;
    return path ? [path] : [];
  }

  // 3. Custom wrapper — scan args for an API-path-shaped string, plus a method literal.
  let method: string | undefined;
  for (const arg of node.arguments) {
    if (ts.isStringLiteral(arg) && HTTP_METHODS.has(arg.text.toUpperCase())) {
      method = arg.text.toUpperCase();
      break;
    }
  }
  const out: string[] = [];
  for (const arg of node.arguments) {
    const text = getEndpointText(arg, sourceFile);
    if (text && looksLikeApiPath(text)) {
      out.push(method ? `${method} ${text}` : text);
    }
  }
  return [...new Set(out)];
}

function getEndpointText(arg: ts.Expression, sourceFile: ts.SourceFile): string | undefined {
  if (ts.isStringLiteral(arg)) return arg.text;
  // `plain/path` with no interpolation
  if (ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  // `${base}/path/${id}` → resolve to a matchable path like "/path/{id}"
  if (ts.isTemplateExpression(arg)) return resolveTemplateEndpoint(arg, sourceFile);
  return undefined;
}

/**
 * Turn a template-literal URL into a static path we can match against runtime
 * requests. Leading base-URL interpolations (`${backendUrl}`, `import.meta.env.*`,
 * `process.env.*`) are stripped; path-segment interpolations become `{param}`
 * placeholders. Returns undefined when nothing static remains (fully dynamic,
 * e.g. `${base}${path}`), so we don't store unmatchable junk.
 */
function resolveTemplateEndpoint(
  node: ts.TemplateExpression,
  sourceFile: ts.SourceFile
): string | undefined {
  let path = node.head.text;
  for (const span of node.templateSpans) {
    const exprText = span.expression.getText(sourceFile);
    if (!isBaseUrlExpr(exprText)) {
      path += `{${paramName(span.expression)}}`;
    }
    // base-url interpolations contribute nothing; the literal after them remains
    path += span.literal.text;
  }

  path = path.replace(/\/{2,}/g, "/").trim();
  if (path && !path.startsWith("/") && !path.startsWith("{")) path = "/" + path;

  // Reject if no static (non-placeholder) path segment survives.
  const staticPart = path.replace(/\{[^}]*\}/g, "");
  if (!/[a-zA-Z0-9]/.test(staticPart)) return undefined;
  return path;
}

/** Heuristic: does this interpolated expression name a base URL / host, not a path segment? */
function isBaseUrlExpr(text: string): boolean {
  const t = text.toLowerCase();
  if (t.includes("import.meta.env") || t.includes("process.env")) return true;
  return /url|host|origin|backend|gateway|baseapi/.test(t);
}

/** Best-effort name for an interpolated path parameter (`params.id` → "id"). */
function paramName(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return "param";
}

/**
 * Conservative check for the wrapper heuristic: require a leading "/" followed
 * by a letter or "{" so we catch "/assistant/access" and "/users/{id}" but not
 * content-types ("application/json"), bare slashes, or method words ("GET").
 */
function looksLikeApiPath(text: string): boolean {
  return /^\/[A-Za-z{]/.test(text);
}

// ========== Store Detection (Pinia / Zustand / Redux Toolkit) ==========

/** Is this initializer a Zustand `create(...)` or curried `create<T>()(...)`? */
function isZustandCreate(init: ts.Expression): boolean {
  if (!ts.isCallExpression(init)) return false;
  // create(...)
  if (ts.isIdentifier(init.expression) && init.expression.text === "create") return true;
  // create<T>()(...) — the callee is itself a `create<T>()` call.
  return (
    ts.isCallExpression(init.expression) &&
    ts.isIdentifier(init.expression.expression) &&
    init.expression.expression.text === "create"
  );
}

/** True when this variable declaration sits in an `export const ...` statement. */
function isExportedVariableDecl(node: ts.VariableDeclaration): boolean {
  const list = node.parent;
  if (!list || !ts.isVariableDeclarationList(list)) return false;
  const stmt = list.parent;
  if (!stmt || !ts.isVariableStatement(stmt)) return false;
  const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/**
 * Best-effort store identity across the three common libraries (first match wins):
 *   - Pinia:  defineStore("cartStore", ...)      → the string id
 *   - Redux:  createSlice({ name: "cart", ... })  → the `name` property
 *   - Zustand: export const useCartStore = create(...) → the variable name
 * Returns undefined when the file doesn't look like a store definition.
 */
export function extractStoreName(sourceFile: ts.SourceFile): string | undefined {
  let storeName: string | undefined;

  const visit = (node: ts.Node) => {
    if (storeName) return;

    // Pinia: defineStore("id", ...)
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineStore") {
      const first = node.arguments[0];
      if (first && ts.isStringLiteral(first)) {
        storeName = first.text;
        return;
      }
    }

    // Redux Toolkit: createSlice({ name: "cart", ... })
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createSlice") {
      const first = node.arguments[0];
      if (first && ts.isObjectLiteralExpression(first)) {
        for (const prop of first.properties) {
          if (
            ts.isPropertyAssignment(prop) &&
            ts.isIdentifier(prop.name) &&
            prop.name.text === "name" &&
            ts.isStringLiteral(prop.initializer)
          ) {
            storeName = prop.initializer.text;
            return;
          }
        }
      }
    }

    // Zustand: export const useXxxStore = create(...) / create<T>()(...)
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isZustandCreate(node.initializer) &&
      isExportedVariableDecl(node)
    ) {
      storeName = node.name.text;
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return storeName;
}
