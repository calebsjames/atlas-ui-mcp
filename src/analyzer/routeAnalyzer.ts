import fs from "fs/promises";
import path from "path";
import ts from "typescript";
import type { RouteEntry, ProjectConfig } from "../types.js";
import { analyzeFileRoutes } from "./fileRoutes.js";
import { dedupeRoutes, extractDynamicSegments } from "./routeUtils.js";

const PROTECTION_PATTERN = /RequireAuth|ProtectedRoute|AuthGuard/;
const PROTECTION_WRAPPERS = ["RequireAuth", "ProtectedRoute", "AuthGuard"];
const ROUTER_FUNCTIONS = new Set([
  "useRoutes", "createBrowserRouter", "createRoutesFromElements", // React Router
  "createRouter", // Vue Router
]);
const ROUTE_TYPE_NAMES = ["RouteObject", "RouteRecordRaw"];

/** Context threaded through object-route parsing for static value resolution. */
interface RouteParseCtx {
  /** In-scope const names (local + one level of imported consts) → initializer. */
  constScope: Map<string, ts.Expression>;
  /** Import specifier → workspace-relative extensionless module path (or undefined). */
  resolveComponentPath: (importSpecifier: string) => string | undefined;
}

/** Strip `as const` / `satisfies` / parens so the real literal shows through. */
function unwrapExpr(node: ts.Expression): ts.Expression {
  let cur: ts.Expression = node;
  while (
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isParenthesizedExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/** A string/plain-template literal's text, or undefined. */
function literalString(node: ts.Expression): string | undefined {
  const e = unwrapExpr(node);
  return ts.isStringLiteralLike(e) ? e.text : undefined;
}

/** Drop a trailing module extension so paths key the same as catalog lookups. */
function stripModuleExt(p: string): string {
  return p.replace(/\.(vue|tsx|ts|jsx|js|mjs)$/, "");
}

/** Whether a statement carries an `export` modifier. */
function hasExportModifier(node: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

/**
 * Walk `base.a.b` through object-literal constants, returning the expression the
 * chain lands on (undefined if any hop isn't a statically-known object member).
 */
function resolveMemberChain(base: ts.Expression, props: string[]): ts.Expression | undefined {
  let cur = unwrapExpr(base);
  for (const prop of props) {
    if (!ts.isObjectLiteralExpression(cur)) return undefined;
    const match = cur.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) &&
        (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
        p.name.text === prop
    );
    if (!match) return undefined;
    cur = unwrapExpr(match.initializer);
  }
  return cur;
}

/**
 * Best-effort static evaluation of a route `path` expression to a string:
 * a string literal, an identifier bound to a string const, or a property chain
 * into a const object (`paths.app.discussions.path`). `scope` maps in-scope
 * const names to their initializers. Returns undefined when it can't be
 * resolved — callers then behave exactly as they did for a non-literal path.
 */
function evalPathExpression(
  node: ts.Expression,
  scope: Map<string, ts.Expression>
): string | undefined {
  const e = unwrapExpr(node);

  const direct = literalString(e);
  if (direct !== undefined) return direct;

  if (ts.isIdentifier(e)) {
    const bound = scope.get(e.text);
    return bound ? literalString(bound) : undefined;
  }

  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    const props: string[] = [];
    let cur: ts.Expression = e;
    while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
      if (ts.isPropertyAccessExpression(cur)) {
        props.unshift(cur.name.text);
      } else {
        const key = cur.argumentExpression && literalString(cur.argumentExpression);
        if (key === undefined) return undefined;
        props.unshift(key);
      }
      cur = cur.expression;
    }
    if (!ts.isIdentifier(cur)) return undefined;
    const base = scope.get(cur.text);
    if (!base) return undefined;
    const landed = resolveMemberChain(base, props);
    return landed ? literalString(landed) : undefined;
  }

  return undefined;
}

