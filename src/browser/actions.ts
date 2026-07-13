import type { Locator, Page } from "playwright";
import type { ApiCall, FlowAction, NetworkEntry } from "./types.js";
import { isApiRequest } from "./network.js";

/** Execute one interaction. Throws (with Playwright's message) if it can't. */
export async function runAction(page: Page, a: FlowAction): Promise<void> {
  const timeout = a.timeoutMs ?? 10_000;
  const need = (v: string | undefined, field: string): string => {
    if (!v) throw new Error(`Action "${a.type}" requires a ${field}.`);
    return v;
  };

  // Selector-less variants never resolve a target.
  if (!a.selector && !a.within) {
    if (a.type === "press") {
      await page.keyboard.press(need(a.key, "key"));
      return;
    }
    if (a.type === "waitFor") {
      await page.waitForTimeout(a.timeoutMs ?? 1000);
      return;
    }
  }

  // Everything else acts on a Locator. Responsive layouts often render the
  // same control twice (desktop + hidden mobile variant), and a plain
  // `.first()` pins the action to whichever match comes first in the DOM —
  // hidden or not — hanging until timeout. filter({ visible: true }) is a
  // live query, so the action targets the first VISIBLE match as soon as one
  // exists; when the first DOM match is already visible this picks the same
  // element `.first()` did. Every action below requires visibility anyway
  // (waitFor's default state is 'visible'), so no working target is lost.
  const base = a.within
    ? scopedTarget(page, need(a.selector, "selector"), a.within)
    : page.locator(need(a.selector, "selector"));
  const target = base.filter({ visible: true }).first();

  try {
    switch (a.type) {
      case "click":
        await target.click({ timeout });
        return;
      case "fill":
        await target.fill(a.text ?? "", { timeout });
        return;
      case "select":
        await target.selectOption(a.text ?? "", { timeout });
        return;
      case "check":
        await target.check({ timeout });
        return;
      case "uncheck":
        await target.uncheck({ timeout });
        return;
      case "hover":
        await target.hover({ timeout });
        return;
      case "press":
        await target.press(need(a.key, "key"), { timeout });
        return;
      case "waitFor":
        await target.waitFor({ timeout });
        return;
      default:
        throw new Error(`Unknown action type: ${(a as FlowAction).type}`);
    }
  } catch (err) {
    throw await explainHiddenMatches(err, base, a);
  }
}

/**
 * On timeout, say WHY when the answer is "everything that matched is hidden"
 * — the raw Playwright log shows retries against a resolved-but-hidden node,
 * which reads like a flaky click rather than a selector problem.
 */
async function explainHiddenMatches(err: unknown, base: Locator, a: FlowAction): Promise<unknown> {
  if (!(err instanceof Error) || !err.message.includes("Timeout")) return err;
  try {
    const total = await base.count();
    if (total > 0 && (await base.filter({ visible: true }).count()) === 0) {
      return new Error(
        `Action "${a.type}" on ${a.selector}: ${total} match(es) but none visible ` +
          `(hidden duplicates / collapsed container?). ${err.message}`,
      );
    }
  } catch {
    // Page navigated away or closed mid-diagnosis — keep the original error.
  }
  return err;
}

/**
 * Resolve `selector` inside the innermost element that contains both the
 * `within` text and a `selector` match — the lowest common container, i.e.
 * "the row". `:has-text(T):has(S)` matches every ancestor satisfying both;
 * excluding elements that contain another such element leaves only the
 * innermost, so ancestors (body, list wrapper) never win and same-text
 * matches in OTHER rows are excluded because their row doesn't contain this
 * row's text. The caller applies the visible-match filter and `.first()`.
 */
function scopedTarget(page: Page, selector: string, within: string) {
  const text = JSON.stringify(within);
  const container = `:has-text(${text}):has(${selector})`;
  return page.locator(`${container}:not(:has(${container}))`).locator(selector);
}

/** One-line, secret-safe description of an action for the report. */
export function describeAction(a: FlowAction): string {
  const scope = a.within ? ` within "${a.within}"` : "";
  switch (a.type) {
    case "fill":
      // Show length, not value — fields may hold passwords/tokens.
      return `filled ${a.selector}${scope} (${(a.text ?? "").length} chars)`;
    case "select":
      return `selected ${JSON.stringify(a.text ?? "")} in ${a.selector}${scope}`;
    case "press":
      return a.selector ? `pressed ${a.key} on ${a.selector}${scope}` : `pressed ${a.key}`;
    case "waitFor":
      return a.selector ? `waited for ${a.selector}${scope}` : `waited ${a.timeoutMs ?? 1000}ms`;
    default:
      return `${a.type} ${a.selector ?? ""}${scope}`.trim();
  }
}

/**
 * Reduce a network-buffer slice to the app's API calls: keep xhr/fetch or any
 * URL under `/api/`, drop the query string, dedupe by method + pathname, and
 * cap the list so a chatty step can't flood the report. Carries each call's
 * response size and row-count summary when one was captured, so payload/count
 * assertions land in the same report as {method, path, status}.
 */
export function toApiCalls(requests: NetworkEntry[]): ApiCall[] {
  const MAX_PER_SLICE = 30;
  const seen = new Set<string>();
  const out: ApiCall[] = [];
  for (const r of requests) {
    if (!isApiRequest(r)) continue;
    const p = toPathname(r.url);
    const key = r.method + " " + p;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method: r.method, path: p, status: r.status, ...bodyFields(r) });
    if (out.length >= MAX_PER_SLICE) break;
  }
  return out;
}

/** The response-size / row-count fields of an entry, each omitted when absent. */
export function bodyFields(
  r: NetworkEntry
): Pick<ApiCall, "bytes" | "rowCount" | "rowsFrom" | "totalCount"> {
  return {
    ...(r.bytes != null ? { bytes: r.bytes } : {}),
    ...(r.rowCount != null ? { rowCount: r.rowCount } : {}),
    ...(r.rowsFrom != null ? { rowsFrom: r.rowsFrom } : {}),
    ...(r.totalCount != null ? { totalCount: r.totalCount } : {}),
  };
}

/** URL → pathname (query dropped). Non-URL strings pass through unchanged. */
function toPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
