import type { RouteAnalyzer } from "../analyzer/routeAnalyzer.js";
import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import { ensureCatalog, findByLayers, ROUTE_OWNER_LAYERS } from "./shared.js";

export interface RouteMapEntry {
  path: string;
  component: string;
  isProtected: boolean;
  /** How isProtected was determined; "unknown" = an unparsable global guard exists. */
  protection?: "route-meta" | "wrapper" | "global-guard-prefix" | "unknown";
  isDynamic: boolean;
  dynamicSegments?: string[];
  parentLayout?: string;
  componentDetails?: {
    relativePath: string;
    hooks: string[];
    childComponents: string[];
    dataFetchingPattern?: string;
  };
}

/**
 * Get the complete route -> page -> component tree
 */
export async function getRouteMap(
  routeAnalyzer: RouteAnalyzer,
  scanner: ComponentScanner,
  cache: CacheManager
): Promise<RouteMapEntry[]> {
  const routes = await routeAnalyzer.analyzeRoutes();
  await ensureCatalog(scanner, cache);

  return routes.map((route) => {
    // Prefer name resolution; fall back to the routed module's FILE (lazy
    // imports carry no static component name, so the route object only knows
    // its path). Resolving by path also lets us upgrade an "Unknown" label to
    // the real page name without disturbing routes that already resolved.
    let page = findByLayers(cache.getByName(route.component), ROUTE_OWNER_LAYERS);
    if (!page && route.componentPath) {
      page = findByLayers(cache.getByPath(route.componentPath), ROUTE_OWNER_LAYERS);
    }
    const component = route.component === "Unknown" && page ? page.name : route.component;

    const entry: RouteMapEntry = {
      path: route.path,
      component,
      isProtected: route.isProtected,
      ...(route.protection ? { protection: route.protection } : {}),
      isDynamic: route.isDynamic,
      dynamicSegments: route.dynamicSegments,
      parentLayout: route.parentLayout,
    };

    if (page) {
      entry.componentDetails = {
        relativePath: page.relativePath,
        hooks: page.hooks || [],
        childComponents: page.childComponents || [],
        dataFetchingPattern: page.dataFetchingPattern,
      };
    }

    return entry;
  });
}
