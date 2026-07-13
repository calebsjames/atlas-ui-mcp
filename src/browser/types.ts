/** Shared types for the browser/runtime-verification layer. */

export interface ConsoleEntry {
  type: string; // "error" | "warning" | "log" | ...
  text: string;
}

export interface NetworkEntry {
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  ok?: boolean;
  failure?: string;
  /** Response size in bytes (Content-Length, or the buffered body length). */
  bytes?: number;
  /** Rows in the primary collection of a JSON body (see BodySummary). */
  rowCount?: number;
  /** Where `rowCount` came from: "$" (top-level array) or a JSON key path. */
  rowsFrom?: string;
  /** Server-reported pagination total, when the body carries one. */
  totalCount?: number;
}

export interface CaptureResult {
  url: string;
  title: string;
  /** Absolute path to the PNG screenshot on disk. */
  screenshotPath: string;
  /** Base64 PNG, so the agent can actually see the render inline. */
  screenshotBase64: string;
  consoleErrors: ConsoleEntry[];
  consoleWarnings: ConsoleEntry[];
  pageErrors: string[];
  failedRequests: NetworkEntry[];
  requests: NetworkEntry[];
  /** Secret-safe descriptions of any in-page actions run after load, in order. */
  performed: string[];
  /** Set if an action failed; the screenshot still reflects the state reached. */
  actionError?: string;
  /** True if nothing went wrong: no page errors, console errors, or failed requests. */
  clean: boolean;
  durationMs: number;
}

export interface CaptureOptions {
  /** Filename stem for the screenshot (no extension). */
  label?: string;
  /** Override wait strategy. "networkidle" is thorough but can hang on long-poll apps. */
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  /** Extra settle time in ms after load before screenshotting. */
  settleMs?: number;
  /** Capture the full scrollable page rather than just the viewport. */
  fullPage?: boolean;
  /**
   * Interactions to run after load and before settle/screenshot. Used to
   * exercise mutations (fill → click Save → POST) so their API calls land in
   * the diagnostics buffer. A failing action is recorded, not thrown.
   */
  actions?: FlowAction[];
  /**
   * Whether this call needs an authenticated session. Defaults to true (login
   * runs if configured). Set false for public routes so a broken/missing
   * credential can't block them — the login pre-step is skipped entirely.
   */
  requireAuth?: boolean;
}

/** A single interaction performed against the live page during a flow. */
export interface FlowAction {
  type: "click" | "fill" | "press" | "select" | "check" | "uncheck" | "hover" | "waitFor";
  /** CSS selector, or a Playwright selector like `text=Submit` / `role=button[name="Save"]`. */
  selector?: string;
  /**
   * Row/card scoping: restrict `selector` to the innermost element that
   * contains BOTH this text AND a `selector` match — "the Open Kit button in
   * the row containing RK-003" without hand-writing container CSS. When the
   * scoped target is disabled, the action still fails loudly (a disabled
   * control is signal, not an obstacle to route around).
   */
  within?: string;
  /** Value for `fill` / `select`. */
  text?: string;
  /** Key for `press` (e.g. "Enter", "Tab"). */
  key?: string;
  /** Per-action timeout in ms (default 10000). */
  timeoutMs?: number;
}

/** One step of a flow, already resolved to a concrete URL (if it navigates). */
export interface ResolvedFlowStep {
  label: string;
  /** Absolute URL to navigate to at the start of this step. Omit to act on the current page. */
  url?: string;
  actions?: FlowAction[];
  settleMs?: number;
  /** Skip the screenshot for this step (e.g. a noisy intermediate). */
  noScreenshot?: boolean;
  /** Keep going to the next step even if an action in this one fails. */
  continueOnError?: boolean;
}

export interface FlowStepResult {
  label: string;
  url?: string;
  title: string;
  /** Human-readable list of what was navigated/clicked/filled, in order. */
  performed: string[];
  /** Set if navigation or an action failed; the screenshot shows the failure state. */
  error?: string;
  screenshotPath?: string;
  screenshotBase64?: string;
  /** Diagnostics produced *during this step only*. */
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: NetworkEntry[];
  requestCount: number;
  /**
   * The app API calls made during this step (xhr/fetch or `/api/` URLs),
   * deduped by method + path and capped, so mutation endpoints triggered by
   * this step's actions are visible — not just a request count.
   */
  apiCalls: ApiCall[];
  clean: boolean;
}

/** An observed API call, reduced to what matters for source-vs-runtime checks. */
export interface ApiCall {
  method: string;
  /** URL pathname only — query string is intentionally dropped. */
  path: string;
  status?: number;
  /** Response size in bytes, so payload-level assertions don't need curl. */
  bytes?: number;
  /** Rows in the JSON body's primary collection (see BodySummary). */
  rowCount?: number;
  /** Which key `rowCount` was taken from: "$" (top-level array) or a key path. */
  rowsFrom?: string;
  /** Server-reported pagination total, when present. */
  totalCount?: number;
}
