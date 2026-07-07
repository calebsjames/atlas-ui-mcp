import fs from "fs/promises";
import type { RouteAnalyzer } from "../analyzer/routeAnalyzer.js";
import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import { getRouteMap, type RouteMapEntry } from "../tools/getRouteMap.js";
import { findByLayers, ROUTE_OWNER_LAYERS } from "../tools/shared.js";
import { detectViewGate, type ViewGate } from "./viewGate.js";
import { toAbsoluteUrl } from "../util.js";

export interface ResolvedRoute {
  url: string;
  routePath: string;
  component: string;
  isProtected: boolean;
  /** Dynamic segments that were filled, with the value used. */
  filledParams: Record<string, string>;
  /** Dynamic segments we had to guess a value for (no param supplied). */
  guessedParams: string[];
  /**
   * Present when the requested component is conditionally rendered inside the
   * routed page behind a view switch (`v-if="currentView === 'X'"`). When the
   * gate variable is wired to a route.query key, the query param has been
   * appended to `url` and `applied` is true; otherwise the gate is only
   * reported so the caller knows an interaction is needed to reveal it.
   */
  viewGate?: ViewGate & { applied: boolean };
}

/**
 * Resolve a catalog component name OR a raw route path into a concrete URL on
 * the running dev server. This is the bridge: the static route map already
 * knows which URL renders a given component, so the agent never has to hunt.
 */
export async function resolveRoute(
  opts: {
    baseUrl: string;
    component?: string;
    route?: string;
    params?: Record<string, string>;
    defaultParams?: Record<string, string>;
  },
  routeAnalyzer: RouteAnalyzer,
  scanner: ComponentScanner,
  cache: CacheManager
): Promise<ResolvedRoute> {
  const routes = await getRouteMap(routeAnalyzer, scanner, cache);
  const params = { ...opts.defaultParams, ...opts.params };

  let match: RouteMapEntry | undefined;
  if (opts.route) {
    match =
      routes.find((r) => r.path === opts.route) ||
      // tolerate a path passed without/with a leading slash
      routes.find((r) => r.path.replace(/^\//, "") === opts.route!.replace(/^\//, ""));
    if (!match) {
      // Raw path the agent wants to hit directly, even if not in the catalog.
      const { url, filled, guessed } = fillSegments(opts.baseUrl, opts.route, params);
      return {
        url,
        routePath: opts.route,
        component: "(unmapped route)",
        isProtected: false,
        filledParams: filled,
        guessedParams: guessed,
      };
    }
  }

  let matchedChildName: string | undefined;
  if (!opts.route && opts.component) {
    const wanted = opts.component.toLowerCase();
    match =
      routes.find((r) => r.component.toLowerCase() === wanted) ||
      routes.find((r) => r.component.toLowerCase().includes(wanted));
    if (!match) {
      // Resolved via the parent page's child list — the child may sit behind a
      // view-container gate on that page (handled below).
      match = routes.find((r) =>
        r.componentDetails?.childComponents.some((c) => c.toLowerCase() === wanted)
      );
      matchedChildName = match?.componentDetails?.childComponents.find(
        (c) => c.toLowerCase() === wanted
      );
    }
    if (!match) {
      throw new Error(
        `No route renders a component matching "${opts.component}". ` +
          `Use get_route_map to see what's routable, or pass an explicit "route".`
      );
    }
  } else if (!match) {
    throw new Error('Provide either "component" or "route".');
  }

  const { url, filled, guessed } = fillSegments(opts.baseUrl, match.path, params);

  let viewGate: ResolvedRoute["viewGate"];
  let finalUrl = url;
  if (matchedChildName) {
    const gate = await detectGateInPage(match, matchedChildName, cache);
    if (gate) {
      const applied = !!(gate.queryKey && gate.queryValue !== undefined);
      if (applied) {
        finalUrl +=
          (finalUrl.includes("?") ? "&" : "?") +
          `${gate.queryKey}=${encodeURIComponent(gate.queryValue!)}`;
      }
      viewGate = { ...gate, applied };
    }
  }

  return {
    url: finalUrl,
    routePath: match.path,
    component: match.component,
    isProtected: match.isProtected,
    filledParams: filled,
    guessedParams: guessed,
    viewGate,
  };
}

/**
 * When resolution fell through to a page's childComponents list, look for a
 * query-param-driven render gate on that child inside the page source (the
 * view-container pattern). Best-effort: any read/parse failure means no gate.
 */
async function detectGateInPage(
  match: RouteMapEntry,
  childName: string,
  cache: CacheManager
): Promise<ViewGate | null> {
  const page = findByLayers(cache.getByName(match.component), ROUTE_OWNER_LAYERS);
  if (!page) return null;
  try {
    const source = await fs.readFile(page.path, "utf-8");
    return detectViewGate(source, childName);
  } catch {
    return null;
  }
}

/** Replace `:segment` / `[segment]` placeholders with concrete values. */
function fillSegments(
  baseUrl: string,
  routePath: string,
  params: Record<string, string>
): { url: string; filled: Record<string, string>; guessed: string[] } {
  const filled: Record<string, string> = {};
  const guessed: string[] = [];

  const replaced = routePath.replace(/:([A-Za-z0-9_]+)|\[([A-Za-z0-9_]+)\]/g, (_m, a, b) => {
    const name = a || b;
    if (params[name] != null) {
      filled[name] = params[name];
      return params[name];
    }
    // Sensible guess so the page at least renders; id-like → "1", else "sample".
    const guess = /id$/i.test(name) ? "1" : "sample";
    guessed.push(name);
    filled[name] = guess;
    return guess;
  });

  return { url: toAbsoluteUrl(baseUrl, replaced), filled, guessed };
}
