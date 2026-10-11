import type { RouteAnalyzer } from "../analyzer/routeAnalyzer.js";
import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { FlowAction } from "./types.js";
import { getRouteMap, type RouteMapEntry } from "../tools/getRouteMap.js";
import {
  ensureCatalog,
  findByLayers,
  isAmbiguousMatch,
  nameNotFound,
  resolveName,
  ROUTE_OWNER_LAYERS,
} from "../tools/shared.js";
import { captureFlowSkeleton, planMountPath, type MountHop } from "./mountPath.js";
import { listSectionIds, planSectionReveal } from "./sectionReveal.js";
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
    /** A compound section's `{var: value}` conditions. */
    conditions?: Record<string, string>;
    /** Whether we auto-revealed (query appended or revealActions attached). */
    applied: boolean;
    note?: string;
  };
  /**
   * Set when no route renders the component directly: the path from the
   * nearest routed ancestor (first) down to the target (last), each hop with
   * the guard that mounts it and whether load + section reveals reach it.
   */
  mountPath?: MountHop[];
  /** Some hop needs an app-state change (open a modal, select a row) — see captureFlowSteps. */
  stateGated?: boolean;
  /** Ready-to-run capture_flow `steps` that walk mountPath (TODO selectors where none is known). */
  captureFlowSteps?: Array<Record<string, unknown>>;
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
    /** Path substring disambiguating a component name declared in several files. */
    file?: string;
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

  if (!opts.route && opts.component) {
    const wanted = opts.component.toLowerCase();
    // Exact route-component match only. The old substring fallback let a
    // short name ("Home") grab whichever page contained it.
    match = routes.find((r) => r.component.toLowerCase() === wanted);
    if (!match) {
      return resolveViaMountPath(opts, params, routes, scanner, cache);
    }
  } else if (!match) {
    throw new Error('Provide either "component" or "route".');
  }

  const { url, filled, guessed } = fillSegments(opts.baseUrl, match.path, params);

  const reveal =
    opts.section != null
      ? await revealOnRoute(match, url, { sectionId: opts.section }, cache)
      : { url, revealActions: undefined, viewSection: undefined };
  const finalUrl = reveal.url;
  const revealActions = reveal.revealActions;
  const viewSection = reveal.viewSection;

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

/**
 * Which route pattern a concrete URL (absolute or dev-server-relative) lands
 * on, with the dynamic segment values it carries — so a later step can reveal
 * a section of the page an earlier raw-`url` step opened.
 */
