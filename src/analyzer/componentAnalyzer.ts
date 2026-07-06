import fs from "fs/promises";
import path from "path";
import ts from "typescript";
import type {
  ComponentAnalysis,
  ImportInfo,
  ArchitectureLayer,
  PhiComplianceInfo,
  FormFieldInfo,
  ProjectConfig,
  ChildEventBinding,
  TemplatePatterns,
  OverlayPattern,
  ZIndexRef,
  HeadingInfo,
} from "../types.js";

/**
 * Component Analyzer - AST-Based
 * Uses TypeScript Compiler API for accurate code analysis instead of regex
 */
export class ComponentAnalyzer {
  private config?: ProjectConfig;
  private workspaceRoot?: string;

  constructor(config?: ProjectConfig, workspaceRoot?: string) {
    this.config = config;
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Extract <script> or <script setup> content from a .vue SFC
   */
  private extractVueScript(content: string): string {
    // Match <script setup lang="ts"> or <script lang="ts"> blocks
    const scriptMatch = content.match(
      /<script\b[^>]*>([\s\S]*?)<\/script>/
    );
    return scriptMatch ? scriptMatch[1] : "";
  }

  async analyzeComponent(
    filePath: string,
    componentName: string,
    layer: ArchitectureLayer = "component"
  ): Promise<ComponentAnalysis> {
    try {
      const rawContent = await fs.readFile(filePath, "utf-8");
      const isVue = filePath.endsWith(".vue");

      // For .vue files, extract the <script> block for AST analysis
      let content = isVue ? this.extractVueScript(rawContent) : rawContent;

      const sourceFile = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true,
        filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      );

      const base = this.analyzeWithAST(sourceFile, content, componentName, filePath);

      // Vue: analyze <template> block for child components, events, v-model
      if (isVue) {
        const templateAnalysis = this.analyzeVueTemplate(rawContent);
        base.childComponents = [...new Set([...(base.childComponents || []), ...templateAnalysis.childComponents])].sort();
        base.eventHandlers = [...new Set([...(base.eventHandlers || []), ...templateAnalysis.eventHandlers])].sort();

        // Extract emits from defineEmits / Options API
        base.emits = this.extractVueEmits(sourceFile);

        // Emit liveness: which declared emits actually fire vs. which are dead
        // plumbing (declared but never emit()-ed), plus any fired-but-undeclared.
        const liveness = this.extractEmitLiveness(sourceFile, rawContent, base.emits ?? []);
        if (liveness.fired.length) base.emitsFired = liveness.fired;
        if (liveness.dead.length) base.emitsDead = liveness.dead;
        if (liveness.undeclared.length) base.emitsUndeclared = liveness.undeclared;
        if (liveness.dynamic) base.emitsDynamic = true;

        // Per-child @event bindings — feeds cross-component dangling-listener detection.
        const childBindings = this.extractChildEventBindings(rawContent);
        if (childBindings.length) base.childEventBindings = childBindings;

        // Template-layer design signals: overlay/backdrop, Teleport, z-index, header.
        const templatePatterns = this.analyzeVueTemplatePatterns(rawContent);
        if (templatePatterns) base.templatePatterns = templatePatterns;

        // Detect v-model bindings: emits matching "update:xxx" pattern
        if (base.emits?.length) {
          const vModelBindings = base.emits
            .filter((e) => e.startsWith("update:"))
            .map((e) => e.slice("update:".length));
          if (vModelBindings.length > 0) {
            base.vModelBindings = vModelBindings;
          }
        }

        // Use full content for accessibility (includes <template>)
        base.accessibility = this.extractAccessibility(rawContent);

        // Selectors live in the <template>, not the <script> AST — extract via regex.
        const vueSelectors = this.extractVueTemplateSelectors(rawContent);
        if (vueSelectors.testIds.length) {
          base.testIds = [...new Set([...(base.testIds || []), ...vueSelectors.testIds])].sort();
        }
        if (vueSelectors.formFields.length) {
          base.formFields = this.dedupeFormFields([...(base.formFields || []), ...vueSelectors.formFields]);
        }
      }

      if (layer === "hook") {
        Object.assign(base, this.analyzeHookAST(sourceFile, content));
      } else if (layer === "service" || layer === "adapter") {
        Object.assign(base, this.analyzeServiceOrAdapterAST(sourceFile, content));
      } else if (layer === "store") {
        // Stores expose service endpoints (they frequently call services directly)
        // AND collect adapter/service calls the way a hook does. Merge both signals.
        const serviceAnalysis = this.analyzeServiceOrAdapterAST(sourceFile, content);
        const hookAnalysis = this.analyzeHookAST(sourceFile, content);
        Object.assign(base, serviceAnalysis, hookAnalysis);
        const mergedAdapterCalls = [
          ...new Set([...(serviceAnalysis.adapterCalls || []), ...(hookAnalysis.adapterCalls || [])]),
        ];
        if (mergedAdapterCalls.length) base.adapterCalls = mergedAdapterCalls.sort();
        const storeName = this.extractStoreName(sourceFile);
        if (storeName) base.storeName = storeName;
      }

      // PHI compliance is opt-in — noisy heuristics only run when explicitly enabled.
      if (
        this.config?.phiCompliance?.enabled === true &&
        (layer === "hook" || layer === "component" || layer === "page")
      ) {
        base.phiCompliance = this.checkPhiComplianceAST(sourceFile, content);
      }

      return base;
    } catch (error) {
      console.error(`Error analyzing ${filePath}:`, error);
      return {};
    }
  }

