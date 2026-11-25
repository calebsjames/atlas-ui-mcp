/** Shared types for the browser/runtime-verification layer. */
import type { WaitUntil } from "./quiet.js";

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
  /** Fulfilled by a `mockApi` stub for this call — the real API never saw it. */
  mocked?: boolean;
  /** The response body, when this call's `captureBodies` asked for it. */
  responseBody?: CapturedBody;
}

/**
 * A response body returned because the call's `captureBodies` matched it:
 * `json` (parsed) when the body is JSON, else `text`. Bounded — a body over
 * the cap is shortened and says so.
 */
export interface CapturedBody {
  /** The parsed JSON body. When `truncated`, long arrays keep their first rows and long strings their head. */
  json?: unknown;
  /** A non-JSON body (or JSON that could not be shortened under the cap), cut at the cap when `truncated`. */
  text?: string;
  /** The response's content-type, without parameters. */
  contentType?: string;
  /** Set when the body was shortened to fit the cap. */
  truncated?: true;
  /** The full body's size in bytes, when `truncated`. */
  originalBytes?: number;
  /** What was cut, by JSON path — e.g. "$.items: kept 3 of 1578 rows". */
  truncation?: string[];
  /** How many credential-looking values (token/password/secret keys, JWTs) were replaced with "[redacted]". */
  redacted?: number;
  /** Why no body is here (binary, empty, over the read limit, or the per-call budget is used up). */
  omitted?: string;
}

/** What a call's `captureBodies` patterns did. */
export interface BodyCaptureReport {
  /** Each pattern and how many API responses it matched. */
  patterns: Array<{ pattern: string; matched: number }>;
  /** Distinct bodies captured, and their total size in characters. */
  bodies: number;
  chars: number;
  limits: { perBodyChars: number; perCallChars: number; perCallBodies: number };
  /** How many captured bodies were shortened. */
  truncated?: number;
  /** Patterns no API call matched, with observed calls that look like near misses. */
  unmatched?: Array<{ pattern: string; nearMisses?: string[] }>;
  warning?: string;
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
  /** Results of `measure` actions / the `measure` option, in order. */
  measurements?: Measurement[];
  /** The viewport this capture ran at. */
  viewport?: { width: number; height: number };
  /**
   * Requests still in flight when the bounded quiet window gave up — the page
   * rendered, but these had not finished (slow API, unrecognised long-poll).
   */
  pendingRequests?: string[];
  /** Which stubs matched (and which matched nothing), when `mockApi` was passed. */
  mockApi?: MockReport;
  /** What the `captureBodies` patterns matched, when it was passed. */
  captureBodies?: BodyCaptureReport;
  /** Who the browser is signed in as for this call (login account + the app's own user). */
  signedInAs?: SignedInAs;
  /** Set when the session was found signed out and this call signed in again before its (retried) navigation. */
  reloggedIn?: true;
  /** What showed the session was signed out, when `reloggedIn`. */
  reloginReason?: string;
  /**
   * Set when the page still looks signed out although the login works: a
   * re-login (in this call, or earlier on this session) succeeded and the
   * signal remained. The result is otherwise complete; `warning` explains.
   */
  stillSignedOut?: true;
  /** With `stillSignedOut`: the login worked, the likely causes, and reset_login as the manual step. */
  warning?: string;
  /** True if nothing went wrong: no page errors, console errors, or failed requests. */
  clean: boolean;
  durationMs: number;
}

export interface CaptureOptions {
  /** Filename stem for the screenshot (no extension). */
  label?: string;
  /**
   * Wait strategy (default "quiet": load + a bounded window with no short-lived
   * request in flight, ignoring streams). "networkidle" hangs on apps that hold
   * an SSE/websocket/long-poll connection.
   */
  waitUntil?: WaitUntil;
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
  /** A `browser.profiles` name to log in as (own context); omitted = browser.login. */
  loginAs?: string;
  /** Viewport for this call only. */
  viewport?: { width: number; height: number };
  /** Selectors to measure (read-only) after load/actions/settle. */
  measure?: string[];
  /** API stubs for THIS call only (see ApiMock); removed when the call ends. */
  mockApi?: ApiMock[];
  /**
   * Opt-in response bodies: path patterns (the forms `ApiMock.path` takes,
   * optionally prefixed with a method). A matching API call's entry carries
   * `responseBody`. Off unless passed.
   */
  captureBodies?: string[];
}