export function routeForUrl(
  url: string,
  routes: RouteMapEntry[]
): { route: RouteMapEntry; params: Record<string, string> } | undefined {
  let pathname: string;
  try {
    pathname = new URL(url, "http://placeholder").pathname;
  } catch {
    return undefined;
  }
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  pathname = norm(pathname);
  // Static routes first, so `/home` never loses to `/:slug`.
  const ordered = [...routes].sort((a, b) => Number(a.isDynamic) - Number(b.isDynamic));
  for (const route of ordered) {
    const names: string[] = [];
    const pattern = norm(route.path)
      .split("/")
      .map((seg) => {
        const m = /^:([A-Za-z0-9_]+)\??$|^\[([A-Za-z0-9_]+)\]$/.exec(seg);
        if (m) {
          names.push(m[1] || m[2]);
          return "([^/]+)";
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
    const hit = new RegExp(`^${pattern}$`).exec(pathname);
    if (!hit) continue;
    const params: Record<string, string> = {};
    names.forEach((n, i) => (params[n] = decodeURIComponent(hit[i + 1])));
    return { route, params };
  }
  return undefined;
}

/**
 * Plan how to reveal a section (by id or by the child it renders) on the page
 * a route renders, starting from a concrete `url` of that route. Query
 * reveals are merged into `url` (an existing value for the key is replaced);
 * click reveals come back as `revealActions`. An unknown section id throws
 * with the valid ids — it used to fall through silently to the default view.
 */
export async function revealOnRoute(
  match: RouteMapEntry,
  url: string,
  target: { sectionId?: string; child?: string },
  cache: CacheManager
): Promise<{ url: string; revealActions?: FlowAction[]; viewSection?: ResolvedRoute["viewSection"] }> {
  const page = findByLayers(cache.getByName(match.component), ROUTE_OWNER_LAYERS);
  if (!page) return { url };
  const plan = await planSectionReveal(page.path, page.name, target);
  if (!plan) {
    if (target.sectionId == null) return { url };
    const valid = await listSectionIds(page.path, page.name);
    throw new Error(
      valid.length
        ? `No section "${target.sectionId}" on ${page.name} (${match.path}). Valid sections: ` +
            valid.map((v) => JSON.stringify(v)).join(", ") +
            ". Ids match case- and whitespace-insensitively; see get_section_map."
        : `${page.name} (${match.path}) has no statically detected sections, so section ` +
            `"${target.sectionId}" can't be revealed. Drop "section" or drive the UI with capture_flow.`
    );
  }
  let finalUrl = url;
  for (const q of [plan.queryParam, ...(plan.alsoQuery ?? [])]) {
    if (q) finalUrl = setQueryParam(finalUrl, q.key, q.value);
  }
  return {
    url: finalUrl,
    ...(plan.actions ? { revealActions: plan.actions } : {}),
    viewSection: {
      container: plan.container,
      ...(plan.section != null ? { section: plan.section } : {}),
      ...(plan.selector != null ? { selector: plan.selector } : {}),
      via: plan.via,
      ...(plan.condition ? { condition: plan.condition } : {}),
      ...(plan.conditions ? { conditions: plan.conditions } : {}),
      applied: plan.applied,
      ...(plan.note ? { note: plan.note } : {}),
    },
  };
}

/** Set `key=value` on a URL's query, replacing an existing value; values are %-encoded. */
export function setQueryParam(url: string, key: string, value: string): string {
  const hashAt = url.indexOf("#");
  const hash = hashAt >= 0 ? url.slice(hashAt) : "";
  const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const qAt = base.indexOf("?");
  const pathPart = qAt >= 0 ? base.slice(0, qAt) : base;
  const pairs = (qAt >= 0 ? base.slice(qAt + 1) : "")
    .split("&")
    .filter(Boolean)
    .filter((pair) => {
      const k = pair.split("=")[0];
      try {
        return decodeURIComponent(k.replace(/\+/g, " ")) !== key;
      } catch {
        return k !== key;
      }
    });
  pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  return `${pathPart}?${pairs.join("&")}${hash}`;
}

/**
 * No route renders the component: walk up to its nearest routed ancestor and
 * reveal each hop that a URL query or section click can reach. A hop behind
 * an app-state guard (a modal's `v-if`) can't be reached by navigation alone;
 * the result says so (stateGated) and carries capture_flow steps for it.
 */
async function resolveViaMountPath(
  opts: { baseUrl: string; component?: string; section?: string; file?: string },
  params: Record<string, string>,
  routes: RouteMapEntry[],
  scanner: ComponentScanner,
  cache: CacheManager
): Promise<ResolvedRoute> {
  const name = opts.component!;
  const catalog = await ensureCatalog(scanner, cache);
  const resolved = resolveName(cache.getByName(name), name, opts.file, { preferRenderable: true });
  if (resolved === null) {
    const nf = nameNotFound(name, cache);
    throw new Error(
      `No catalog component "${name}", so no route can render it.` +
        (nf.suggestions.length
          ? ` Did you mean: ${nf.suggestions.map((s) => s.matchedExport ?? s.name).join(", ")}?`
          : " Use search_components to find it.")
    );
  }
  if (isAmbiguousMatch(resolved)) {
    throw new Error(
      `"${name}" names ${resolved.candidates.length} files: ` +
        resolved.candidates.map((c) => c.relativePath).join(", ") +
        '. Pass "file" (a path substring) to pick one.'
    );
  }
  const target = resolved.node;
  const plan = await planMountPath(target, routes, catalog.components, cache);
  if (!plan) {
    throw new Error(
      `No routed page mounts "${name}" (${target.relativePath}) — walked up to 8 levels of ` +
        `renderers/consumers without reaching a route. It may be mounted dynamically, from the app ` +
        `root only, or not at all; check find_component_usages, or pass an explicit "route".`
    );
  }

  const { url: baseUrl, filled, guessed } = fillSegments(opts.baseUrl, plan.route.path, params);
  let url = baseUrl;
  for (const q of plan.query) url = setQueryParam(url, q.key, q.value);
  let revealActions = [...plan.revealActions];
  let viewSection: ResolvedRoute["viewSection"];
  if (opts.section != null) {
    const r = await revealOnRoute(plan.route, url, { sectionId: opts.section }, cache);
    url = r.url;
    revealActions = [...(r.revealActions ?? []), ...revealActions];
    viewSection = r.viewSection;
  }
  const finalPlan = { ...plan, revealActions };

  return {
    url,
    routePath: plan.route.path,
    component: plan.route.component,
    isProtected: plan.route.isProtected,
    filledParams: filled,
    guessedParams: guessed,
    ...(revealActions.length ? { revealActions } : {}),
    ...(viewSection ? { viewSection } : {}),
    mountPath: plan.hops,
    stateGated: plan.stateGated,
    ...(plan.stateGated ? { captureFlowSteps: captureFlowSkeleton(finalPlan, url) } : {}),
  };
}
