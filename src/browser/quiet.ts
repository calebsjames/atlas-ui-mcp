/**
 * The navigation "settled" signal. Playwright's `networkidle` waits for 500 ms
 * with NO open connection — which never happens once an app holds a
 * long-lived stream (SSE over fetch, EventSource, a websocket, a long-poll).
 * Every navigation then burns the whole goto timeout. The default here is
 * `quiet`: wait for `load`, then for a bounded window in which no SHORT-LIVED
 * request is in flight, ignoring streams and anything matching
 * `browser.idleIgnore`.
 */

/** How a navigation decides it is done. */
export type WaitUntil = "quiet" | "load" | "domcontentloaded" | "networkidle";

export const WAIT_UNTIL_VALUES: readonly WaitUntil[] = ["quiet", "load", "domcontentloaded", "networkidle"];

/** Tunables, all optional on BrowserConfig. */
export interface QuietOptions {
  /** Consecutive ms with no relevant request in flight (default 500). */
  quietMs: number;
  /** Upper bound on the quiet wait after `load` (default 10 000). */
  maxMs: number;
  /** A request in flight longer than this is treated as a long-poll and ignored (default 8 000). */
  longPollMs: number;
}

export const DEFAULT_QUIET: QuietOptions = { quietMs: 500, maxMs: 10_000, longPollMs: 8_000 };

/** One request currently in flight on a page. */
export interface InflightRequest {
  method: string;
  url: string;
  resourceType: string;
  /** Date.now() when the request was issued. */
  start: number;
  /** A stream / websocket / ignored URL — never holds the quiet window open. */
  longLived: boolean;
}

/**
 * Does `url` match one idleIgnore pattern? A pattern with `*` is a glob
 * matched anywhere in the URL; anything else is a plain substring.
 */
export function matchesUrlPattern(url: string, pattern: string): boolean {
  if (!pattern) return false;
  if (!pattern.includes("*")) return url.includes(pattern);
  const re = new RegExp(pattern.split("*").map(escape).join(".*"));
  return re.test(url);
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Is this request a stream that should never hold a navigation open? Decided
 * from what is known when the request is issued (resource type, Accept header,
 * URL) and refined once the response headers arrive (Content-Type).
 */
export function isLongLivedRequest(
  info: { url: string; resourceType: string; accept?: string; contentType?: string },
  idleIgnore: readonly string[] = []
): boolean {
  if (info.resourceType === "websocket" || info.resourceType === "eventsource") return true;
  if (info.accept && /text\/event-stream/i.test(info.accept)) return true;
  if (info.contentType && /text\/event-stream/i.test(info.contentType)) return true;
  return idleIgnore.some((p) => matchesUrlPattern(info.url, p));
}

/** In-flight requests that still hold the quiet window open at `now`. */
export function blockingRequests(
  inflight: Iterable<InflightRequest>,
  now: number,
  opts: Pick<QuietOptions, "longPollMs">
): InflightRequest[] {
  const out: InflightRequest[] = [];
  for (const r of inflight) {
    if (r.longLived) continue;
    if (now - r.start >= opts.longPollMs) continue; // a long-poll, by age
    out.push(r);
  }
  return out;
}

/** `GET /api/x (3.2s, stream)` — what a stalled wait reports, query string dropped. */
export function describeInflight(inflight: Iterable<InflightRequest>, now: number, max = 10): string[] {
  const all = [...inflight].sort((a, b) => a.start - b.start);
  const lines = all.slice(0, max).map((r) => {
    let p = r.url;
    try {
      const u = new URL(r.url);
      p = u.origin + u.pathname;
    } catch {
      /* keep raw */
    }
    const age = ((now - r.start) / 1000).toFixed(1);
    return `${r.method} ${p} (${age}s${r.longLived ? ", stream/ignored" : ""})`;
  });
  if (all.length > max) lines.push(`… and ${all.length - max} more`);
  return lines;
}