/** The `import('x')` specifier inside a `lazy: () => import('x')...` initializer. */
function extractLazyImportSpecifier(node: ts.Expression): string | undefined {
  let found: string | undefined;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword &&
      n.arguments[0] &&
      ts.isStringLiteralLike(n.arguments[0])
    ) {
      found = n.arguments[0].text;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * Route Analyzer - AST-Based
 * Parses React Router route definitions from multiple files
 * Supports nested routes, dynamic segments, useRoutes(), and layout routes
 */
export class RouteAnalyzer {
  private workspaceRoot: string;
  private routeFiles: string[];
  private config?: ProjectConfig;
  /** Parsed exported-const maps per imported module file, memoized across route files. */
  private moduleConstCache = new Map<string, Map<string, ts.Expression>>();

  constructor(workspaceRoot: string, config?: ProjectConfig) {
    this.workspaceRoot = workspaceRoot;
    this.routeFiles = config?.routeFiles || ["src/App.tsx"];
    this.config = config;
  }

  /**
   * Constants visible when evaluating a route file's `path` expressions: its own
   * top-level `const`s plus one level of imported consts (so a centralized
   * `paths`/`ROUTES` object in another module resolves). Local consts win over
   * imports on a name clash.
   */
  private async buildConstantScope(
    sourceFile: ts.SourceFile,
    routeFileAbs: string
  ): Promise<Map<string, ts.Expression>> {
    const scope = new Map<string, ts.Expression>();

    for (const stmt of sourceFile.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          scope.set(decl.name.text, decl.initializer);
        }
      }
    }

    for (const stmt of sourceFile.statements) {
      if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
      if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const file = await this.resolveModuleFile(stmt.moduleSpecifier.text, routeFileAbs);
      if (!file) continue;
      const exports = await this.getModuleConsts(file);
      if (!exports) continue;

      const clause = stmt.importClause;
      if (clause.name) {
        const def = exports.get("default");
        if (def && !scope.has(clause.name.text)) scope.set(clause.name.text, def);
      }
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          const imported = (el.propertyName ?? el.name).text;
          const local = el.name.text;
          const init = exports.get(imported);
          if (init && !scope.has(local)) scope.set(local, init);
        }
      }
    }

    return scope;
  }

  /** Exported `const NAME = …` initializers (+ `default`) of a module file, memoized. */
  private async getModuleConsts(
    fileAbs: string
  ): Promise<Map<string, ts.Expression> | undefined> {
    const cached = this.moduleConstCache.get(fileAbs);
    if (cached) return cached;

    let content: string;
    try {
      content = await fs.readFile(fileAbs, "utf-8");
    } catch {
      return undefined;
    }
    const sf = ts.createSourceFile(
      fileAbs, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX
    );
    const map = new Map<string, ts.Expression>();
    for (const stmt of sf.statements) {
      if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer) {
            map.set(decl.name.text, decl.initializer);
          }
        }
      } else if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
        map.set("default", stmt.expression);
      }
    }
    this.moduleConstCache.set(fileAbs, map);
    return map;
  }

  /** Resolve an import specifier to an on-disk module file, trying common extensions. */
  private async resolveModuleFile(
    spec: string,
    fromFileAbs: string
  ): Promise<string | undefined> {
    const base = this.moduleBase(spec, fromFileAbs);
    if (!base) return undefined;
    const absBase = path.join(this.workspaceRoot, base);
    const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs"];
    const candidates = [
      ...exts.map((e) => `${absBase}${e}`),
      ...exts.map((e) => path.join(absBase, `index${e}`)),
    ];
    for (const c of candidates) {
      try {
        await fs.access(c);
        return c;
      } catch {
        // keep trying
      }
    }
    return undefined;
  }

  /**
   * Import specifier → workspace-relative, extensionless module path, honoring
   * configured aliases and relative imports. Bare (node_modules) specifiers and
   * paths escaping the workspace return undefined.
   */
  private moduleBase(spec: string, fromFileAbs: string): string | undefined {
    if (this.config?.aliases) {
      for (const [alias, target] of Object.entries(this.config.aliases)) {
        if (spec.startsWith(alias)) return stripModuleExt(target + spec.slice(alias.length));
      }
    }
    if (spec.startsWith("@/")) return stripModuleExt(`src/${spec.slice(2)}`);
    if (spec.startsWith(".")) {
      const abs = path.resolve(path.dirname(fromFileAbs), spec);
      const rel = path.relative(this.workspaceRoot, abs);
      if (rel.startsWith("..")) return undefined;
      return stripModuleExt(rel.split(path.sep).join("/"));
    }
    return undefined;
  }

  /**
   * Parse route definitions from all configured route files
   */
  async analyzeRoutes(): Promise<RouteEntry[]> {
    const allRoutes: RouteEntry[] = [];

    for (const routeFile of this.routeFiles) {
      const filePath = path.join(this.workspaceRoot, routeFile);
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const sourceFile = ts.createSourceFile(
          filePath,
          content,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TSX
        );

        const ctx: RouteParseCtx = {
          constScope: await this.buildConstantScope(sourceFile, filePath),
          resolveComponentPath: (spec) => this.moduleBase(spec, filePath),
        };
        const fileRoutes = [
          ...this.extractJSXRoutes(sourceFile),
          ...this.extractObjectRoutes(sourceFile, ctx),
        ];
        this.applyGlobalGuards(sourceFile, content, fileRoutes);
        allRoutes.push(...fileRoutes);
      } catch {
        // File doesn't exist or can't be read, skip
      }
    }

    // Merge in file-based routes (Next App/Pages Router, Nuxt pages) so
    // config-less frameworks still produce a route map. Dedupe by path +
    // component; configured routes come first, so they win.
    return dedupeRoutes([...allRoutes, ...(await analyzeFileRoutes(this.workspaceRoot))]);
  }

  private buildFullPath(routePath: string | undefined, isIndex: boolean, parentPath: string): string {
    if (isIndex) return parentPath || "/";
    if (!routePath) return parentPath;
    if (routePath.startsWith("/")) return routePath;
    const base = parentPath === "/" ? "" : parentPath;
    return `${base}/${routePath}`;
  }

  private buildRouteEntry(
    fullPath: string,
    elementText: string,
    parentProtected: boolean | undefined,
    parentLayout: string | undefined,
    componentPath?: string
  ): RouteEntry {
    const wrapperProtected = PROTECTION_PATTERN.test(elementText);
    const isProtected = parentProtected || wrapperProtected;
    const component = this.extractComponentFromElement(elementText);
    const dynamicSegments = extractDynamicSegments(fullPath);

    return {
      path: fullPath,
      component: component || "Unknown",
      ...(componentPath ? { componentPath } : {}),
      isProtected,
      ...(wrapperProtected ? { protection: "wrapper" as const } : {}),
      parentLayout,
      isDynamic: dynamicSegments.length > 0,
      dynamicSegments: dynamicSegments.length > 0 ? dynamicSegments : undefined,
    };
  }

  /**
   * Detect a GLOBAL navigation guard (router.beforeEach) and, when possible,
   * statically recover which routes it protects.
   *
   * Many apps protect routes centrally — e.g. a `PROTECTED_PREFIXES` array of
   * path prefixes checked inside `beforeEach` — leaving per-route `meta` empty.
   * Route-meta-only analysis then reports every route as unprotected, which is
   * confidently wrong. Strategy:
   *   1. No `.beforeEach(` in the file: nothing to do.
   *   2. `.beforeEach(` present AND a const array of string literals whose
   *      name matches /protect/i exists: mark routes matching those prefixes
   *      (`path === prefix || path.startsWith(prefix + "/")`) as protected
   *      with protection: "global-guard-prefix".
   *   3. `.beforeEach(` present but no parsable prefix list: tag unprotected
   *      routes with protection: "unknown" so consumers report honestly
   *      instead of asserting false.
   */
  private applyGlobalGuards(
    sourceFile: ts.SourceFile,
    content: string,
    routes: RouteEntry[]
  ): void {
    if (!/\.beforeEach\s*\(/.test(content)) return;

    const prefixes = this.extractProtectedPrefixes(sourceFile);

    if (prefixes.length === 0) {
      for (const route of routes) {
        if (!route.isProtected && !route.protection) {
          route.protection = "unknown";
        }
      }
      return;
    }

    for (const route of routes) {
      const matched = prefixes.some(
        (prefix) =>
          route.path === prefix ||
          route.path.startsWith(prefix.endsWith("/") ? prefix : prefix + "/")
      );
      if (matched && !route.isProtected) {
        route.isProtected = true;
        route.protection = "global-guard-prefix";
      }
    }
  }

  /**
   * Find const arrays of string literals whose variable name suggests route
   * protection (PROTECTED_PREFIXES, protectedRoutes, authProtectedPaths, ...).
   */
  private extractProtectedPrefixes(sourceFile: ts.SourceFile): string[] {
    const prefixes: string[] = [];

    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        /protect/i.test(node.name.text) &&
        node.initializer &&
        ts.isArrayLiteralExpression(node.initializer)
      ) {
        for (const element of node.initializer.elements) {
          if (ts.isStringLiteral(element) && element.text.startsWith("/")) {
            prefixes.push(element.text);
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return prefixes;
  }

  /**
   * Extract routes from JSX <Route> elements (supports nesting)
   */
  private extractJSXRoutes(sourceFile: ts.SourceFile): RouteEntry[] {
    const routes: RouteEntry[] = [];

    const visitJsx = (node: ts.Node, parentPath: string, parentLayout?: string, parentProtected?: boolean) => {
      const el =
        ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) ? node : undefined;
      if (!el || !this.looksLikeRoute(el, sourceFile)) {
        ts.forEachChild(node, (child) => visitJsx(child, parentPath, parentLayout, parentProtected));
        return;
      }

      const attrs = this.getJsxAttributes(el, sourceFile);
      const routePath = attrs.path;
      let elementContent = attrs.element || "";
      const isIndex = attrs.index !== undefined;
      // React Router v5 renders the page as a CHILD (`<Route path><Home/></Route>`),
      // not an `element` prop — recover it from the first component child.
      if (!elementContent && ts.isJsxOpeningElement(el)) {
        const child = this.firstChildComponent(el, sourceFile);
        if (child) elementContent = `<${child} />`;
      }

      const fullPath = this.buildFullPath(routePath, isIndex, parentPath);
      const route = this.buildRouteEntry(fullPath, elementContent, parentProtected, parentLayout);

      if (routePath !== undefined || isIndex) {
        routes.push(route);
      }

      this.visitJsxChildren(el, fullPath, route.component, route.isProtected, visitJsx);
    };

    visitJsx(sourceFile, "/", undefined, false);
    return dedupeRoutes(routes);
  }

  /**
   * Is this JSX element a route? `<Route>` always; otherwise a custom wrapper
   * (`GuestOnlyRoute`, `PrivateRoute`, …) recognized by a route-shaped `path`
   * attribute — the path value, not the tag name, is the signal, so no app's
   * wrapper names are hardcoded.
   */
  private looksLikeRoute(
    node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
    sourceFile: ts.SourceFile
  ): boolean {
    if (ts.isIdentifier(node.tagName) && node.tagName.text === "Route") return true;
    const p = this.getJsxAttributes(node, sourceFile).path;
    return typeof p === "string" && (p.startsWith("/") || p === "*");
  }

  /**
   * First PascalCase child element that isn't itself a route — the component a
   * v5 `<Route path><Child/></Route>` (or custom wrapper) renders.
   */
  private firstChildComponent(
    node: ts.JsxOpeningElement,
    sourceFile: ts.SourceFile
  ): string | undefined {
    const parent = node.parent;
    if (!ts.isJsxElement(parent)) return undefined;
    for (const child of parent.children) {
      const opening = ts.isJsxElement(child)
        ? child.openingElement
        : ts.isJsxSelfClosingElement(child)
          ? child
          : undefined;
      if (!opening || !ts.isIdentifier(opening.tagName)) continue;
      const tag = opening.tagName.text;
      if (!/^[A-Z]/.test(tag) || tag === "Route") continue;
      if (this.looksLikeRoute(opening, sourceFile)) continue; // a nested route, not the page
      return tag;
    }
    return undefined;
  }

  private isRouteElement(node: ts.Node): node is ts.JsxOpeningElement | ts.JsxSelfClosingElement {
    return (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      node.tagName.text === "Route"
    );
  }

  private visitJsxChildren(
    node: ts.Node,
    fullPath: string,
    component: string,
    isProtected: boolean,
    visitJsx: (node: ts.Node, parentPath: string, parentLayout?: string, parentProtected?: boolean) => void
  ): void {
    if (!ts.isJsxOpeningElement(node)) return;
    const parent = node.parent;
    if (!ts.isJsxElement(parent)) return;

    const layout = component === "Unknown" ? undefined : component;
    const visitChild = (child: ts.Node) => visitJsx(child, fullPath, layout, isProtected);

    for (const child of parent.children) {
      ts.forEachChild(child, visitChild);
      if (ts.isJsxElement(child)) {
        visitJsx(child.openingElement, fullPath, layout, isProtected);
      } else if (ts.isJsxSelfClosingElement(child)) {
        visitJsx(child, fullPath, layout, isProtected);
      }
    }
  }

  /**
   * Extract routes from object-style route definitions (useRoutes / createBrowserRouter)
   */
  private extractObjectRoutes(sourceFile: ts.SourceFile, ctx: RouteParseCtx): RouteEntry[] {
    const routes: RouteEntry[] = [];

    const visit = (node: ts.Node) => {
      // createRouter({ routes: [...] }) — Vue Router
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ROUTER_FUNCTIONS.has(node.expression.text)) {
        const firstArg = node.arguments[0];
        // React Router: useRoutes([...]) / createBrowserRouter([...])
        if (firstArg && ts.isArrayLiteralExpression(firstArg)) {
          this.parseRouteArray(firstArg, sourceFile, ctx, "/", routes);
          return;
        }
        // Vue Router: createRouter({ routes: [...] })
        if (firstArg && ts.isObjectLiteralExpression(firstArg)) {
          for (const prop of firstArg.properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === "routes" &&
              ts.isArrayLiteralExpression(prop.initializer)
            ) {
              this.parseRouteArray(prop.initializer, sourceFile, ctx, "/", routes);
              return;
            }
          }
        }
      }

      // const routes: RouteRecordRaw[] = [...] or const routes: RouteObject[] = [...]
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
        const typeText = node.type?.getText(sourceFile) || "";
        const nameText = ts.isIdentifier(node.name) ? node.name.text : "";
        if (ROUTE_TYPE_NAMES.some((t) => typeText.includes(t)) || nameText.toLowerCase().includes("route")) {
          this.parseRouteArray(node.initializer, sourceFile, ctx, "/", routes);
          return;
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return routes;
  }

  /**
   * Parse an array of route objects: [{ path: "/", element: <Home />, children: [...] }]
   */
  private parseRouteArray(
    array: ts.ArrayLiteralExpression,
    sourceFile: ts.SourceFile,
    ctx: RouteParseCtx,
    parentPath: string,
    routes: RouteEntry[],
    parentProtected?: boolean,
    parentLayout?: string
  ): void {
    for (const element of array.elements) {
      if (!ts.isObjectLiteralExpression(element)) continue;

      const props = this.extractRouteObjectProps(element, sourceFile, ctx);
      const fullPath = this.buildFullPath(props.routePath, props.isIndex, parentPath);
      const isProtected = parentProtected || props.isProtected;
      const route = this.buildRouteEntry(
        fullPath, props.elementText, isProtected, parentLayout, props.componentPath
      );
      if (props.isProtected && !route.protection) {
        route.protection = "route-meta";
      }

      // `!== undefined` (not truthiness) so an index route written as `path: ''`
      // — which resolves to the parent path — is still emitted.
      if (props.routePath !== undefined || props.isIndex) {
        routes.push(route);
      }

      if (props.childrenArray) {
        const layout = route.component === "Unknown" ? parentLayout : route.component;
        this.parseRouteArray(props.childrenArray, sourceFile, ctx, fullPath, routes, route.isProtected, layout);
      }
    }
  }

  private extractRouteObjectProps(
    element: ts.ObjectLiteralExpression,
    sourceFile: ts.SourceFile,
    ctx: RouteParseCtx
  ) {
    let routePath: string | undefined;
    let elementText = "";
    let isIndex = false;
    let isProtected = false;
    let childrenArray: ts.ArrayLiteralExpression | undefined;
    let componentPath: string | undefined;

    for (const prop of element.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;

      const propName = prop.name.text;
      if (propName === "path") {
        // String literals AND const references (paths.app.x.path, ROUTES.y).
        routePath = evalPathExpression(prop.initializer, ctx.constScope);
      } else if (propName === "lazy") {
        // React Router data-router lazy route: `lazy: () => import('./routes/x')`.
        const spec = extractLazyImportSpecifier(prop.initializer);
        if (spec) componentPath = ctx.resolveComponentPath(spec);
      } else if (propName === "element" || propName === "component") {
        // React Router uses "element", Vue Router uses "component"
        elementText = prop.initializer.getText(sourceFile);
      } else if (propName === "index" && prop.initializer.kind === ts.SyntaxKind.TrueKeyword) {
        isIndex = true;
      } else if (propName === "children" && ts.isArrayLiteralExpression(prop.initializer)) {
        childrenArray = prop.initializer;
      } else if (propName === "meta" && ts.isObjectLiteralExpression(prop.initializer)) {
        // Vue Router: meta: { requireAuth: true }
        for (const metaProp of prop.initializer.properties) {
          if (!ts.isPropertyAssignment(metaProp) || !ts.isIdentifier(metaProp.name)) continue;
          const metaName = metaProp.name.text;
          if (
            (metaName === "requireAuth" || metaName === "requiresAuth") &&
            metaProp.initializer.kind === ts.SyntaxKind.TrueKeyword
          ) {
            isProtected = true;
          }
        }
      }
    }

    return { routePath, elementText, isIndex, isProtected, childrenArray, componentPath };
  }

  /**
   * Get JSX attributes as a key-value map
   */
  private getJsxAttributes(
    node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
    sourceFile: ts.SourceFile
  ): Record<string, string> {
    const attrs: Record<string, string> = {};

    for (const prop of node.attributes.properties) {
      if (!ts.isJsxAttribute(prop) || !ts.isIdentifier(prop.name)) continue;

      const name = prop.name.text;
      if (!prop.initializer) {
        attrs[name] = "true";
      } else if (ts.isStringLiteral(prop.initializer)) {
        attrs[name] = prop.initializer.text;
      } else if (ts.isJsxExpression(prop.initializer) && prop.initializer.expression) {
        attrs[name] = prop.initializer.expression.getText(sourceFile);
      }
    }

    return attrs;
  }

  /**
   * Extract component name from JSX element text
   */
  private extractComponentFromElement(elementText: string): string | null {
    // React: protection wrappers like <RequireAuth><Component /></RequireAuth>
    for (const wrapper of PROTECTION_WRAPPERS) {
      const innerMatch = elementText.match(new RegExp(`${wrapper}[\\s\\S]*?<([A-Z][A-Za-z0-9]*)`));
      if (!innerMatch) continue;

      if (innerMatch[1] !== wrapper) return innerMatch[1];

      const secondMatch = elementText.match(new RegExp(`<${wrapper}[\\s\\S]*?<([A-Z][A-Za-z0-9]*)`));
      if (secondMatch && secondMatch[1] !== wrapper) return secondMatch[1];
    }

    // React: <ComponentName />
    const jsxMatch = elementText.match(/<([A-Z][A-Za-z0-9]*)/);
    if (jsxMatch) return jsxMatch[1];

    // Vue: component identifier reference (e.g., "LandingPage" or "HomePage")
    const identMatch = elementText.match(/^([A-Z][A-Za-z0-9]*)$/);
    if (identMatch) return identMatch[1];

    // Vue: lazy import — () => import("@/views/CustomerProfile.vue")
    const lazyMatch = elementText.match(/import\s*\(\s*["'].*?\/([A-Za-z0-9]+)\.vue["']\s*\)/);
    if (lazyMatch) return lazyMatch[1];

    return null;
  }
}
