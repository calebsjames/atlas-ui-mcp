import type { Page } from "playwright";
import type { ApiCall, FlowAction, NetworkEntry } from "./types.js";

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

  // Everything else acts on a Locator. `.first()` keeps the plain path on the
  // page.click()-style first-match semantics existing flows were written
  // against; `within` composes the innermost-container scope instead.
  const target = a.within
    ? scopedTarget(page, need(a.selector, "selector"), a.within)
    : page.locator(need(a.selector, "selector")).first();

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
}

/**
 * Resolve `selector` inside the innermost element that contains both the
 * `within` text and a `selector` match — the lowest common container, i.e.
 * "the row". `:has-text(T):has(S)` matches every ancestor satisfying both;
 * excluding elements that contain another such element leaves only the
 * innermost, so ancestors (body, list wrapper) never win and same-text
 * matches in OTHER rows are excluded because their row doesn't contain this
 * row's text.
 */
function scopedTarget(page: Page, selector: string, within: string) {
  const text = JSON.stringify(within);
  const container = `:has-text(${text}):has(${selector})`;
  return page.locator(`${container}:not(:has(${container}))`).locator(selector).first();
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
 * cap the list so a chatty step can't flood the report.
 */
export function toApiCalls(requests: NetworkEntry[]): ApiCall[] {
  const MAX_PER_SLICE = 30;
  const seen = new Set<string>();
  const out: ApiCall[] = [];
  for (const r of requests) {
    const isApi = r.resourceType === "xhr" || r.resourceType === "fetch" || /\/api\//.test(r.url);
    if (!isApi) continue;
    const p = toPathname(r.url);
    const key = r.method + " " + p;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method: r.method, path: p, status: r.status });
    if (out.length >= MAX_PER_SLICE) break;
  }
  return out;
}

/** URL → pathname (query dropped). Non-URL strings pass through unchanged. */
function toPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
