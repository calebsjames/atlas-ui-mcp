import type { BrowserSession } from "../browser/session.js";
import type { FlowAction, NetworkEntry } from "../browser/types.js";
import type { RouteAnalyzer } from "../analyzer/routeAnalyzer.js";
import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { BrowserConfig } from "../types.js";
import { resolveRoute } from "../browser/resolveRoute.js";
import { bodyFields } from "../browser/actions.js";
import { isApiRequest } from "../browser/network.js";
import { getDataFlow } from "./getDataFlow.js";
import { captureResponse, diagnostics, type McpContentResult } from "../browser/response.js";

/**
 * Source-vs-runtime check. getDataFlow predicts which API endpoints a component
 * (and its child tree) should hit. This renders the route, watches the real
 * network, and asks the question that actually matters now that prediction
 * covers the whole subtree: did every observed API call map to something the
 * static graph predicted? Calls that match nothing (`unexpectedApiCalls`) are
 * the real drift signal — dynamic URLs, app-level fetches outside the tree, or
 * genuine divergence. (Predicted-but-unobserved endpoints are expected: a render
 * exercises only a slice of everything the subtree could call, so we report that
 * as a count, not noise.)
 */
export async function verifyDataFlow(
  args: {
    name: string;
    file?: string;
    section?: string;
    params?: Record<string, string>;
    settleMs?: number;
    depth?: number;
    actions?: FlowAction[];
  },
  session: BrowserSession,
  routeAnalyzer: RouteAnalyzer,
  scanner: ComponentScanner,
  cache: CacheManager,
  browserConfig: BrowserConfig
): Promise<McpContentResult> {
  const flow = await getDataFlow(
    // `file` disambiguates when the name collides across catalog items; spread
    // so it's only present when supplied.
    { name: args.name, depth: args.depth, summary: false, ...(args.file ? { file: args.file } : {}) },
    scanner,
    cache
  );

  // A colliding name yields an AmbiguousMatch and an unknown one a
  // NameNotFound instead of a flow — surface either as text (no navigation)
  // so the agent can re-call with `file` or a suggested name.
  if ("ambiguous" in flow || "found" in flow) {
    return { content: [{ type: "text", text: JSON.stringify(flow, null, 2) }] };
  }

  // allEndpoints unions across the target AND its child components.
  const predicted = flow.allEndpoints;

  const resolved = await resolveRoute(
    {
      baseUrl: session.baseUrl,
      component: args.name,
      section: args.section,
      params: args.params,
      defaultParams: browserConfig.routeParams,
      ...(args.file ? { file: args.file } : {}),
    },
    routeAnalyzer,
    scanner,
    cache
  );

  // Behind app state (a modal's v-if) and no actions to open it: page load
  // would observe the ANCESTOR's traffic and report it as drift. Hand back the
  // plan instead of a misleading verdict.
  if (resolved.stateGated && !args.actions?.length) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            target: args.name,
            verdict: "gated",
            route: resolved.routePath,
            url: resolved.url,
            mountPath: resolved.mountPath,
            captureFlowSteps: resolved.captureFlowSteps,
            predictedEndpointCount: predicted.length,
            notes:
              `"${args.name}" is mounted behind app state (see mountPath), so loading ${resolved.url} ` +
              "would not exercise it. Re-call with `actions` = the click(s) in captureFlowSteps " +
              "(after the first step) to open it, then the network is compared.",
          }),
        },
      ],
    };
  }

  // Reached through an ancestor page: that page's own traffic is expected
  // too, so predictions are the union; the target's own share is reported.
  let ancestorPredicted: string[] = [];
  if (resolved.mountPath) {
    const ancestor = await getDataFlow(
      { name: resolved.component, summary: false, depth: args.depth },
      scanner,
      cache
    );
    if (!("ambiguous" in ancestor) && !("found" in ancestor)) ancestorPredicted = ancestor.allEndpoints;
  }

  const capture = await session.capture(resolved.url, {
    label: `dataflow-${args.name}`,
    settleMs: args.settleMs ?? 500,
    // Reveal a click-switched section first (if any), then run any caller
    // mutations — all before we read the network, so the section's own fetches
    // AND the mutations count as observed calls.
    actions: [...(resolved.revealActions ?? []), ...(args.actions ?? [])],
  });

  // Observed API calls, deduped by method + path (apps poll / repeat).
  const apiCalls = dedupeCalls(capture.requests.filter(isApiRequest));

  const targetPredictions = predicted.map(parseEndpoint).filter((pred) => pred.prefix);
  const predictions = [
    ...targetPredictions,
    ...ancestorPredicted.map(parseEndpoint).filter((pred) => pred.prefix),
  ];

  type ObservedCall = {
    method: string;
    url: string;
    status?: number;
    bytes?: number;
    rowCount?: number;
    rowsFrom?: string;
    totalCount?: number;
  };
  const matched: Array<ObservedCall & { matchedPrefix: string }> = [];
  const unexpectedApiCalls: ObservedCall[] = [];
  for (const call of apiCalls) {
    const p = pathname(call.url);
    const method = call.method.toUpperCase();
    // Segment-boundary match so "/users" doesn't spuriously match "/usersettings",
    // AND method-aware: a predicted `GET /users` must not confirm an observed
    // `DELETE /users`. A prediction with no method matches any method.
    const hit = predictions.find(
      (pred) =>
        (p === pred.prefix || p.startsWith(pred.prefix + "/")) &&
        (!pred.method || pred.method === method)
    );
    if (hit) {
      const matchedPrefix = hit.method ? `${hit.method} ${hit.prefix}` : hit.prefix;
      matched.push({ method: call.method, url: call.url, status: call.status, ...bodyFields(call), matchedPrefix });
    } else {
      unexpectedApiCalls.push({ method: call.method, url: call.url, status: call.status, ...bodyFields(call) });
    }
  }

  // Of the TARGET's own predicted endpoints, how many were observed.
  const targetObserved = targetPredictions.filter((pred) =>
    apiCalls.some((call) => {
      const p = pathname(call.url);
      return (p === pred.prefix || p.startsWith(pred.prefix + "/")) &&
        (!pred.method || pred.method === call.method.toUpperCase());
    })
  ).length;

  const verdict =
    predicted.length === 0
      ? "no-prediction"
      : unexpectedApiCalls.length === 0
        ? "confirmed"
        : "drift";

  return captureResponse(
    {
      target: args.name,
      ...(flow.alsoMatched ? { alsoMatched: flow.alsoMatched } : {}),
      route: resolved.routePath,
      url: resolved.url,
      ...(resolved.viewSection ? { viewSection: resolved.viewSection } : {}),
      ...(resolved.mountPath
        ? {
            mountPath: resolved.mountPath,
            targetEndpoints: { predicted: targetPredictions.length, observed: targetObserved },
          }
        : {}),
      verdict,
      traceDepth: flow?.depth,
      predictedEndpointCount: predicted.length,
      observedApiCalls: apiCalls.length,
      matchedCount: matched.length,
      unexpectedApiCalls,
      matchedSample: matched.slice(0, 12),
      // Meaningful only when `actions` were supplied; empty otherwise.
      performed: capture.performed,
      ...(capture.actionError ? { actionError: capture.actionError } : {}),
      notes:
        verdict === "no-prediction"
          ? "Static analysis predicted no endpoints — try a larger `depth`, or this component genuinely fetches nothing."
          : verdict === "drift"
            ? "Runtime hit endpoints the static graph didn't predict (unexpectedApiCalls). Likely dynamic/template-literal URLs, app-level bootstrap fetches outside this component's tree, or genuine drift."
            : "Every observed API call maps to a predicted endpoint (method-aware) — source and runtime agree.",
      ...diagnostics(capture),
    },
    capture
  );
}