/**
 * One API stub. Matching requests from the page (xhr/fetch, or a URL under
 * `/api/` — the same requests `apiCalls` reports) are fulfilled with this
 * response for the duration of one call; everything else reaches the real API.
 */
export interface ApiMock {
  /** HTTP method (default "GET"); "*" matches any method. */
  method?: string;
  /**
   * URL pathname, matched on any origin, case-insensitively, trailing slash
   * ignored: exact ("/orders/catalog"), glob (`*` = one segment, `**` = any
   * depth: "/orders/*", "**\/orders/catalog"), or a regex with a "re:" prefix
   * ("re:^/orders/\\d+$"). A full URL ("http://host:5001/orders") also pins
   * the origin; a "?a=b" suffix becomes `query`.
   */
  path: string;
  /** Query parameters that must be present with these values (others may be too). */
  query?: Record<string, string | number | boolean>;
  /** Response status (default 200). */
  status?: number;
  /** JSON response body (sets content-type application/json). */
  json?: unknown;
  /**
   * JSON response body read from a file — relative to the workspace root, and
   * refused if it resolves outside it. Parsed and validated before the call.
   */
  jsonFile?: string;
  /** Raw response body (content-type text/plain unless `headers` sets one). */
  body?: string;
  /** Raw response body read from a file (same path rule; content-type by extension). */
  bodyFile?: string;
  /** Extra response headers. */
  headers?: Record<string, string>;
}

/** What a call's stubs did: hits per stub, and any stub that matched nothing. */
export interface MockReport {
  mocks: Array<{ method: string; path: string; status: number; hits: number; file?: string }>;
  /** Stubs no request matched, with observed API calls that look like near misses. */
  unmatched?: Array<{ method: string; path: string; nearMisses?: string[] }>;
  warning?: string;
}

/** One user object the app keeps in storage, reduced to identity fields (never tokens). */
export interface AppUser {
  email?: string;
  id?: string;
  name?: string;
  roles?: string[];
  /** Where it was read, e.g. "sessionStorage.app_user" or "localStorage.auth (JWT claims)". */
  source: string;
}

/** Impersonation state the app keeps in storage, when any. */
export interface Impersonation {
  /** Whether the impersonation is in force (from the stored phase/flag). */
  active: boolean;
  /** The stored phase/status as written by the app, e.g. "active", "exiting". */
  phase?: string;
  /** The user being impersonated (whose data the API serves). */
  as?: AppUser;
  /** The real (original) user, when the app stores it alongside. */
  original?: AppUser;
  source: string;
}

/**
 * Who the browser is signed in as: the account the login pre-step used
 * (resolved from config/env — an email, never a password) and the app's own
 * signed-in user as read from localStorage/sessionStorage after the call.
 */
export interface SignedInAs {
  /** "default" (browser.login) or the browser.profiles name. */
  profile: string;
  loginConfigured: boolean;
  loggedIn: boolean;
  /** Set on a public call: the login pre-step was skipped (the context may still hold a session). */
  loginSkipped?: boolean;
  /** The email the login pre-step types, resolved from config/env. */
  loginEmail?: string;
  /** Where loginEmail came from, e.g. "env CI_LOGIN_EMAIL" — or why it could not be resolved. */
  loginEmailFrom?: string;
  /** The app's own signed-in user, read from storage on the page this call ended on. */
  app?: AppUser;
  /** Other distinct user objects found in storage (the best guess is `app`). */
  alsoFound?: AppUser[];
  /** Impersonation state the app stores; false when a user was found and no such state exists. */
  impersonating?: false | Impersonation;
  /** Why the app's user could not be read (page on another origin, closed, …). */
  appUnread?: string;
  /** When the app's user was read (server_info only — runtime results read it now). */
  observedAt?: string;
  /** True when the app's user email differs from the login email. */
  mismatch?: boolean;
  /** One line: login account, app user, impersonation. */
  summary: string;
}

