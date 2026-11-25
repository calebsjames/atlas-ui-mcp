import type { FileChooser, Locator, Page } from "playwright";
import type { ApiCall, FlowAction, Measurement, NetworkEntry } from "./types.js";
import { isApiRequest } from "./network.js";
import { resolveUploadFiles } from "./upload.js";

/** What an action needs from its caller beyond the page. */
export interface ActionContext {
  /** Where relative `upload` file paths resolve (the workspace root). */
  baseDir?: string;
}

/** What an action reports back: a measurement (`measure`), or a detail for the performed line. */
export interface ActionOutcome {
  measurement?: Measurement;
  /** Appended to describeAction's line, e.g. which files an upload set. */
  detail?: string;
}

/**
 * Execute one interaction. Throws (with Playwright's message) if it can't.
 * Returns the Measurement of a read-only `measure`, or a detail line.
 */
export async function runAction(page: Page, a: FlowAction, ctx: ActionContext = {}): Promise<ActionOutcome | undefined> {
  const timeout = a.timeoutMs ?? 10_000;
  const need = (v: string | undefined, field: string): string => {
    if (!v) throw new Error(`Action "${a.type}" requires a ${field}.`);
    return v;
  };

  if (a.type === "wait") {
    await page.waitForTimeout(a.ms ?? a.timeoutMs ?? 1000);
    return;
  }
  if (a.type === "measure") return { measurement: await measure(page, need(a.selector, "selector"), a.properties) };

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
    if (a.type === "scroll") {
      // By (x, y); with neither, to the bottom of the page.
      await page.evaluate(({ x, y }) => {
        if (x == null && y == null) window.scrollTo(0, document.documentElement.scrollHeight);
        else window.scrollBy(x ?? 0, y ?? 0);
      }, { x: a.x, y: a.y });
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
      case "drag":
        return { detail: await drag(page, a, target, timeout) };
      case "upload":
        return { detail: await upload(page, a, base, target, timeout, ctx) };
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
      case "scroll":
        // Into view; with x/y, scroll that element's own content by (x, y).
        if (a.x == null && a.y == null) await target.scrollIntoViewIfNeeded({ timeout });
        else await target.evaluate((el, d) => el.scrollBy(d.x ?? 0, d.y ?? 0), { x: a.x, y: a.y });
        return;
      default:
        throw new Error(`Unknown action type: ${(a as FlowAction).type}`);
    }
  } catch (err) {
    throw await explainFailure(err, page, base, target, a);
  }
}

/** Box + centre of a visible element (waits for it to be visible). */
async function centreOf(loc: Locator, timeout: number, what: string) {
  await loc.waitFor({ state: "visible", timeout });
  const b = await loc.boundingBox();
  if (!b) throw new Error(`drag: the ${what} has no box (not rendered).`);
  return { ...b, cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
}

/**
 * Real pointer drag: press on the source's centre, move in `steps` to the drop
 * point, release. Chromium turns this into pointer/mouse events for
 * pointer-driven widgets (sliders, sortable lists) AND into native HTML5
 * dragstart/dragover/drop for `draggable` elements — the same machinery as
 * Playwright's dragTo, with an explicit drop point.
 */
async function drag(page: Page, a: FlowAction, source: Locator, timeout: number): Promise<string> {
  if (!a.toSelector && !a.to) throw new Error('Action "drag" requires "toSelector" or "to": {x, y}.');
  if (a.to && (typeof a.to.x !== "number" || typeof a.to.y !== "number")) {
    throw new Error('Action "drag": "to" must be {x: number, y: number}.');
  }
  await source.scrollIntoViewIfNeeded({ timeout });
  const from = await centreOf(source, timeout, `source ${a.selector}`);
  let x: number;
  let y: number;
  if (a.toSelector) {
    const t = await centreOf(page.locator(a.toSelector).filter({ visible: true }).first(), timeout, `target ${a.toSelector}`);
    ({ x, y } = a.to ? { x: t.x + a.to.x, y: t.y + a.to.y } : { x: t.cx, y: t.cy });
  } else {
    ({ x, y } = { x: from.cx + a.to!.x, y: from.cy + a.to!.y });
  }
  const vp = page.viewportSize();
  if (vp && (x < 0 || y < 0 || x > vp.width || y > vp.height)) {
    throw new Error(
      `drag: the drop point (${Math.round(x)}, ${Math.round(y)}) is outside the ${vp.width}x${vp.height} viewport — ` +
        "scroll so both ends are on screen first, or use a taller `viewport`."
    );
  }
  const steps = Math.max(1, Math.min(Math.round(a.steps ?? 12), 200));
  await page.mouse.move(from.cx, from.cy);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps });
  await page.mouse.up();
  return `from (${Math.round(from.cx)}, ${Math.round(from.cy)}) to (${Math.round(x)}, ${Math.round(y)}) in ${steps} steps`;
}

