import type { RouteAnalyzer } from "../analyzer/routeAnalyzer.js";
import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { FlowAction } from "./types.js";
import { getRouteMap, type RouteMapEntry } from "../tools/getRouteMap.js";
import { findByLayers, ROUTE_OWNER_LAYERS } from "../tools/shared.js";
import { planSectionReveal } from "./sectionReveal.js";
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
   * Interactions to run AFTER navigating to reveal a section that a click
   * switches to (not URL-addressable). The runtime tools run these before they
   * screenshot / read the network, so the section's own render and traffic are
   * what get captured.
   */
  revealActions?: FlowAction[];
  /**
   * Present when the resolved target is a section inside a view-multiplexing
   * container (a one-route shell). Describes how it was revealed: a URL query
   * param (already appended to `url`), a click (see `revealActions`), or
   * `unknown` when no static reveal exists (an interaction is needed).
   */
  viewSection?: {
    container: string;
    section?: string;
    selector?: string;
    via: "query" | "click" | "unknown";
    condition?: string;
    /** Whether we auto-revealed (query appended or revealActions attached). */
    applied: boolean;
    note?: string;
  };
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
    /** Reveal this section (by id) inside the resolved container page. */
    section?: string;
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

  let revealActions: FlowAction[] | undefined;
  let viewSection: ResolvedRoute["viewSection"];
  let finalUrl = url;

  // Reveal target: an explicit section id, or the child we resolved through a
  // container's childComponents list. Either drives the section-reveal engine.
  const target =
    opts.section != null
      ? { sectionId: opts.section }
      : matchedChildName
        ? { child: matchedChildName }
        : null;
  if (target) {
    const page = findByLayers(cache.getByName(match.component), ROUTE_OWNER_LAYERS);
    if (page) {
      const plan = await planSectionReveal(page.path, page.name, target);
      if (plan) {
        if (plan.queryParam) {
          finalUrl +=
            (finalUrl.includes("?") ? "&" : "?") +
            `${plan.queryParam.key}=${encodeURIComponent(plan.queryParam.value)}`;
        }
        if (plan.actions) revealActions = plan.actions;
        viewSection = {
          container: plan.container,
          ...(plan.section != null ? { section: plan.section } : {}),
          ...(plan.selector != null ? { selector: plan.selector } : {}),
          via: plan.via,
          ...(plan.condition ? { condition: plan.condition } : {}),
          applied: plan.applied,
          ...(plan.note ? { note: plan.note } : {}),
        };
      }
    }
  }

  return {
    url: finalUrl,
    routePath: match.path,
    component: match.component,
    isProtected: match.isProtected,
    filledParams: filled,
    guessedParams: guessed,
    ...(revealActions ? { revealActions } : {}),
    ...(viewSection ? { viewSection } : {}),
  };
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
