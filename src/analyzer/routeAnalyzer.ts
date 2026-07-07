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

/**
 * Route Analyzer - AST-Based
 * Parses React Router route definitions from multiple files
 * Supports nested routes, dynamic segments, useRoutes(), and layout routes
 */
export class RouteAnalyzer {
  private workspaceRoot: string;
  private routeFiles: string[];

  constructor(workspaceRoot: string, config?: ProjectConfig) {
    this.workspaceRoot = workspaceRoot;
    this.routeFiles = config?.routeFiles || ["src/App.tsx"];
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

        const fileRoutes = [
          ...this.extractJSXRoutes(sourceFile),
          ...this.extractObjectRoutes(sourceFile),
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
    parentLayout: string | undefined
  ): RouteEntry {
    const wrapperProtected = PROTECTION_PATTERN.test(elementText);
    const isProtected = parentProtected || wrapperProtected;
    const component = this.extractComponentFromElement(elementText);
    const dynamicSegments = extractDynamicSegments(fullPath);

    return {
      path: fullPath,
      component: component || "Unknown",
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
      if (!this.isRouteElement(node)) {
        ts.forEachChild(node, (child) => visitJsx(child, parentPath, parentLayout, parentProtected));
        return;
      }

      const attrs = this.getJsxAttributes(node, sourceFile);
      const routePath = attrs.path;
      const elementContent = attrs.element || "";
      const isIndex = attrs.index !== undefined;

      const fullPath = this.buildFullPath(routePath, isIndex, parentPath);
      const route = this.buildRouteEntry(fullPath, elementContent, parentProtected, parentLayout);

      if (routePath || isIndex) {
        routes.push(route);
      }

      this.visitJsxChildren(node, fullPath, route.component, route.isProtected, visitJsx);
    };

    visitJsx(sourceFile, "/", undefined, false);
    return dedupeRoutes(routes);
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
  private extractObjectRoutes(sourceFile: ts.SourceFile): RouteEntry[] {
    const routes: RouteEntry[] = [];

    const visit = (node: ts.Node) => {
      // createRouter({ routes: [...] }) — Vue Router
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ROUTER_FUNCTIONS.has(node.expression.text)) {
        const firstArg = node.arguments[0];
        // React Router: useRoutes([...]) / createBrowserRouter([...])
        if (firstArg && ts.isArrayLiteralExpression(firstArg)) {
          this.parseRouteArray(firstArg, sourceFile, "/", routes);
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
              this.parseRouteArray(prop.initializer, sourceFile, "/", routes);
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
          this.parseRouteArray(node.initializer, sourceFile, "/", routes);
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
    parentPath: string,
    routes: RouteEntry[],
    parentProtected?: boolean,
    parentLayout?: string
  ): void {
    for (const element of array.elements) {
      if (!ts.isObjectLiteralExpression(element)) continue;

      const props = this.extractRouteObjectProps(element, sourceFile);
      const fullPath = this.buildFullPath(props.routePath, props.isIndex, parentPath);
      const isProtected = parentProtected || props.isProtected;
      const route = this.buildRouteEntry(fullPath, props.elementText, isProtected, parentLayout);
      if (props.isProtected && !route.protection) {
        route.protection = "route-meta";
      }

      if (props.routePath || props.isIndex) {
        routes.push(route);
      }

      if (props.childrenArray) {
        const layout = route.component === "Unknown" ? parentLayout : route.component;
        this.parseRouteArray(props.childrenArray, sourceFile, fullPath, routes, route.isProtected, layout);
      }
    }
  }

  private extractRouteObjectProps(element: ts.ObjectLiteralExpression, sourceFile: ts.SourceFile) {
    let routePath: string | undefined;
    let elementText = "";
    let isIndex = false;
    let isProtected = false;
    let childrenArray: ts.ArrayLiteralExpression | undefined;

    for (const prop of element.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;

      const propName = prop.name.text;
      if (propName === "path" && ts.isStringLiteral(prop.initializer)) {
        routePath = prop.initializer.text;
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

    return { routePath, elementText, isIndex, isProtected, childrenArray };
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