/**
 * Set files on an `<input type=file>` (hidden ones included — styled upload
 * controls hide the input), or click any other element and answer the file
 * chooser it opens (apps that create the input on the fly). Without `files`,
 * a bundled fixture is picked by the input's `accept`.
 */
async function upload(
  page: Page,
  a: FlowAction,
  base: Locator,
  visible: Locator,
  timeout: number,
  ctx: ActionContext
): Promise<string> {
  const first = base.first();
  await first.waitFor({ state: "attached", timeout });
  const input = await first.evaluate((el) =>
    el instanceof HTMLInputElement && el.type === "file" ? { accept: el.accept || "", multiple: el.multiple } : null
  );
  let chooser: FileChooser | undefined;
  let accept: string;
  let multiple: boolean;
  if (input) {
    ({ accept, multiple } = input);
  } else {
    try {
      [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout }), visible.click({ timeout })]);
    } catch (err) {
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      throw new Error(
        `Action "upload": ${a.selector} is not an <input type=file> and clicking it opened no file chooser (${msg}). ` +
          "Point the selector at the file input, or at the control that opens the file picker."
      );
    }
    accept = (await chooser.element().getAttribute("accept").catch(() => null)) ?? "";
    multiple = chooser.isMultiple();
  }
  const files = await resolveUploadFiles(a.files, accept, ctx.baseDir);
  if (files.paths.length > 1 && !multiple) {
    throw new Error(`Action "upload": ${files.paths.length} files given, but the input takes one (no "multiple").`);
  }
  if (chooser) await chooser.setFiles(files.paths, { timeout });
  else await first.setInputFiles(files.paths, { timeout });
  return `${files.detail} via ${chooser ? "the file chooser" : "the file input"}`;
}

/** Actions Playwright only performs on an ENABLED element (its actionability check). */
const NEEDS_ENABLED = new Set<FlowAction["type"]>(["click", "fill", "select", "check", "uncheck"]);

/**
 * On timeout, say WHY when the page can tell us: everything that matched is
 * hidden, the scoped (`within`) container does not exist, or the target is
 * disabled. The raw Playwright log shows retries against a resolved node,
 * which reads like a flaky click rather than a selector or state problem.
 */
async function explainFailure(err: unknown, page: Page, base: Locator, target: Locator, a: FlowAction): Promise<unknown> {
  if (!(err instanceof Error) || !err.message.includes("Timeout")) return err;
  const on = `Action "${a.type}" on ${a.selector}${a.within ? ` within ${JSON.stringify(a.within)}` : ""}`;
  try {
    const total = await base.count();
    if (total === 0 && a.within && a.selector) {
      const alone = await page.locator(a.selector).count();
      const scope = parseWithin(a.within);
      return new Error(
        "selector" in scope
          ? `${on}: no match. "within" was read as a container SELECTOR (it uses Playwright selector syntax); ` +
            `${a.selector} alone matches ${alone} element(s) on the page. ${err.message}`
          : `${on}: no element contains both that text and a match for ${a.selector} ` +
            `(${a.selector} alone matches ${alone} element(s) on the page). "within" is matched as TEXT ` +
            `(case-insensitive substring of the row/card); to scope by a container selector instead, write it with ` +
            `an engine prefix, e.g. "within": "css=tr.selected". ${err.message}`
      );
    }
    if (total > 0 && (await base.filter({ visible: true }).count()) === 0) {
      return new Error(
        `Action "${a.type}" on ${a.selector}: ${total} match(es) but none visible ` +
          `(hidden duplicates / collapsed container?). ${err.message}`,
      );
    }
    if (total > 0 && NEEDS_ENABLED.has(a.type)) {
      const state = await target.evaluate(
        (el) => {
          const aria = el.closest('[aria-disabled="true"]');
          const name = (e: Element) => `<${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}>`;
          return {
            native: el.matches(":disabled"),
            aria: aria ? (aria === el ? "self" : name(aria)) : null,
          };
        },
        undefined,
        { timeout: 1000 }
      );
      if (state.native) {
        return new Error(
          `${on}: the target is natively disabled (the \`disabled\` attribute, or a disabled <fieldset>), so the ` +
            `${a.type} timed out waiting for it to be enabled. A disabled control cannot be clicked, focused or ` +
            `activated from the keyboard: it is disabled by design until a precondition is met (a required field, ` +
            `a selection, a permission). Satisfy that first, or report the disabled state as the finding. ${err.message}`
        );
      }
      if (state.aria) {
        const press = JSON.stringify({ type: "press", selector: a.selector, ...(a.within ? { within: a.within } : {}), key: "Space" });
        return new Error(
          `${on}: the target is disabled: aria-disabled="true"${state.aria === "self" ? "" : ` on its ancestor ${state.aria}`}. ` +
            `Playwright waits for a control to be enabled, so the ${a.type} timed out. Either the control is disabled by ` +
            `design (a precondition such as a required field or a selection is not met: satisfy it, or report the ` +
            `disabled state as the finding), or the app still handles activation on it (an aria-disabled control stays ` +
            `focusable): then use ${press} (or "Enter"), which does not wait for enabled. ${err.message}`
        );
      }
    }
  } catch {
    // Page navigated away or closed mid-diagnosis — keep the original error.
  }
  return err;
}

