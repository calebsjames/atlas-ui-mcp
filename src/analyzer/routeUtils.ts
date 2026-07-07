import type { RouteEntry } from "../types.js";

/** Helpers shared by the AST-based RouteAnalyzer and the file-based route walker. */

/** Drop routes sharing an identical path + component pair (first one wins). */
export function dedupeRoutes(routes: RouteEntry[]): RouteEntry[] {
  const seen = new Set<string>();
  return routes.filter((route) => {
    const key = `${route.path}:${route.component}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Extract `:param` names (and `*` for catch-alls) from a route path. */
export function extractDynamicSegments(routePath: string): string[] {
  const segments = [...routePath.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1]);
  if (routePath.includes("*")) segments.push("*");
  return segments;
}