/** Collapse repeated calls to the same method + path. */
function dedupeCalls(calls: NetworkEntry[]): NetworkEntry[] {
  const seen = new Set<string>();
  const out: NetworkEntry[] = [];
  for (const c of calls) {
    const key = c.method + " " + pathname(c.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * Parse an endpoint spec into an optional HTTP method and its static path
 * prefix — the part before the first dynamic segment. Handles method prefixes,
 * `:id`, `[id]`, `{id}`, `${...}`, template literals, and full URLs.
 * e.g. "GET /projects/fitter/{fitterId}" → { method: "GET", prefix: "/projects/fitter" };
 * bare "/users" → { prefix: "/users" }.
 */
function parseEndpoint(ep: string): { method?: string; prefix: string } {
  const methodMatch = ep.trim().match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i);
  const method = methodMatch ? methodMatch[1].toUpperCase() : undefined;

  let s = ep.trim().replace(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i, "");
  s = s.replace(/^[`'"]+/, ""); // strip a leading quote/backtick from template-literal endpoints
  s = s.split(/[:[{]|\$\{/)[0]; // cut at the first dynamic marker
  try {
    if (/^https?:\/\//.test(s)) s = new URL(s).pathname;
  } catch {
    /* leave as-is */
  }
  return { method, prefix: s.replace(/\/+$/, "").toLowerCase() };
}

function pathname(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}
