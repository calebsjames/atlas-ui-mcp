import type { BrowserSession } from "../browser/session.js";
import type { RouteAnalyzer } from "../analyzer/routeAnalyzer.js";
import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { BrowserConfig } from "../types.js";
import { resolveRoute } from "../browser/resolveRoute.js";
import { ensureCatalog } from "./shared.js";
import type { McpContentResult } from "../browser/response.js";

/** What the in-page walk returns — a framework tag plus a per-name count map. */
interface RenderedComponents {
  framework: "react" | "vue" | "unknown";
  counts: Record<string, number>;
}

/**
 * The reverse bridge to render_component. Given a live page, report which
 * CATALOG components are actually MOUNTED right now, so an agent staring at a
 * screenshot or URL can jump straight to the source files that produced it.
 *
 * It reads framework internals in the browser: React dev builds tag DOM nodes
 * with `__reactFiber$…`; Vue 3 dev builds attach `__vueParentComponent`. Both
 * are stripped from production builds, so this only works against a running DEV
 * server — hence the explanatory `note` when nothing is detected.
 */
export async function inspectRenderedPage(
  args: { component?: string; route?: string; url?: string; params?: Record<string, string>; settleMs?: number },
  session: BrowserSession,
  routeAnalyzer: RouteAnalyzer,
  scanner: ComponentScanner,
  cache: CacheManager,
  browserConfig: BrowserConfig
): Promise<McpContentResult> {
  // Resolve the target URL: a raw `url` is treated like check_page (absolute or
  // dev-server-relative); otherwise a component/route goes through the static
  // route map, exactly like render_component.
  let url: string;
  if (args.url) {
    url = args.url.startsWith("http")
      ? args.url
      : session.baseUrl.replace(/\/$/, "") + (args.url.startsWith("/") ? args.url : `/${args.url}`);
  } else if (args.component || args.route) {
    const resolved = await resolveRoute(
      {
        baseUrl: session.baseUrl,
        component: args.component,
        route: args.route,
        params: args.params,
        defaultParams: browserConfig.routeParams,
      },
      routeAnalyzer,
      scanner,
      cache
    );
    url = resolved.url;
  } else {
    throw new Error('Provide a "url", or a "component"/"route" to resolve via the route map.');
  }

  // Make sure the catalog (and its name index) is built before we match names.
  await ensureCatalog(scanner, cache);

  const rendered = await session.withPage(async (page) => {
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    } catch {
      // A slow/failed nav still leaves something to inspect; press on.
    }
    if (args.settleMs) await page.waitForTimeout(args.settleMs);

    // Self-contained: this runs in the page, so it can close over nothing from
    // Node. It walks the rendered tree via framework internals and returns a
    // plain, serializable object.
    return page.evaluate((): RenderedComponents => {
      const MAX_NODES = 20000; // backstop against pathological DOMs
      const isPascal = (n: unknown): n is string =>
        typeof n === "string" && /^[A-Z]/.test(n);

      const reactCounts: Record<string, number> = {};
      const vueCounts: Record<string, number> = {};
      const reactSeen = new Set<unknown>();
      const vueSeen = new Set<unknown>();
      let sawReact = false;
      let sawVue = false;

      const nodes: unknown[] = [document, ...Array.from(document.querySelectorAll("*"))];
      let visited = 0;

      for (const node of nodes) {
        if (visited++ > MAX_NODES) break;
        const anyNode = node as Record<string, unknown>;

        // --- React (dev) -------------------------------------------------
        const fiberKey = Object.keys(anyNode).find((k) => k.startsWith("__reactFiber$"));
        if (fiberKey) {
          sawReact = true;
          let fiber = anyNode[fiberKey] as { return?: unknown; type?: unknown } | null;
          let guard = 0;
          while (fiber && guard++ < 1000) {
            if (reactSeen.has(fiber)) break; // ancestors already counted
            reactSeen.add(fiber);
            const type = fiber.type;
            if (typeof type === "function") {
              const fn = type as { displayName?: string; name?: string };
              const name = fn.displayName || fn.name;
              if (isPascal(name)) reactCounts[name] = (reactCounts[name] || 0) + 1;
            }
            fiber = fiber.return as { return?: unknown; type?: unknown } | null;
          }
        }

        // --- Vue 3 (dev) -------------------------------------------------
        const vueInstance = anyNode["__vueParentComponent"] as
          | { parent?: unknown; type?: { __name?: string; name?: string } }
          | undefined;
        if (vueInstance) {
          sawVue = true;
          let inst: { parent?: unknown; type?: { __name?: string; name?: string } } | null = vueInstance;
          let guard = 0;
          while (inst && guard++ < 1000) {
            if (vueSeen.has(inst)) break;
            vueSeen.add(inst);
            const name = inst.type?.__name || inst.type?.name;
            if (isPascal(name)) vueCounts[name] = (vueCounts[name] || 0) + 1;
            inst = inst.parent as { parent?: unknown; type?: { __name?: string; name?: string } } | null;
          }
        }
      }

      if (sawReact) return { framework: "react", counts: reactCounts };
      if (sawVue) return { framework: "vue", counts: vueCounts };
      return { framework: "unknown", counts: {} };
    });
  });

  // Match each detected name against the catalog so the agent gets source files.
  const mounted: Array<{ name: string; count: number; relativePath: string; architectureLayer: string }> = [];
  const unmatched: string[] = [];
  for (const [name, count] of Object.entries(rendered.counts)) {
    const matches = cache.getByName(name);
    // Prefer a renderable layer when a name collides (a page/component over a
    // like-named type/dto), else fall back to whatever matched first.
    const comp =
      matches.find(
        (m) =>
          m.architectureLayer === "component" ||
          m.architectureLayer === "page" ||
          m.architectureLayer === "context"
      ) || matches[0];
    if (comp) {
      mounted.push({
        name: comp.name,
        count,
        relativePath: comp.relativePath,
        architectureLayer: comp.architectureLayer,
      });
    } else {
      unmatched.push(name);
    }
  }

  mounted.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  unmatched.sort();

  const output: {
    url: string;
    framework: "react" | "vue" | "unknown";
    mounted: typeof mounted;
    unmatched: string[];
    note?: string;
  } = {
    url,
    framework: rendered.framework,
    mounted,
    unmatched,
  };

  if (rendered.framework === "unknown" || Object.keys(rendered.counts).length === 0) {
    output.note =
      "No React/Vue component internals were detected. This tool reads the framework " +
      "runtime that only DEV builds expose (React `__reactFiber$…`, Vue `__vueParentComponent`) — " +
      "production builds strip them. Confirm the dev server is running and serving this URL, " +
      "and that the app is a React or Vue 3 app.";
  }

  return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
}
