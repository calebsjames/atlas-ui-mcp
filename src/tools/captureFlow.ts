import type { BrowserSession } from "../browser/session.js";
import type { FlowAction, ResolvedFlowStep } from "../browser/types.js";
import type { RouteAnalyzer } from "../analyzer/routeAnalyzer.js";
import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { BrowserConfig } from "../types.js";
import { resolveRoute } from "../browser/resolveRoute.js";
import type { McpContentResult } from "../browser/response.js";

export interface FlowStep {
  /** Navigation target for this step: a catalog component, a route path, or an absolute URL. */
  component?: string;
  route?: string;
  url?: string;
  params?: Record<string, string>;
  /** Interactions to run after navigating (or on the current page if no nav target). */
  actions?: FlowAction[];
  /** Human label for this step in the report. */
  label?: string;
  /** Extra settle time (ms) after this step before screenshotting. */
  settleMs?: number;
  /** Skip the screenshot for this step. */
  noScreenshot?: boolean;
  /** Continue the flow even if an action in this step fails. */
  continueOnError?: boolean;
}

/**
 * Walk a sequence of screens against ONE persistent page, driving forms along
 * the way: navigate, then click/fill/select/press, screenshot each step, and
 * aggregate diagnostics into a single pass/fail. Because the page persists,
 * login → fill form → submit → assert-next-screen works as one flow.
 */
export async function captureFlow(
  args: { steps: FlowStep[]; settleMs?: number; public?: boolean },
  session: BrowserSession,
  routeAnalyzer: RouteAnalyzer,
  scanner: ComponentScanner,
  cache: CacheManager,
  browserConfig: BrowserConfig
): Promise<McpContentResult> {
  if (!Array.isArray(args.steps) || args.steps.length === 0) {
    throw new Error("Provide a non-empty `steps` array.");
  }

  // Resolve each step's navigation target (if any) to a concrete URL up front.
  const resolved: ResolvedFlowStep[] = [];
  for (let i = 0; i < args.steps.length; i++) {
    const step = args.steps[i];
    const hasNav = !!(step.component || step.route || step.url);
    const hasActions = Array.isArray(step.actions) && step.actions.length > 0;
    if (!hasNav && !hasActions) {
      throw new Error(
        `Step ${i + 1} does nothing — give it a navigation target (component/route/url) and/or actions.`
      );
    }

    let url: string | undefined;
    if (step.url) {
      // Accept absolute URLs or dev-server-relative paths, like check_page does.
      url = step.url.startsWith("http")
        ? step.url
        : session.baseUrl.replace(/\/$/, "") + (step.url.startsWith("/") ? step.url : `/${step.url}`);
    } else if (step.component || step.route) {
      const r = await resolveRoute(
        {
          baseUrl: session.baseUrl,
          component: step.component,
          route: step.route,
          params: step.params,
          defaultParams: browserConfig.routeParams,
        },
        routeAnalyzer,
        scanner,
        cache
      );
      url = r.url;
    }

    resolved.push({
      label: step.label || step.component || step.route || step.url || `step ${i + 1}`,
      url,
      actions: step.actions,
      settleMs: step.settleMs,
      noScreenshot: step.noScreenshot,
      continueOnError: step.continueOnError,
    });
  }

  const stepResults = await session.runFlow(resolved, {
    settleMs: args.settleMs,
    requireAuth: !args.public,
  });

  const content: McpContentResult["content"] = [];
  const summaries = stepResults.map((r, i) => ({
    step: i + 1,
    label: r.label,
    url: r.url,
    title: r.title,
    performed: r.performed,
    error: r.error,
    clean: r.clean,
    consoleErrors: r.consoleErrors,
    pageErrors: r.pageErrors,
    failedRequests: r.failedRequests.map((f) => ({ method: f.method, url: f.url, failure: f.failure })),
    requestCount: r.requestCount,
    apiCalls: r.apiCalls,
    screenshotPath: r.screenshotPath,
  }));

  const completed = stepResults.length;
  const allClean = stepResults.every((r) => r.clean);
  const stoppedEarly = completed < resolved.length;

  content.push({
    type: "text",
    text: JSON.stringify(
      {
        passed: allClean && !stoppedEarly,
        stoppedEarly,
        stepsCompleted: `${completed}/${resolved.length}`,
        steps: summaries,
      },
      null,
      2
    ),
  });
  for (const r of stepResults) {
    if (r.screenshotBase64) {
      content.push({ type: "image", data: r.screenshotBase64, mimeType: "image/png" });
    }
  }

  return { content };
}