/** A single interaction performed against the live page during a flow. */
export interface FlowAction {
  type:
    | "click" | "fill" | "press" | "select" | "check" | "uncheck" | "hover" | "waitFor"
    | "scroll" | "wait" | "measure" | "drag" | "upload";
  /** CSS selector, or a Playwright selector like `text=Submit` / `role=button[name="Save"]`. */
  selector?: string;
  /**
   * Row/card scoping: restrict `selector` to the innermost element that
   * contains BOTH this text AND a `selector` match — "the Open Kit button in
   * the row containing RK-003" without hand-writing container CSS. When the
   * scoped target is disabled, the action still fails loudly (a disabled
   * control is signal, not an obstacle to route around). `selector` may use
   * Playwright syntax here too. `within` itself is text; written with an
   * engine prefix other than `text=` (`css=tr.selected`, `role=row[...]`) or a
   * `>>` chain it is a container selector instead.
   */
  within?: string;
  /** Value for `fill` / `select`. */
  text?: string;
  /** Key for `press` (e.g. "Enter", "Tab"). */
  key?: string;
  /** Per-action timeout in ms (default 10000). */
  timeoutMs?: number;
  /** `scroll`: pixels to scroll by (window, or the `selector` element's content). */
  x?: number;
  y?: number;
  /** `wait`: milliseconds to wait (default 1000). */
  ms?: number;
  /** `measure`: computed-style properties to read (default display/position/overflow/z-index/font-size). */
  properties?: string[];
  /** `drag`: the element to drop on (its centre, or `to` as an offset from its top-left corner). */
  toSelector?: string;
  /** `drag`: with toSelector, an offset inside the target; without, an offset from the source's centre. */
  to?: { x: number; y: number };
  /** `drag`: pointer-move steps between pick-up and drop (default 12). */
  steps?: number;
  /**
   * `upload`: file paths (absolute, or relative to the workspace root). Omitted:
   * a bundled fixture chosen by the input's `accept` (PNG, JPEG or MP4).
   */
  files?: string[];
}

/** What a read-only `measure` action reports for one selector. */
export interface Measurement {
  selector: string;
  /** How many elements matched (the first 10 are described). */
  count: number;
  elements: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    visible: boolean;
    scrollWidth: number;
    scrollHeight: number;
    clientWidth: number;
    clientHeight: number;
    /** Content wider than the box (horizontal scroll / clipping). */
    overflowsX: boolean;
    styles: Record<string, string>;
  }>;
  /** Page-level context: viewport, scroll position, and whether the whole page overflows horizontally. */
  page: { viewportWidth: number; viewportHeight: number; scrollX: number; scrollY: number; scrollWidth: number; horizontalOverflow: boolean };
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
  /** How this step's navigation decides it is done (default: the flow's, else "quiet"). */
  waitUntil?: WaitUntil;
  /** Set internally when `url` reopens the previous call's page for a flow that started without one. */
  reopened?: boolean;
  /** Resize the flow's page to this viewport before this step (persists for later steps). */
  viewport?: { width: number; height: number };
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
  /** Requests still in flight when this step's bounded quiet window gave up. */
  pendingRequests?: string[];
  /** Results of this step's `measure` actions. */
  measurements?: Measurement[];
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
  /** Fulfilled by a `mockApi` stub, not the real API. */
  mocked?: boolean;
  /** The query string (with "?") of a call that carries `responseBody` — bodies differ by query. */
  query?: string;
  /** The response body, when the call's `captureBodies` matched this call. */
  responseBody?: CapturedBody;
}
