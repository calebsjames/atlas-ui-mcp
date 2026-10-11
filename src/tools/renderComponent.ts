import type { BrowserSession } from "../browser/session.js";
import type { RouteAnalyzer } from "../analyzer/routeAnalyzer.js";
import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { BrowserConfig } from "../types.js";
import { resolveRoute } from "../browser/resolveRoute.js";
import { captureResponse, diagnostics, type McpContentResult } from "../browser/response.js";

/**
 * Render a catalog component (or a raw route) in the live app and screenshot it.
 * The static route map resolves component → URL, so the agent just names the
 * component it changed and gets back a render + diagnostics.
 */
export async function renderComponent(
  args: {
    component?: string;
    route?: string;
    section?: string;
    params?: Record<string, string>;
    fullPage?: boolean;
    settleMs?: number;
    public?: boolean;
    file?: string;
    loginAs?: string;
    viewport?: { width: number; height: number };
    measure?: string[];
  },
  session: BrowserSession,
  routeAnalyzer: RouteAnalyzer,
  scanner: ComponentScanner,
  cache: CacheManager,
  browserConfig: BrowserConfig
): Promise<McpContentResult> {
  const resolved = await resolveRoute(
    {
      baseUrl: session.baseUrl,
      component: args.component,
      route: args.route,
      section: args.section,
      params: args.params,
      defaultParams: browserConfig.routeParams,
      ...(args.file ? { file: args.file } : {}),
    },
    routeAnalyzer,
    scanner,
    cache
  );

  const capture = await session.capture(resolved.url, {
    label: resolved.component,
    fullPage: args.fullPage,
    settleMs: args.settleMs,
    requireAuth: !args.public,
    loginAs: args.loginAs,
    viewport: args.viewport,
    measure: args.measure,
    // Reveal a click-switched section (if any) after load, before the screenshot.
    actions: resolved.revealActions,
  });

  const notes: string[] = [];
  if (args.public && resolved.isProtected) {
    notes.push(
      "Rendered with login skipped (public:true), but this route is marked protected — " +
        "expect a login/redirect. Drop public to render it authenticated."
    );
  }
  if (resolved.guessedParams.length) {
    notes.push(
      `Guessed values for dynamic segments: ${resolved.guessedParams.join(", ")}. ` +
        `Pass "params" (or set browser.routeParams in config) for real data.`
    );
  }
  if (resolved.isProtected) {
    notes.push(
      "This route is marked protected — if you see a login/redirect, the app needs an authenticated session."
    );
  }
  if (resolved.mountPath) {
    const path = resolved.mountPath.map((h) => h.component).join(" > ");
    if (resolved.stateGated) {
      const gates = resolved.mountPath
        .filter((h) => !h.revealed)
        .map((h) => `${h.component} (${h.gate})`)
        .join(", ");
      notes.push(
        `No route renders "${args.component}" directly; it mounts via ${path}. The screenshot shows ` +
          `${resolved.component} with every URL/section reveal applied, but ${gates} sits behind app ` +
          "state — the target is NOT on screen. Run capture_flow with captureFlowSteps (replace any " +
          "<TODO> selector) to open it."
      );
    } else {
      notes.push(`No route renders "${args.component}" directly; reached via ${path} (all hops revealed by URL/section).`);
    }
  }
  if (resolved.viewSection) {
    const vs = resolved.viewSection;
    const target = args.section ? `Section "${args.section}"` : `"${args.component}"`;
    if (vs.applied) {
      notes.push(
        vs.via === "query"
          ? `${target} is a section of ${vs.container} — auto-appended a query param to reveal it.`
          : `${target} is a section of ${vs.container} — clicked its activator after load to reveal it ` +
              `(reported in performed).`
      );
    } else {
      notes.push(
        vs.note ??
          `${target} is a section of ${vs.container} (keyed on ${vs.selector}) with no statically ` +
            `resolvable reveal — the screenshot likely shows the default view; an interaction is needed.`
      );
    }
  }

  return captureResponse(
    {
      resolved: {
        component: resolved.component,
        routePath: resolved.routePath,
        url: resolved.url,
        filledParams: resolved.filledParams,
        isProtected: resolved.isProtected,
        ...(resolved.viewSection ? { viewSection: resolved.viewSection } : {}),
        ...(resolved.mountPath ? { mountPath: resolved.mountPath, targetMounted: !resolved.stateGated } : {}),
      },
      ...(resolved.captureFlowSteps ? { captureFlowSteps: resolved.captureFlowSteps } : {}),
      performed: capture.performed,
      notes,
      ...diagnostics(capture),
    },
    capture
  );
}