/** A selector engine prefix (`text=`, `role=`, `css=`, `xpath=`, `data-testid=`, …). */
const ENGINE_PREFIX =
  /^(?:text|role|css|xpath|id|data-testid|data-test-id|data-test|nth|visible|has|has-not|has-text|has-not-text|internal:[a-z-]+|_react|_vue)\s*=/i;

/**
 * Does this selector use syntax only Playwright understands (an engine prefix,
 * a `>>` chain, XPath, or a quoted-text shorthand)? Such a selector cannot be
 * embedded in a CSS `:has(...)`.
 */
export function isPlaywrightSyntax(selector: string): boolean {
  const s = selector.trim();
  return s.includes(">>") || ENGINE_PREFIX.test(s) || s.startsWith("//") || s.startsWith("..") || /^(["']).*\1$/s.test(s);
}

/**
 * How to read `within`: text (the documented form), or — when it is written
 * in Playwright selector syntax — a container selector. `text=RK-003` is text
 * (the `text=` engine would match only the innermost node holding the text,
 * never the row around it).
 */
export function parseWithin(within: string): { text: string | RegExp } | { selector: string } {
  const s = within.trim();
  const text = /^text\s*=\s*([\s\S]*)$/i.exec(s);
  if (text && !s.includes(">>")) {
    const v = text[1].trim();
    const re = /^\/(.+)\/([a-z]*)$/s.exec(v);
    if (re) {
      try {
        return { text: new RegExp(re[1], re[2]) };
      } catch {
        /* not a regex after all — literal text */
      }
    }
    const quoted = /^(["'])([\s\S]*)\1$/.exec(v);
    return { text: quoted ? quoted[2] : v };
  }
  if (s.includes(">>") || ENGINE_PREFIX.test(s)) return { selector: s };
  return { text: within };
}

/**
 * Resolve `selector` inside the innermost element that contains both the
 * `within` text and a `selector` match — the lowest common container, i.e.
 * "the row". `:has-text(T):has(S)` matches every ancestor satisfying both;
 * excluding elements that contain another such element leaves only the
 * innermost, so ancestors (body, list wrapper) never win and same-text
 * matches in OTHER rows are excluded because their row doesn't contain this
 * row's text. The caller applies the visible-match filter and `.first()`.
 *
 * A plain CSS `selector` is composed into one CSS selector. A `selector` in
 * Playwright syntax (`text=Open`, `role=button[name="Open"]`, `button >> nth=0`)
 * is not valid inside `:has(...)`, so the same innermost-container rule is
 * built from locator filters instead. A `within` written as a selector
 * (`css=tr.selected`, `role=row[name="RK-003"]`, anything with `>>`) is the
 * container itself.
 */
function scopedTarget(page: Page, selector: string, within: string) {
  const scope = parseWithin(within);
  if ("selector" in scope) return page.locator(scope.selector).locator(selector);
  if (typeof scope.text === "string" && !isPlaywrightSyntax(selector)) {
    const text = JSON.stringify(scope.text);
    const container = `:has-text(${text}):has(${selector})`;
    return page.locator(`${container}:not(:has(${container}))`).locator(selector);
  }
  const hasText = scope.text;
  const containers = () => page.locator("*").filter({ hasText, has: page.locator(selector) });
  return containers().filter({ hasNot: containers() }).locator(selector);
}

const DEFAULT_MEASURE_STYLES = ["display", "position", "overflow-x", "overflow-y", "z-index", "font-size"];
const MAX_MEASURED = 10;

/**
 * Read-only geometry + computed styles for every element matching `selector`
 * (first 10), plus page-level scroll/overflow context. Never mutates the page.
 */
async function measure(page: Page, selector: string, properties?: string[]): Promise<Measurement> {
  const props = properties?.length ? properties : DEFAULT_MEASURE_STYLES;
  const loc = page.locator(selector);
  const count = await loc.count();
  const elements: Measurement["elements"] = [];
  for (let i = 0; i < Math.min(count, MAX_MEASURED); i++) {
    elements.push(
      await loc.nth(i).evaluate((el, ps) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const styles: Record<string, string> = {};
        for (const p of ps) styles[p] = cs.getPropertyValue(p);
        const round = (n: number) => Math.round(n * 10) / 10;
        return {
          x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height),
          visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none",
          scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight,
          clientWidth: el.clientWidth, clientHeight: el.clientHeight,
          overflowsX: el.scrollWidth > el.clientWidth + 1,
          styles,
        };
      }, props)
    );
  }
  const pageInfo = await page.evaluate(() => ({
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    scrollX: Math.round(scrollX),
    scrollY: Math.round(scrollY),
    scrollWidth: document.documentElement.scrollWidth,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
  }));
  return { selector, count, elements, page: pageInfo };
}

/** One-line, secret-safe description of an action for the report (`detail` from its outcome). */
export function describeAction(a: FlowAction, detail?: string): string {
  const scope = a.within ? ` within "${a.within}"` : "";
  switch (a.type) {
    case "drag":
      return (
        (a.toSelector
          ? `dragged ${a.selector}${scope} onto ${a.toSelector}${a.to ? ` at (+${a.to.x}, +${a.to.y})` : ""}`
          : `dragged ${a.selector}${scope} by (${a.to?.x ?? 0}, ${a.to?.y ?? 0})`) + (detail ? ` — ${detail}` : "")
      );
    case "upload":
      return `uploaded ${detail ?? "file(s)"} to ${a.selector}${scope}`;
    case "fill":
      // Show length, not value — fields may hold passwords/tokens.
      return `filled ${a.selector}${scope} (${(a.text ?? "").length} chars)`;
    case "select":
      return `selected ${JSON.stringify(a.text ?? "")} in ${a.selector}${scope}`;
    case "press":
      return a.selector ? `pressed ${a.key} on ${a.selector}${scope}` : `pressed ${a.key}`;
    case "waitFor":
      return a.selector ? `waited for ${a.selector}${scope}` : `waited ${a.timeoutMs ?? 1000}ms`;
    case "wait":
      return `waited ${a.ms ?? a.timeoutMs ?? 1000}ms`;
    case "scroll":
      return a.selector
        ? a.x == null && a.y == null
          ? `scrolled ${a.selector}${scope} into view`
          : `scrolled ${a.selector}${scope} by (${a.x ?? 0}, ${a.y ?? 0})`
        : a.x == null && a.y == null
          ? "scrolled to the bottom"
          : `scrolled the page by (${a.x ?? 0}, ${a.y ?? 0})`;
    case "measure":
      return `measured ${a.selector}`;
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
  // Calls whose body was asked for (`captureBodies`) are kept apart from the
  // dedupe-and-cap above: they dedupe by method + path + query, a repeat with
  // a DIFFERENT body is kept too, and they never count against (or get cut
  // by) the 30-call cap — a requested body is not lost to a chatty step.
  const lastBody = new Map<string, unknown>();
  let plain = 0;
  let withBody = 0;
  const out: ApiCall[] = [];
  for (const r of requests) {
    if (!isApiRequest(r)) continue;
    const p = toPathname(r.url);
    const key = r.method + " " + p;
    const call = { method: r.method, path: p, status: r.status, ...bodyFields(r), ...(r.mocked ? { mocked: true } : {}) };
    if (r.responseBody) {
      const query = toSearch(r.url);
      const bodyKey = key + query;
      const prev = lastBody.get(bodyKey);
      if (prev === r.responseBody || (prev && r.responseBody.omitted) || withBody >= MAX_PER_SLICE) continue;
      lastBody.set(bodyKey, r.responseBody);
      withBody++;
      out.push({ ...call, ...(query ? { query } : {}), responseBody: r.responseBody });
      continue;
    }
    if (seen.has(key) || plain >= MAX_PER_SLICE) continue;
    seen.add(key);
    plain++;
    out.push(call);
  }
  return out;
}

/** URL → its query string including "?", or "" when there is none. */
function toSearch(url: string): string {
  try {
    return new URL(url).search;
  } catch {
    return "";
  }
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