  /**
   * AST-based analysis — replaces regex for accuracy
   */
  private analyzeWithAST(
    sourceFile: ts.SourceFile,
    content: string,
    componentName: string,
    filePath?: string
  ): ComponentAnalysis {
    const hooks = new Set<string>();
    const stateVariables: string[] = [];
    const childComponents = new Set<string>();
    const eventHandlers = new Set<string>();
    const imports: ImportInfo[] = [];
    const testIds = new Set<string>();
    const formFields: FormFieldInfo[] = [];
    const storeCalls = new Set<string>();
    let line: number | undefined;
    let exportType: "named" | "default" | "none" = "none";
    let description: string | undefined;

    const filteredJsxNames = new Set([
      "Fragment", "Provider", "Consumer", "Suspense", "StrictMode",
    ]);

    const visit = (node: ts.Node) => {
      // Extract imports
      if (ts.isImportDeclaration(node)) {
        const imp = this.extractImportFromNode(node, filePath);
        if (imp) {
          imports.push(imp);
          // Store hooks imported from a store-ish path (Pinia/Zustand convention).
          if (imp.source.toLowerCase().includes("store")) {
            for (const n of imp.names) {
              if (/^use[A-Z]/.test(n)) storeCalls.add(n);
            }
          }
        }
      }

      // Find component declaration line + export type + JSDoc
      if (ts.isFunctionDeclaration(node) && node.name?.text === componentName) {
        line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        exportType = this.getExportType(node);
        description = this.getJSDocFromNode(node, sourceFile);
      }
      if (ts.isVariableStatement(node)) {
        const decl = node.declarationList.declarations[0];
        if (decl && ts.isIdentifier(decl.name) && decl.name.text === componentName) {
          line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          exportType = this.getExportType(node);
          description = this.getJSDocFromNode(node, sourceFile);
        }
      }

      // Extract hook calls: useXxx(...) or React.useXxx(...)
      if (ts.isCallExpression(node)) {
        const hookName = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : undefined;
        if (hookName && /^use[A-Z]/.test(hookName)) {
          hooks.add(hookName);
          // Store usage: useCartStore(), useUserStore() — Pinia + Zustand convention.
          if (/^use[A-Z]\w*Store$/.test(hookName)) storeCalls.add(hookName);
        }
      }

      // Extract useState destructuring: const [x, setX] = useState(...)
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (
          ts.isCallExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression) &&
          node.initializer.expression.text === "useState" &&
          ts.isArrayBindingPattern(node.name)
        ) {
          const first = node.name.elements[0];
          if (first && ts.isBindingElement(first) && ts.isIdentifier(first.name)) {
            if (first.name.text !== "_") {
              stateVariables.push(first.name.text);
            }
          }
        }

        // Vue: const x = ref(...), reactive({...}), computed(...), shallowRef(...)
        if (
          ts.isCallExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression) &&
          ["ref", "reactive", "computed", "shallowRef", "shallowReactive"].includes(node.initializer.expression.text) &&
          ts.isIdentifier(node.name) &&
          node.name.text !== "_"
        ) {
          stateVariables.push(node.name.text);
        }
      }

      // Extract JSX elements (child components) + form controls
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const { tagName } = node;
        const name = ts.isIdentifier(tagName) ? tagName.text
          : ts.isPropertyAccessExpression(tagName) ? tagName.getText(sourceFile)
          : undefined;
        if (name && /^[A-Z]/.test(name) && !filteredJsxNames.has(name)) {
          childComponents.add(name);
        }
        // Lowercase intrinsic form controls → drivable selectors for capture_flow.
        if (ts.isIdentifier(tagName) && ComponentAnalyzer.FORM_CONTROL_TAGS.has(tagName.text)) {
          formFields.push(this.extractJsxFormField(node, tagName.text));
        }
      }

      // Extract JSX event handler attributes: onClick={...}, and data-testid values
      if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name)) {
        const attrName = node.name.text;
        if (/^on[A-Z]/.test(attrName)) {
          eventHandlers.add(attrName);
        }
        if (attrName === "data-testid") {
          const val = this.getJsxAttrStringValue(node);
          if (val) testIds.add(val);
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    // Detect data fetching pattern
    const hooksArray = Array.from(hooks).sort();
    const dataFetchingPattern = this.detectDataFetchingPattern(content, hooksArray);

    // Extract accessibility info (keep regex here — it's scanning HTML-like content)
    const accessibility = this.extractAccessibility(content);

    const analysis: ComponentAnalysis = {
      line,
      exportType,
      description,
      hooks: hooksArray,
      stateVariables: stateVariables.sort(),
      childComponents: Array.from(childComponents).sort(),
      eventHandlers: Array.from(eventHandlers).sort(),
      imports,
      dataFetchingPattern,
      accessibility,
    };

    // Selector signals — omit entirely (not []) when nothing was found.
    const testIdList = Array.from(testIds).sort();
    if (testIdList.length) analysis.testIds = testIdList;

    const dedupedFields = this.dedupeFormFields(formFields);
    if (dedupedFields.length) analysis.formFields = dedupedFields;

    const storeCallList = Array.from(storeCalls).sort();
    if (storeCallList.length) analysis.storeCalls = storeCallList;

    return analysis;
  }

  /**
   * Extract import info from an import declaration AST node
   */
  private extractImportFromNode(
    node: ts.ImportDeclaration,
    filePath?: string
  ): ImportInfo | null {
    const moduleSpecifier = node.moduleSpecifier;
    if (!ts.isStringLiteral(moduleSpecifier)) return null;

    const source = moduleSpecifier.text;
    const clause = node.importClause;
    if (!clause) return null;

    const names: string[] = [];
    let type: "named" | "default" | "namespace" = "named";

    // Default import
    if (clause.name) {
      type = "default";
      names.push(clause.name.text);
    }

    // Named / namespace imports
    if (clause.namedBindings) {
      if (ts.isNamedImports(clause.namedBindings)) {
        type = clause.name ? "default" : "named";
        for (const element of clause.namedBindings.elements) {
          names.push(element.name.text);
        }
      } else if (ts.isNamespaceImport(clause.namedBindings)) {
        type = "namespace";
        names.push(clause.namedBindings.name.text);
      }
    }

    if (names.length === 0) return null;

    return {
      type,
      names,
      source,
      resolvedPath: this.resolveImportPath(source, filePath),
    };
  }

  /**
   * Resolve import path using configured aliases
   */
  private resolveImportPath(
    importSource: string,
    filePath?: string
  ): string | undefined {
    if (this.config?.aliases) {
      for (const [alias, target] of Object.entries(this.config.aliases)) {
        if (importSource.startsWith(alias)) {
          return target + importSource.slice(alias.length);
        }
      }
    }
    // Default @/ alias
    if (importSource.startsWith("@/")) {
      return `src/${importSource.slice(2)}`;
    }
    if (!importSource.startsWith(".")) {
      return undefined;
    }
    // Relative import: resolve against the importing file so consumers can key
    // importers by target file path (e.g. "../composables/useTokenRefreshTimer"
    // from src/adapters/apiClient.ts -> "src/composables/useTokenRefreshTimer").
    if (filePath && this.workspaceRoot) {
      const abs = path.resolve(path.dirname(filePath), importSource);
      const rel = path.relative(this.workspaceRoot, abs);
      if (!rel.startsWith("..")) {
        return rel.split(path.sep).join("/");
      }
    }
    return importSource;
  }

  /**
   * Get export type from a node
   */
  private getExportType(node: ts.Node): "named" | "default" | "none" {
    if (!ts.canHaveModifiers(node)) return "none";
    const modifiers = ts.getModifiers(node);
    if (!modifiers) return "none";

    let hasExport = false;
    let hasDefault = false;
    for (const mod of modifiers) {
      if (mod.kind === ts.SyntaxKind.ExportKeyword) hasExport = true;
      if (mod.kind === ts.SyntaxKind.DefaultKeyword) hasDefault = true;
    }

    if (hasExport && hasDefault) return "default";
    if (hasExport) return "named";
    return "none";
  }

  /**
   * Extract JSDoc comment from a node using TS API
   */
  private getJSDocFromNode(node: ts.Node, _sourceFile: ts.SourceFile): string | undefined {
    const jsDocs = (node as any).jsDoc as ts.JSDoc[] | undefined;
    if (!jsDocs || jsDocs.length === 0) return undefined;

    const comment = jsDocs[0].comment;
    if (typeof comment === "string") return comment;
    if (Array.isArray(comment)) {
      return comment.map((c: any) => (typeof c === "string" ? c : c.text || "")).join("");
    }
    return undefined;
  }

  /**
   * Detect data fetching pattern from hooks list
   */
  private detectDataFetchingPattern(
    content: string,
    hooks: string[]
  ): string | undefined {
    if (
      hooks.includes("useQuery") ||
      hooks.includes("useMutation") ||
      hooks.includes("useQueryClient")
    ) {
      return "react-query";
    }

    if (hooks.includes("useSWR")) {
      return "swr";
    }

    if (hooks.includes("useEffect")) {
      if (/useEffect[^}]*\bfetch\s*\(/s.test(content)) {
        return "useEffect-fetch";
      }
      if (/useEffect[^}]*\baxios\./s.test(content)) {
        return "useEffect-axios";
      }
    }

    // Vue: onMounted/watchEffect with service/adapter calls
    if (content.includes("onMounted") || content.includes("watchEffect")) {
      if (/(?:Service|Adapter)\.\w+\s*\(/.test(content)) {
        return "lifecycle-service-call";
      }
    }

    const dataHooks = hooks.filter(
      (h) =>
        h.startsWith("use") &&
        (h.toLowerCase().includes("fetch") ||
          h.toLowerCase().includes("load") ||
          h.toLowerCase().includes("get") ||
          h.toLowerCase().includes("data") ||
          /^use[A-Z][a-z]+s$/.test(h))
    );

    if (dataHooks.length > 0) {
      return `custom-composable: ${dataHooks[0]}`;
    }

    return undefined;
  }

  // ========== Hook Analysis (AST-based) ==========

  private extractHookSignature(
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

  private isAdapterOrServiceName(name: string): boolean {
    return /(?:Adapter|Service)/i.test(name);
  }

  private analyzeHookAST(sourceFile: ts.SourceFile, content: string): Partial<ComponentAnalysis> {
    const result: Partial<ComponentAnalysis> = {};
    const queryKeys: string[] = [];
    const adapterCalls = new Set<string>();

    const visit = (node: ts.Node) => {
      // Function declaration hooks: export function useXxx(...) { ... }
      if (ts.isFunctionDeclaration(node) && node.name?.text.startsWith("use")) {
        Object.assign(result, this.extractHookSignature(node.parameters, node.type, sourceFile));
      }

      // Arrow function hooks: export const useXxx = (...) => { ... }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text.startsWith("use") &&
        node.initializer &&
        ts.isArrowFunction(node.initializer)
      ) {
        Object.assign(result, this.extractHookSignature(node.initializer.parameters, node.initializer.type, sourceFile));
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
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && this.isAdapterOrServiceName(node.expression.text)) {
        adapterCalls.add(node.expression.text);
      }

      // Adapter/service calls: property access (someAdapter.method())
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        this.isAdapterOrServiceName(node.expression.expression.text)
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

  // ========== Service/Adapter Analysis (AST-based) ==========

  private getEndpointText(arg: ts.Expression, sourceFile: ts.SourceFile): string | undefined {
    if (ts.isStringLiteral(arg)) return arg.text;
    // `plain/path` with no interpolation
    if (ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
    // `${base}/path/${id}` → resolve to a matchable path like "/path/{id}"
    if (ts.isTemplateExpression(arg)) return this.resolveTemplateEndpoint(arg, sourceFile);
    return undefined;
  }

  /**
   * Turn a template-literal URL into a static path we can match against runtime
   * requests. Leading base-URL interpolations (`${backendUrl}`, `import.meta.env.*`,
   * `process.env.*`) are stripped; path-segment interpolations become `{param}`
   * placeholders. Returns undefined when nothing static remains (fully dynamic,
   * e.g. `${base}${path}`), so we don't store unmatchable junk.
   */
  private resolveTemplateEndpoint(
    node: ts.TemplateExpression,
    sourceFile: ts.SourceFile
  ): string | undefined {
    let path = node.head.text;
    for (const span of node.templateSpans) {
      const exprText = span.expression.getText(sourceFile);
      if (!this.isBaseUrlExpr(exprText)) {
        path += `{${this.paramName(span.expression)}}`;
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
  private isBaseUrlExpr(text: string): boolean {
    const t = text.toLowerCase();
    if (t.includes("import.meta.env") || t.includes("process.env")) return true;
    return /url|host|origin|backend|gateway|baseapi/.test(t);
  }

  /** Best-effort name for an interpolated path parameter (`params.id` → "id"). */
  private paramName(expr: ts.Expression): string {
    if (ts.isIdentifier(expr)) return expr.text;
    if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
    return "param";
  }

  /**
   * Pull endpoint(s) from a single call expression. Handles three shapes:
   *   1. HTTP client verb — `client.get("/x")`            → "GET /x"
   *   2. `fetch("/x")` / `fetch(\`${base}/x\`)`           → "/x"
   *   3. Custom HTTP wrapper — `authedJson("GET", "/x")`,
   *      `request("/x")`, `apiClient.call("POST", "/x")`  → "GET /x" / "/x"
   *
   * (3) only fires inside service/adapter files (this method's only caller), so
   * a path-shaped string argument to any call is almost certainly an endpoint.
   * The HTTP method is lifted from a sibling method-literal arg when present.
   */
  private extractEndpointsFromCall(
    node: ts.CallExpression,
    sourceFile: ts.SourceFile,
    httpMethods: Set<string>
  ): string[] {
    // 1. Standard client verb: x.get(...) / x.post(...)
    if (ts.isPropertyAccessExpression(node.expression)) {
      const verb = node.expression.name.text.toUpperCase();
      if (httpMethods.has(verb)) {
        const path = this.getEndpointText(node.arguments[0], sourceFile);
        return path ? [`${verb} ${path}`] : [];
      }
    }

    // 2. fetch(...)
    if (ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
      const path = node.arguments[0]
        ? this.getEndpointText(node.arguments[0], sourceFile)
        : undefined;
      return path ? [path] : [];
    }

    // 3. Custom wrapper — scan args for an API-path-shaped string, plus a method literal.
    let method: string | undefined;
    for (const arg of node.arguments) {
      if (ts.isStringLiteral(arg) && httpMethods.has(arg.text.toUpperCase())) {
        method = arg.text.toUpperCase();
        break;
      }
    }
    const out: string[] = [];
    for (const arg of node.arguments) {
      const text = this.getEndpointText(arg, sourceFile);
      if (text && this.looksLikeApiPath(text)) {
        out.push(method ? `${method} ${text}` : text);
      }
    }
    return [...new Set(out)];
  }

  /**
   * Conservative check for the wrapper heuristic: require a leading "/" followed
   * by a letter or "{" so we catch "/assistant/access" and "/users/{id}" but not
   * content-types ("application/json"), bare slashes, or method words ("GET").
   */
  private looksLikeApiPath(text: string): boolean {
    return /^\/[A-Za-z{]/.test(text);
  }

  private analyzeServiceOrAdapterAST(sourceFile: ts.SourceFile, content: string): Partial<ComponentAnalysis> {
    const result: Partial<ComponentAnalysis> = {};
    const endpoints: string[] = [];
    const dtos = new Set<string>();
    const httpMethods = new Set(["GET", "POST", "PUT", "DELETE", "PATCH"]);

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        for (const ep of this.extractEndpointsFromCall(node, sourceFile, httpMethods)) {
          endpoints.push(ep);
        }
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

  // ========== Selector Extraction (form controls + testIds) ==========

  /** Lowercase intrinsic elements we treat as drivable form controls. */
  private static FORM_CONTROL_TAGS = new Set(["input", "select", "textarea", "button"]);

  /**
   * Static string value of a JSX attribute, or undefined for dynamic ones.
   * Handles `attr="x"` and `attr={"x"}` / `attr={`x`}`; anything with an
   * expression (variable, call, template with substitutions) is skipped so we
   * never emit a selector we can't actually type into the browser.
   */
  private getJsxAttrStringValue(attr: ts.JsxAttribute): string | undefined {
    const init = attr.initializer;
    if (!init) return undefined; // valueless boolean attribute
    if (ts.isStringLiteral(init)) return init.text;
    if (ts.isJsxExpression(init) && init.expression) {
      const e = init.expression;
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    }
    return undefined;
  }

  /**
   * Build a FormFieldInfo, choosing the most specific stable selector available:
   * `#id` > `[data-testid="X"]` > `[name="X"]` > `tag[type="T"]` > bare tag.
   * Only fields with static string values reach here, so the selector is real.
   */
  private buildFormField(parts: {
    element: string;
    inputType?: string;
    name?: string;
    id?: string;
    testId?: string;
    label?: string;
  }): FormFieldInfo {
    const { element, inputType, name, id, testId, label } = parts;

    let selector: string;
    if (id) selector = `#${id}`;
    else if (testId) selector = `[data-testid="${testId}"]`;
    else if (name) selector = `[name="${name}"]`;
    else if (inputType) selector = `${element}[type="${inputType}"]`;
    else selector = element;

    const field: FormFieldInfo = { selector, element };
    if (inputType) field.inputType = inputType;
    if (name) field.name = name;
    if (id) field.id = id;
    if (testId) field.testId = testId;
    if (label) field.label = label;
    return field;
  }

  /** Extract a form control's static attributes from a JSX element. */
  private extractJsxFormField(
    node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
    element: string
  ): FormFieldInfo {
    const parts: Parameters<ComponentAnalyzer["buildFormField"]>[0] = { element };
    let ariaLabel: string | undefined;
    let placeholder: string | undefined;

    for (const attr of node.attributes.properties) {
      if (!ts.isJsxAttribute(attr) || !ts.isIdentifier(attr.name)) continue;
      const val = this.getJsxAttrStringValue(attr);
      if (val === undefined) continue; // skip dynamic attributes
      switch (attr.name.text) {
        case "type": parts.inputType = val; break;
        case "name": parts.name = val; break;
        case "id": parts.id = val; break;
        case "data-testid": parts.testId = val; break;
        case "aria-label": ariaLabel = val; break;
        case "placeholder": placeholder = val; break;
      }
    }

    parts.label = ariaLabel ?? placeholder;
    return this.buildFormField(parts);
  }

  /** Keep the first field per unique selector, capped at 25 per component. */
  private dedupeFormFields(fields: FormFieldInfo[]): FormFieldInfo[] {
    const bySelector = new Map<string, FormFieldInfo>();
    for (const f of fields) {
      if (!bySelector.has(f.selector)) bySelector.set(f.selector, f);
    }
    return Array.from(bySelector.values()).slice(0, 25);
  }

  /** Read a single static attribute value out of a raw HTML/Vue tag's attribute string.
   * The `(?<![:\w-])` guard rejects dynamic bindings (`:name`, `v-bind:name`) and
   * hyphenated look-alikes (`data-type` when matching `type`). */
  private matchTemplateAttr(attrs: string, name: string): string | undefined {
    const m = attrs.match(new RegExp(`(?<![:\\w-])${name}=["']([^"']+)["']`));
    return m ? m[1] : undefined;
  }

  /**
   * Vue selectors come from the <template>, which isn't in the <script> AST, so
   * we scan it with regex (HTML-ish content — the same tradeoff as accessibility).
   * Only lowercase intrinsic tags are treated as form controls; PascalCase Vue
   * components are ignored. Dynamic-bound attributes (`:id`, `v-bind:*`) are skipped.
   */
  private extractVueTemplateSelectors(fullContent: string): {
    testIds: string[];
    formFields: FormFieldInfo[];
  } {
    const templateMatch = fullContent.match(/<template\b[^>]*>([\s\S]*?)<\/template>/);
    if (!templateMatch) return { testIds: [], formFields: [] };
    const template = templateMatch[1];

    const testIds = this.uniqueSortedMatches(
      template,
      /(?<![:\w-])data-testid=["']([^"']+)["']/g,
      (m) => m[1]
    );

    const formFields: FormFieldInfo[] = [];
    const controlRegex = /<(input|select|textarea|button)\b([^>]*)>/g;
    let match: RegExpExecArray | null;
    while ((match = controlRegex.exec(template))) {
      const element = match[1];
      const attrs = match[2];
      const label =
        this.matchTemplateAttr(attrs, "aria-label") ??
        this.matchTemplateAttr(attrs, "placeholder");
      formFields.push(
        this.buildFormField({
          element,
          inputType: this.matchTemplateAttr(attrs, "type"),
          name: this.matchTemplateAttr(attrs, "name"),
          id: this.matchTemplateAttr(attrs, "id"),
          testId: this.matchTemplateAttr(attrs, "data-testid"),
          label,
        })
      );
    }

    return { testIds, formFields };
  }

  // ========== Store Detection (Pinia / Zustand / Redux Toolkit) ==========

  /** Is this initializer a Zustand `create(...)` or curried `create<T>()(...)`? */
  private isZustandCreate(init: ts.Expression): boolean {
    if (!ts.isCallExpression(init)) return false;
    // create(...)
    if (ts.isIdentifier(init.expression) && init.expression.text === "create") return true;
    // create<T>()(...) — the callee is itself a `create<T>()` call.
    if (
      ts.isCallExpression(init.expression) &&
      ts.isIdentifier(init.expression.expression) &&
      init.expression.expression.text === "create"
    ) {
      return true;
    }
    return false;
  }

  /** True when this variable declaration sits in an `export const ...` statement. */
  private isExportedVariableDecl(node: ts.VariableDeclaration): boolean {
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
  private extractStoreName(sourceFile: ts.SourceFile): string | undefined {
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
        this.isZustandCreate(node.initializer) &&
        this.isExportedVariableDecl(node)
      ) {
        storeName = node.name.text;
        return;
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return storeName;
  }

  // ========== PHI Compliance Helpers ==========

  private findZeroValuedProperties(
    callNode: ts.CallExpression,
    sourceFile: ts.SourceFile,
    propNames: string[]
  ): Set<string> {
    const found = new Set<string>();
    for (const arg of callNode.arguments) {
      if (!ts.isObjectLiteralExpression(arg)) continue;
      for (const prop of arg.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
        if (propNames.includes(prop.name.text) && prop.initializer.getText(sourceFile) === "0") {
          found.add(prop.name.text);
        }
      }
    }
    return found;
  }

  private isConsoleCall(node: ts.Node): boolean {
    return (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "console"
    );
  }

  // ========== PHI Compliance (AST-based) ==========

  private checkPhiComplianceAST(sourceFile: ts.SourceFile, content: string): PhiComplianceInfo {
    const violations: string[] = [];
    let hasUseQuery = false;
    let hasZeroCacheTime = false;
    let hasZeroStaleTime = false;
    let hasConsoleLogNearPhi = false;
    let hasLocalStorageUsage = false;
    let hasSessionStorageUsage = false;

    const visit = (node: ts.Node) => {
      // Detect useQuery calls and check their options
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useQuery") {
        hasUseQuery = true;
        const zeroPropNames = this.findZeroValuedProperties(node, sourceFile, ["gcTime", "staleTime"]);
        if (zeroPropNames.has("gcTime")) hasZeroCacheTime = true;
        if (zeroPropNames.has("staleTime")) hasZeroStaleTime = true;
      }

      // Detect console.log with PHI-related variables
      if (this.isConsoleCall(node)) {
        const argsText = (node as ts.CallExpression).arguments.map((a) => a.getText(sourceFile).toLowerCase()).join(" ");
        if (/patient|phi|mrn|ssn|dob/.test(argsText)) {
          hasConsoleLogNearPhi = true;
        }
      }

      // Detect localStorage/sessionStorage usage
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        if (node.expression.text === "localStorage") hasLocalStorageUsage = true;
        if (node.expression.text === "sessionStorage") hasSessionStorageUsage = true;
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    if (hasUseQuery && !hasZeroCacheTime) {
      violations.push("useQuery without gcTime: 0 - PHI may be cached");
    }
    if (hasUseQuery && !hasZeroStaleTime) {
      violations.push("useQuery without staleTime: 0 - PHI may be stale-cached");
    }
    if (hasConsoleLogNearPhi) {
      violations.push("console.log may contain PHI data");
    }
    if (hasLocalStorageUsage) {
      violations.push("localStorage usage detected - PHI must not be stored in localStorage");
    }
    if (hasSessionStorageUsage) {
      violations.push("sessionStorage usage detected - PHI must not be stored in sessionStorage");
    }

    return {
      hasZeroCacheTime: hasZeroCacheTime || !hasUseQuery,
      hasZeroStaleTime: hasZeroStaleTime || !hasUseQuery,
      hasConsoleLogNearPhi,
      hasLocalStorageUsage,
      hasSessionStorageUsage,
      violations,
    };
  }

  // ========== Vue Template Analysis (regex-based) ==========

  private static VUE_BUILTINS = new Set([
    "Teleport", "Transition", "TransitionGroup", "KeepAlive", "Suspense",
    "Component", "Slot",
  ]);

  private analyzeVueTemplate(fullContent: string): {
    childComponents: string[];
    eventHandlers: string[];
  } {
    const templateMatch = fullContent.match(/<template\b[^>]*>([\s\S]*?)<\/template>/);
    if (!templateMatch) return { childComponents: [], eventHandlers: [] };
    const template = templateMatch[1];

    // PascalCase component usages: <ComponentName or <ComponentName>
    const childComponents = new Set<string>();
    const componentRegex = /<([A-Z][A-Za-z0-9]+)[\s/>]/g;
    let match;
    while ((match = componentRegex.exec(template))) {
      if (!ComponentAnalyzer.VUE_BUILTINS.has(match[1])) {
        childComponents.add(match[1]);
      }
    }

    // Event handlers: @eventName="..." or v-on:eventName="..."
    const eventHandlers = new Set<string>();
    const eventRegex = /(?:@|v-on:)([\w:.]+)/g;
    while ((match = eventRegex.exec(template))) {
      eventHandlers.add(match[1]);
    }

    return {
      childComponents: Array.from(childComponents).sort(),
      eventHandlers: Array.from(eventHandlers).sort(),
    };
  }

  // ========== Vue Emit Extraction (AST-based) ==========

  private extractVueEmits(sourceFile: ts.SourceFile): string[] {
    const emits: string[] = [];

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineEmits") {
        // Pattern 1: defineEmits<{ (e: "name", val: T): void }>()
        if (node.typeArguments?.[0] && ts.isTypeLiteralNode(node.typeArguments[0])) {
          for (const member of node.typeArguments[0].members) {
            // Call signature: (e: "name", ...): void
            if (ts.isCallSignatureDeclaration(member) && member.parameters.length > 0) {
              const firstParam = member.parameters[0];
              if (firstParam.type && ts.isLiteralTypeNode(firstParam.type) && ts.isStringLiteral(firstParam.type.literal)) {
                emits.push(firstParam.type.literal.text);
              }
            }
          }
        }
        // Pattern 2: defineEmits(["name1", "name2"])
        if (node.arguments[0] && ts.isArrayLiteralExpression(node.arguments[0])) {
          for (const el of node.arguments[0].elements) {
            if (ts.isStringLiteral(el)) {
              emits.push(el.text);
            }
          }
        }
      }

      // Options API: emits: ["update:modelValue", "close"]
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "emits" &&
        ts.isArrayLiteralExpression(node.initializer)
      ) {
        for (const el of node.initializer.elements) {
          if (ts.isStringLiteral(el)) emits.push(el.text);
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return [...new Set(emits)].sort();
  }

  // ========== Vue Emit Liveness (declared vs. actually fired) ==========

  /**
   * Split DECLARED emits from ones with a real fire site. An event declared but
   * never `emit()`-ed is dead plumbing; one `$emit`-ed but never declared would
   * warn at runtime. Script call sites come from the AST; template call sites
   * (`@click="$emit('x')"`) are scanned from the raw <template>, which isn't in
   * the script AST. A dynamic `emit(someVar)` makes deadness unprovable, so we
   * suppress the dead list rather than report false positives.
   */
  private extractEmitLiveness(
    sourceFile: ts.SourceFile,
    rawContent: string,
    declared: string[]
  ): { fired: string[]; dead: string[]; undeclared: string[]; dynamic: boolean } {
    // Identify the identifier bound to defineEmits (usually `emit`), so emit('x')
    // calls are recognisable. `$emit` (Options API / template) always counts.
    const emitVars = new Set<string>();
    const findEmitVar = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === "defineEmits" &&
        ts.isIdentifier(node.name)
      ) {
        emitVars.add(node.name.text);
      }
      ts.forEachChild(node, findEmitVar);
    };
    findEmitVar(sourceFile);

    const fired = new Set<string>();
    let dynamic = false;
    const recordFirstArg = (call: ts.CallExpression) => {
      const arg = call.arguments[0];
      if (!arg) return;
      if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) fired.add(arg.text);
      else dynamic = true; // emit(variable) — which event fires is unknowable statically
    };

    // Script call sites: emit('x', ...) and *.$emit('x', ...).
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isIdentifier(callee) && emitVars.has(callee.text)) recordFirstArg(node);
        else if (ts.isPropertyAccessExpression(callee) && callee.name.text === "$emit") recordFirstArg(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    // Template call sites (not in the script AST): $emit('x') or emit('x').
    const templateMatch = rawContent.match(/<template\b[^>]*>([\s\S]*?)<\/template>/);
    if (templateMatch) {
      const nameGroup = [...emitVars, "\\$emit"].join("|");
      const re = new RegExp(`(?:${nameGroup})\\(\\s*['"\`]([\\w:-]+)['"\`]`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(templateMatch[1]))) fired.add(m[1]);
    }

    const declaredSet = new Set(declared);
    return {
      fired: declared.filter((e) => fired.has(e)).sort(),
      dead: dynamic ? [] : declared.filter((e) => !fired.has(e)).sort(),
      undeclared: declared.length ? [...fired].filter((e) => !declaredSet.has(e)).sort() : [],
      dynamic,
    };
  }

  /**
   * For each child component the template renders, collect the events the parent
   * listens for on it (`@event` / `v-on:event`, modifiers stripped). Attribute-
   * level regex, in the same spirit as analyzeVueTemplate — precise enough to
   * cross-check against the child's real emits without a full template parser.
   */
  private extractChildEventBindings(fullContent: string): ChildEventBinding[] {
    const templateMatch = fullContent.match(/<template\b[^>]*>([\s\S]*?)<\/template>/);
    if (!templateMatch) return [];
    const template = templateMatch[1];

    // Opening tags of PascalCase components, capturing the attribute blob.
    const tagRegex = /<([A-Z][A-Za-z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/g;
    const byComponent = new Map<string, Set<string>>();
    let tag: RegExpExecArray | null;
    while ((tag = tagRegex.exec(template))) {
      const name = tag[1];
      if (ComponentAnalyzer.VUE_BUILTINS.has(name)) continue;
      const attrs = tag[2] || "";
      // @event="..." or v-on:event="..." — event name only, up to a modifier dot.
      const evRegex = /(?:@|v-on:)([A-Za-z][\w-]*)/g;
      let ev: RegExpExecArray | null;
      while ((ev = evRegex.exec(attrs))) {
        const set = byComponent.get(name) ?? new Set<string>();
        set.add(ev[1]);
        byComponent.set(name, set);
      }
    }

    return [...byComponent.entries()]
      .map(([component, events]) => ({ component, events: [...events].sort() }))
      .sort((a, b) => a.component.localeCompare(b.component));
  }

  // ========== Vue Template Patterns (overlay / teleport / z-index / header) ==========

  /**
   * Surface the template-layer design signals an overlay/modal drift audit needs:
   * overlay/backdrop elements (and whether a backdrop click handler is bound with
   * the correct `.self` modifier), Teleport usage + target, z-index values (style
   * blocks, inline, and utility classes), and header/heading structure. Regex,
   * consistent with the other template analyzers — the rubric is flat per-element
   * / per-file checks, so no template AST is needed (see FUTURE ticket to revisit
   * with @vue/compiler-sfc). Returns undefined when nothing was found.
   */
  private analyzeVueTemplatePatterns(rawContent: string): TemplatePatterns | undefined {
    const tplOpen = rawContent.match(/<template\b[^>]*>/);
    if (!tplOpen || tplOpen.index === undefined) return undefined;
    const tplStart = tplOpen.index + tplOpen[0].length;
    const tplEnd = rawContent.indexOf("</template>", tplStart);
    // Blank out comments (preserving length/offsets) so commented-out markup
    // never produces a finding.
    const template = rawContent
      .slice(tplStart, tplEnd === -1 ? rawContent.length : tplEnd)
      .replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, " "));

    const cfg = this.config?.templatePatterns;
    const overlayClasses = ["overlay", "backdrop", "scrim", "modal-mask", ...(cfg?.overlayClasses ?? [])].map((s) => s.toLowerCase());
    const overlayComponents = ["*Overlay", "*Backdrop", ...(cfg?.overlayComponents ?? [])];
    const headerClasses = ["header", "modal-header", "dialog-header", "card-header", "drawer-header", ...(cfg?.headerClasses ?? [])].map((s) => s.toLowerCase());

    // --- Teleport: targets/disabled from every open tag; inner ranges (paired) for containment ---
    const teleportTargets = new Set<string>();
    let teleportDisabled = false;
    let teleportCount = 0;
    const teleOpenRe = /<[Tt]eleport\b([^>]*?)\/?>/g;
    let tOpen: RegExpExecArray | null;
    while ((tOpen = teleOpenRe.exec(template))) {
      teleportCount++;
      const attrs = tOpen[1] || "";
      const to = attrs.match(/(?::|v-bind:)?to\s*=\s*(["'])(.*?)\1/);
      if (to) teleportTargets.add(to[2]);
      if (/(?::|v-bind:)disabled\b/.test(attrs)) teleportDisabled = true;
    }
    const teleportRanges: Array<[number, number]> = [];
    const telePairRe = /<[Tt]eleport\b[^>]*>([\s\S]*?)<\/[Tt]eleport>/g;
    let tPair: RegExpExecArray | null;
    while ((tPair = telePairRe.exec(template))) {
      const innerStart = tPair.index + tPair[0].indexOf(">") + 1;
      teleportRanges.push([innerStart, innerStart + tPair[1].length]);
    }

    // --- Elements: overlays + header regions ---
    const overlays: OverlayPattern[] = [];
    const headerRegions = new Set<string>();
    const tagRe = /<([a-zA-Z][\w.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)\/?>/g;
    let el: RegExpExecArray | null;
    while ((el = tagRe.exec(template))) {
      const tag = el[1];
      const attrs = el[2] || "";
      const tokens = this.classTokens(attrs).map((t) => t.toLowerCase());
      for (const t of tokens) if (headerClasses.some((h) => t.includes(h))) headerRegions.add(t);

      let source: OverlayPattern["source"] | null = null;
      const matched: string[] = [];
      for (const t of tokens) if (overlayClasses.some((o) => t.includes(o))) { matched.push(t); source = "class"; }
      if (!source && this.isUtilityOverlay(tokens)) {
        source = "utility";
        matched.push(...tokens.filter((t) => /^(fixed|inset-0|bg-black|bg-opacity|backdrop-blur)/.test(t)));
      }
      if (!source && /^[A-Z]/.test(tag) && overlayComponents.some((g) => this.globMatch(g, tag))) source = "component";
      if (!source) continue;

      const clickHandler = this.extractClickBinding(attrs);
      const viaTeleport = teleportRanges.some(([a, b]) => el!.index >= a && el!.index <= b);
      overlays.push({
        tag,
        classes: [...new Set(matched)].sort(),
        source,
        ...(clickHandler ? { clickHandler } : {}),
        ...(viaTeleport ? { viaTeleport: true } : {}),
        line: this.lineAt(rawContent, tplStart + el.index),
      });
    }

    // --- Headings + <header> ---
    const headings: HeadingInfo[] = [];
    const hRe = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
    let h: RegExpExecArray | null;
    while ((h = hRe.exec(template))) {
      const text = h[2].replace(/<[^>]*>/g, "").replace(/\{\{[\s\S]*?\}\}/g, "").replace(/\s+/g, " ").trim();
      headings.push({ level: parseInt(h[1], 10), ...(text ? { text: text.slice(0, 120) } : {}) });
    }
    const hasHeaderElement = /<header\b/i.test(template);

    // --- z-index: style blocks, inline styles, utility classes ---
    const zIndexes: ZIndexRef[] = [];
    const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
    let st: RegExpExecArray | null;
    while ((st = styleRe.exec(rawContent))) {
      const css = st[1];
      const cssOffset = st.index + st[0].indexOf(">") + 1;
      const zRe = /z-index\s*:\s*([^;}\n]+)/gi;
      let z: RegExpExecArray | null;
      while ((z = zRe.exec(css))) {
        zIndexes.push(this.zref(z[1], "style", this.lineAt(rawContent, cssOffset + z.index), this.selectorBefore(css, z.index)));
      }
    }
    // Plain static style="..." — lookbehind excludes :style / v-bind:style.
    const inlineRe = /(?<![\w:-])style\s*=\s*(["'])([\s\S]*?)\1/gi;
    let inl: RegExpExecArray | null;
    while ((inl = inlineRe.exec(template))) {
      const zm = inl[2].match(/z-?index\s*:\s*([^;'"}]+)/i);
      if (zm) zIndexes.push(this.zref(zm[1], "inline", this.lineAt(rawContent, tplStart + inl.index)));
    }
    // Bound :style="{ zIndex: 999 }" — object-literal form.
    const bindStyleRe = /(?::|v-bind:)style\s*=\s*(["'])([\s\S]*?)\1/gi;
    while ((inl = bindStyleRe.exec(template))) {
      const zm = inl[2].match(/(?:z-?index|['"]z-index['"])\s*:\s*['"]?([\w.-]+)/i);
      if (zm) zIndexes.push(this.zref(zm[1], "inline", this.lineAt(rawContent, tplStart + inl.index)));
    }
    const utilRe = /\bz-(\[[^\]]+\]|\d+)\b/g;
    let u: RegExpExecArray | null;
    while ((u = utilRe.exec(template))) {
      const raw = u[1].startsWith("[") ? u[1].slice(1, -1) : u[1];
      zIndexes.push(this.zref(raw, "utility", this.lineAt(rawContent, tplStart + u.index)));
    }
    const zSeen = new Set<string>();
    const zDedup = zIndexes.filter((z) => {
      const k = `${z.value}|${z.where}|${z.selector ?? ""}`;
      return zSeen.has(k) ? false : (zSeen.add(k), true);
    });

    const result: TemplatePatterns = {};
    if (overlays.length) result.overlays = overlays;
    if (teleportCount > 0) {
      result.teleport = {
        present: true,
        targets: [...teleportTargets].sort(),
        count: teleportCount,
        ...(teleportDisabled ? { disabledBinding: true } : {}),
      };
    }
    if (zDedup.length) result.zIndexes = zDedup;
    if (headings.length) result.headings = headings;
    if (hasHeaderElement) result.hasHeaderElement = true;
    if (headerRegions.size) result.headerRegions = [...headerRegions].sort();
    return Object.keys(result).length ? result : undefined;
  }

  /** Class tokens from static `class="..."` and literal tokens/keys in `:class`. */
  private classTokens(attrs: string): string[] {
    const tokens: string[] = [];
    let m: RegExpExecArray | null;
    const staticRe = /\bclass\s*=\s*(["'])([\s\S]*?)\1/g;
    while ((m = staticRe.exec(attrs))) tokens.push(...m[2].split(/\s+/));
    const bindRe = /(?::|v-bind:)class\s*=\s*(["'])([\s\S]*?)\1/g;
    while ((m = bindRe.exec(attrs))) {
      const expr = m[2];
      let s: RegExpExecArray | null;
      const strRe = /['"]([\w:-]+)['"]/g;
      while ((s = strRe.exec(expr))) tokens.push(s[1]);
      const keyRe = /([\w-]+)\s*:/g;
      while ((s = keyRe.exec(expr))) tokens.push(s[1]);
    }
    return tokens.filter(Boolean);
  }

  /** Tailwind-style positional overlay: full-viewport fixed element with a dim background. */
  private isUtilityOverlay(tokens: string[]): boolean {
    const has = (re: RegExp) => tokens.some((t) => re.test(t));
    const fixedFull = has(/^fixed$/) && (has(/^inset-0$/) || (has(/^top-0$/) && has(/^left-0$/)));
    const dim = has(/^bg-black/) || has(/^bg-opacity/) || has(/^backdrop-blur/) || has(/^bg-gray-9\d\d\//);
    return fixedFull && dim;
  }

  /** Parse a click binding (@click / v-on:click) with its modifiers and handler expression. */
  private extractClickBinding(attrs: string): { bound: true; modifiers: string[]; expression: string } | undefined {
    const withValue = attrs.match(/(?:@|v-on:)click((?:\.\w+)*)\s*=\s*(["'])([\s\S]*?)\2/);
    if (withValue) {
      return { bound: true, modifiers: withValue[1] ? withValue[1].slice(1).split(".").filter(Boolean) : [], expression: withValue[3].trim() };
    }
    const bare = attrs.match(/(?:@|v-on:)click((?:\.\w+)*)(?=[\s/>]|$)/);
    if (bare) return { bound: true, modifiers: bare[1] ? bare[1].slice(1).split(".").filter(Boolean) : [], expression: "" };
    return undefined;
  }

  /** Simple `*` glob match, anchored. */
  private globMatch(glob: string, name: string): boolean {
    const re = new RegExp("^" + glob.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
    return re.test(name);
  }

  /** Best-effort CSS selector for a declaration at `pos` — the text before its `{`. */
  private selectorBefore(css: string, pos: number): string | undefined {
    const openIdx = css.lastIndexOf("{", pos);
    if (openIdx === -1) return undefined;
    const prev = Math.max(css.lastIndexOf("}", openIdx), css.lastIndexOf("{", openIdx - 1));
    const sel = css.slice(prev + 1, openIdx).trim().replace(/\s+/g, " ");
    return sel ? sel.slice(0, 80) : undefined;
  }

  private zref(raw: string, where: ZIndexRef["where"], line: number, selector?: string): ZIndexRef {
    const value = raw.trim();
    const ref: ZIndexRef = { value, where, line };
    if (/^-?\d+$/.test(value)) ref.numeric = parseInt(value, 10);
    if (selector) ref.selector = selector;
    return ref;
  }

  /** 1-based line number of an absolute offset in the file. */
  private lineAt(content: string, index: number): number {
    let line = 1;
    for (let i = 0; i < index && i < content.length; i++) if (content[i] === "\n") line++;
    return line;
  }

  // ========== Accessibility (keep regex — fine for HTML attribute scanning) ==========

  private uniqueSortedMatches(content: string, regex: RegExp, transform: (m: RegExpMatchArray) => string): string[] {
    return Array.from(new Set(Array.from(content.matchAll(regex)).map(transform))).sort();
  }

  private extractAccessibility(content: string) {
    const ariaAttributes = this.uniqueSortedMatches(content, /aria-(\w+)=/g, (m) => `aria-${m[1]}`);
    const roles = this.uniqueSortedMatches(content, /role="([^"]+)"/g, (m) => m[1]);

    const semanticTags = [
      "nav", "main", "section", "article", "aside",
      "header", "footer", "button", "form", "label",
      "fieldset", "legend",
    ];
    const semanticElements = semanticTags
      .filter((tag) => new RegExp(`<${tag}[\\s>]`, "gi").test(content))
      .sort();

    const keyboardChecks: [string, string][] = [
      ["onKeyDown", "onKeyDown"], ["onKeyPress", "onKeyPress"],
      ["onKeyUp", "onKeyUp"], ["tabIndex", "tabIndex="],
    ];
    const keyboardHandlers = keyboardChecks
      .filter(([, search]) => content.includes(search))
      .map(([name]) => name)
      .sort();

    const hasTestId = /data-testid=/.test(content);
    const hasScreenReaderSupport =
      /sr-only|visually-hidden|screen-reader/i.test(content) ||
      ariaAttributes.some(
        (attr) => attr.includes("aria-label") || attr.includes("aria-describedby")
      );

    return {
      ariaAttributes,
      roles,
      semanticElements,
      keyboardHandlers,
      hasTestId,
      hasScreenReaderSupport,
    };
  }

  // Keep extractImports as a public method for backward compatibility
  extractImports(content: string, filePath?: string): ImportInfo[] {
    const sourceFile = ts.createSourceFile(
      filePath || "temp.ts",
      content,
      ts.ScriptTarget.Latest,
      true
    );

    const imports: ImportInfo[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node)) {
        const imp = this.extractImportFromNode(node, filePath);
        if (imp) imports.push(imp);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return imports;
  }
}
