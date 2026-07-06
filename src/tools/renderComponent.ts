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
    params?: Record<string, string>;
    fullPage?: boolean;
    settleMs?: number;
    public?: boolean;
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
      params: args.params,
      defaultParams: browserConfig.routeParams,
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
  if (resolved.viewGate) {
    notes.push(
      resolved.viewGate.applied
        ? `"${args.component}" is conditionally rendered inside ${resolved.component} behind ` +
            `\`${resolved.viewGate.condition}\` — auto-appended ` +
            `?${resolved.viewGate.queryKey}=${resolved.viewGate.queryValue} to reveal it.`
        : `"${args.component}" is conditionally rendered inside ${resolved.component} behind ` +
            `\`${resolved.viewGate.condition}\`, and no route.query wiring was detected — ` +
            `the screenshot likely shows the container's default view; an interaction may be ` +
            `needed to reveal the component.`
    );
  }

  return captureResponse(
    {
      resolved: {
        component: resolved.component,
        routePath: resolved.routePath,
        url: resolved.url,
        filledParams: resolved.filledParams,
        isProtected: resolved.isProtected,
        viewGate: resolved.viewGate,
      },
      notes,
      ...diagnostics(capture),
    },
    capture
  );
}
