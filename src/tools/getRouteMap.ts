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
    const page = findByLayers(cache.getByName(route.component), ROUTE_OWNER_LAYERS);

    const entry: RouteMapEntry = {
      path: route.path,
      component: route.component,
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
