import fs from "fs/promises";
import path from "path";
import type { Browser, BrowserContext, Page } from "playwright";
import type { BrowserConfig } from "../types.js";

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
}

interface DiagBuffers {
  consoleErrors: ConsoleEntry[];
  consoleWarnings: ConsoleEntry[];
  pageErrors: string[];
  failedRequests: NetworkEntry[];
  requests: NetworkEntry[];
  byUrl: Map<string, NetworkEntry>;
}

/**
 * Lazily-launched headless browser. The first browser tool call spins Chromium
 * up; it's reused across calls and torn down on server shutdown. Playwright is
 * imported lazily so the static-analysis tools keep working even if the browser
 * binaries were never installed.
 */
export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private loggedIn = false;
  // Set when the login pre-step has failed. We remember it (instead of retrying
  // a broken credential on every call) and surface it to authed calls only —
  // public calls never consult it, so one bad login can't blank all runtime work.
  private loginError: string | null = null;
  // All tools share ONE page so SPA state — including session-storage-based auth
  // — survives across calls. Diagnostics accumulate here and are sliced per-call.
  private primaryPage: Page | null = null;
  private primaryDiag: DiagBuffers | null = null;
  private readonly outputDirAbs: string;

  constructor(
    private readonly workspaceRoot: string,
    private readonly config: BrowserConfig
  ) {
    this.outputDirAbs = path.resolve(
      workspaceRoot,
      config.outputDir || ".atlas-ui/captures"
    );
  }

  get baseUrl(): string {
    return this.config.devServerUrl || "http://localhost:5173";
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;

    let chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      throw new Error(
        "Playwright is not installed. Run `npm install` in the atlas-ui " +
          "directory to enable the browser tools."
      );
    }

    try {
      this.browser = await chromium.launch({
        headless: this.config.headless !== false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        "Could not launch Chromium. If you see a 'missing browser' error, run " +
          "`npx playwright install chromium` in the atlas-ui directory. " +
          `Underlying error: ${msg}`
      );
    }

    this.context = await this.browser.newContext({
      viewport: this.config.viewport || { width: 1280, height: 800 },
    });

    return this.context;
  }

  /**
   * Return the shared page, creating it (with listeners attached once) on first
   * use. Page creation NO LONGER triggers login — that's demand-driven via
   * `requireAuth`, so a public call always gets a usable page even when the
   * configured credential is broken. When `requireAuth` is set, the login
   * pre-step runs (once) before returning, and its storage-based auth persists
   * to every later navigation on this same page.
   */
  private async ensurePage(
    opts: { requireAuth?: boolean } = {}
  ): Promise<{ page: Page; diag: DiagBuffers }> {
    const context = await this.ensureContext();
    if (!this.primaryPage || !this.primaryDiag) {
      const page = await context.newPage();
      this.primaryDiag = this.attach(page);
      this.primaryPage = page;
    }

    if (opts.requireAuth) {
      await this.ensureLoggedIn();
    }

    return { page: this.primaryPage, diag: this.primaryDiag };
  }

  /**
   * Run the login pre-step once, on demand. On failure we deliberately DON'T
   * tear the browser down — that would blank public routes too. Instead we
   * remember the error and throw only for this authed call, so public checks
   * keep working and reset_login can retry a fixed credential without a restart.
   */
  private async ensureLoggedIn(): Promise<void> {
    if (this.loggedIn || !this.config.login) return;
    if (this.loginError) {
      throw new Error(
        `Login is unavailable: ${this.loginError} ` +
          `Fix browser.login/credentials and call reset_login to retry. ` +
          `Public routes are still checkable — pass "public": true to skip login.`
      );
    }
    try {
      await this.performLogin(this.primaryPage!);
      this.loggedIn = true;
    } catch (err) {
      this.loginError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /** Whether the login pre-step has run successfully this session. */
  get authenticated(): boolean {
    return this.loggedIn;
  }

  /** Whether a `browser.login` flow is configured at all. */
  get loginConfigured(): boolean {
    return !!this.config.login;
  }

  /** The last login failure message, if login was attempted and failed. */
  get loginFailure(): string | null {
    return this.loginError;
  }

  /**
   * Force-reset the auth session: drop the page AND context (clearing cookies +
   * storage), clear a stuck login error, then — if `relogin` — run the login
   * flow again immediately. The in-session equivalent of restarting the server
   * to recover a broken/expired login, without losing the browser process.
   */
  async resetLogin(opts: { relogin?: boolean } = {}): Promise<{ loggedIn: boolean; error?: string }> {
    await this.primaryPage?.close().catch(() => {});
    await this.context?.close().catch(() => {});
    this.primaryPage = null;
    this.primaryDiag = null;
    this.context = null;
    this.loggedIn = false;
    this.loginError = null;

    if (!this.config.login) return { loggedIn: false };

    if (opts.relogin) {
      try {
        await this.ensurePage({ requireAuth: true });
        return { loggedIn: this.loggedIn };
      } catch {
        return { loggedIn: false, error: this.loginError ?? "login failed" };
      }
    }
    return { loggedIn: this.loggedIn };
  }

  /**
   * Run the configured login flow on the shared page. A success check (selector
   * or URL) keeps us from proceeding before the auth round-trip persists.
   */
  private async performLogin(page: Page): Promise<void> {
    const login = this.config.login!;
    const url = login.url.startsWith("http")
      ? login.url
      : this.baseUrl.replace(/\/$/, "") + (login.url.startsWith("/") ? login.url : `/${login.url}`);
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      for (const action of login.actions) {
        await this.runAction(page, this.resolveSecrets(action as FlowAction));
      }
      if (login.successSelector) {
        await page.waitForSelector(login.successSelector, { timeout: 15_000 });
      }
      if (login.successUrlIncludes) {
        const needle = login.successUrlIncludes;
        await page.waitForURL((u) => u.toString().includes(needle), { timeout: 15_000 });
      }
      // Let the auth token settle into storage before the first real navigation.
      await page.waitForTimeout(500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Login pre-step failed (${msg}). Check browser.login selectors, success check, and credentials.`
      );
    }
  }

  /** Replace `${ENV_VAR}` in an action's text with process.env values. */
  private resolveSecrets(action: FlowAction): FlowAction {
    if (action.text == null) return action;
    const text = action.text.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_m, name) => {
      const v = process.env[name];
      if (v == null) {
        throw new Error(`browser.login references env var \${${name}}, but it is not set.`);
      }
      return v;
    });
    return { ...action, text };
  }

  /**
   * Navigate to a URL and capture a screenshot plus runtime diagnostics
   * (console errors/warnings, uncaught exceptions, failed + all network requests).
   */
  async capture(url: string, opts: CaptureOptions = {}): Promise<CaptureResult> {
    const { page, diag } = await this.ensurePage({ requireAuth: opts.requireAuth !== false });

    // Record buffer positions so we report only THIS call's diagnostics, not
    // everything accumulated on the shared page since login.
    const mark = {
      ce: diag.consoleErrors.length,
      cw: diag.consoleWarnings.length,
      pe: diag.pageErrors.length,
      fr: diag.failedRequests.length,
      rq: diag.requests.length,
    };

    const start = Date.now();
    try {
      await page.goto(url, {
        waitUntil: opts.waitUntil || "networkidle",
        timeout: 30_000,
      });
    } catch (err) {
      // A nav timeout still leaves a renderable page; record it and continue so
      // the agent gets a screenshot + whatever diagnostics accumulated.
      diag.pageErrors.push(
        `Navigation issue: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Run any actions BEFORE settle/screenshot so the mutations they trigger
    // (and the network calls those mutations make) fall inside this call's
    // buffer slice. A failed action is reported, not thrown — the screenshot
    // still captures whatever state was reached.
    const performed: string[] = [];
    let actionError: string | undefined;
    for (const action of opts.actions || []) {
      try {
        await this.runAction(page, action);
        performed.push(describeAction(action));
      } catch (err) {
        actionError = err instanceof Error ? err.message : String(err);
        break;
      }
    }

    if (opts.settleMs) await page.waitForTimeout(opts.settleMs);

    await fs.mkdir(this.outputDirAbs, { recursive: true });
    const stem = (opts.label || "capture").replace(/[^a-zA-Z0-9_-]/g, "_");
    const screenshotPath = path.join(this.outputDirAbs, `${stem}-${this.nextId()}.png`);
    const buffer = await page.screenshot({
      path: screenshotPath,
      fullPage: opts.fullPage ?? false,
    });

    const title = await page.title().catch(() => "");
    const durationMs = Date.now() - start;

    const consoleErrors = diag.consoleErrors.slice(mark.ce);
    const consoleWarnings = diag.consoleWarnings.slice(mark.cw);
    const pageErrors = diag.pageErrors.slice(mark.pe);
    const failedRequests = diag.failedRequests.slice(mark.fr);
    const requests = diag.requests.slice(mark.rq);

    return {
      url,
      title,
      screenshotPath,
      screenshotBase64: buffer.toString("base64"),
      consoleErrors,
      consoleWarnings,
      pageErrors,
      failedRequests,
      requests,
      performed,
      actionError,
      clean:
        consoleErrors.length === 0 &&
        pageErrors.length === 0 &&
        failedRequests.length === 0,
      durationMs,
    };
  }

  /**
   * Run an arbitrary function against the shared page, ensuring the page (and
   * the login pre-step) exist first. This is the low-level escape hatch for
   * tools that need to drive the page directly — e.g. inspect_rendered_page
   * evaluates React/Vue internals — without duplicating the capture/screenshot
   * machinery. State (auth, SPA navigation) persists exactly as with capture().
   */
  async withPage<T>(
    fn: (page: Page) => Promise<T>,
    opts: { requireAuth?: boolean } = {}
  ): Promise<T> {
    const { page } = await this.ensurePage({ requireAuth: opts.requireAuth !== false });
    return fn(page);
  }

  /** Attach console/error/network listeners to a page and return their buffers. */
  private attach(page: Page): DiagBuffers {
    const d: DiagBuffers = {
      consoleErrors: [],
      consoleWarnings: [],
      pageErrors: [],
      failedRequests: [],
      requests: [],
      byUrl: new Map(),
    };
    page.on("console", (msg) => {
      const type = msg.type();
      const entry = { type, text: msg.text() };
      if (type === "error") d.consoleErrors.push(entry);
      else if (type === "warning") d.consoleWarnings.push(entry);
    });
    page.on("pageerror", (err) => d.pageErrors.push(err.message));
    page.on("request", (req) => {
      const entry: NetworkEntry = {
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType(),
      };
      d.requests.push(entry);
      d.byUrl.set(req.url() + req.method(), entry);
    });
    page.on("response", (res) => {
      const entry = d.byUrl.get(res.url() + res.request().method());
      if (entry) {
        entry.status = res.status();
        entry.ok = res.ok();
      }
    });
    page.on("requestfailed", (req) => {
      d.failedRequests.push({
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        failure: req.failure()?.errorText || "unknown",
      });
    });
    return d;
  }

  /**
   * Drive a sequence of steps against a SINGLE persistent page, so form state,
   * cookies, and SPA navigation carry across steps (fill → submit → next screen).
   * Each step optionally navigates, runs actions, then screenshots. Diagnostics
   * are sliced per-step. On a failed action the step is screenshotted in its
   * broken state and the flow stops (unless the step sets continueOnError).
   */
  async runFlow(
    steps: ResolvedFlowStep[],
    opts: { settleMs?: number; requireAuth?: boolean } = {}
  ): Promise<FlowStepResult[]> {
    // Reuse the shared page so a configured login pre-step (and any prior tool
    // state) carries into the flow. Pass requireAuth:false for a public flow.
    const { page, diag: d } = await this.ensurePage({ requireAuth: opts.requireAuth !== false });
    const results: FlowStepResult[] = [];

    {
      let aborted = false;
      for (let i = 0; i < steps.length; i++) {
        if (aborted) break;
        const step = steps[i];
        const mark = {
          ce: d.consoleErrors.length,
          pe: d.pageErrors.length,
          fr: d.failedRequests.length,
          rq: d.requests.length,
        };
        const performed: string[] = [];
        let error: string | undefined;

        try {
          if (step.url) {
            await page.goto(step.url, { waitUntil: "networkidle", timeout: 30_000 });
            performed.push(`navigated to ${step.url}`);
          }
          for (const action of step.actions || []) {
            await this.runAction(page, action);
            performed.push(describeAction(action));
          }
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          if (!step.continueOnError) aborted = true;
        }

        const settle = step.settleMs ?? opts.settleMs;
        if (settle) await page.waitForTimeout(settle);

        let screenshotPath: string | undefined;
        let screenshotBase64: string | undefined;
        if (!step.noScreenshot) {
          await fs.mkdir(this.outputDirAbs, { recursive: true });
          const stem = `flow-${String(i + 1).padStart(2, "0")}-${step.label}`.replace(
            /[^a-zA-Z0-9_-]/g,
            "_"
          );
          screenshotPath = path.join(this.outputDirAbs, `${stem}-${this.nextId()}.png`);
          const buf = await page.screenshot({ path: screenshotPath }).catch(() => null);
          if (buf) screenshotBase64 = buf.toString("base64");
        }

        const stepConsoleErrors = d.consoleErrors.slice(mark.ce).map((e) => e.text);
        const stepPageErrors = d.pageErrors.slice(mark.pe);
        const stepFailed = d.failedRequests.slice(mark.fr);
        // API calls made during THIS step only — the buffer slice since `mark`.
        const stepApiCalls = toApiCalls(d.requests.slice(mark.rq));
        results.push({
          label: step.label,
          url: step.url,
          title: await page.title().catch(() => ""),
          performed,
          error,
          screenshotPath,
          screenshotBase64,
          consoleErrors: stepConsoleErrors,
          pageErrors: stepPageErrors,
          failedRequests: stepFailed,
          requestCount: d.requests.length - mark.rq,
          apiCalls: stepApiCalls,
          clean:
            !error &&
            stepConsoleErrors.length === 0 &&
            stepPageErrors.length === 0 &&
            stepFailed.length === 0,
        });
      }
    }

    return results;
  }

  /** Execute one interaction. Throws (with Playwright's message) if it can't. */
  private async runAction(page: Page, a: FlowAction): Promise<void> {
    const timeout = a.timeoutMs ?? 10_000;
    const need = (v: string | undefined, field: string): string => {
      if (!v) throw new Error(`Action "${a.type}" requires a ${field}.`);
      return v;
    };

    // `within` scoping goes through a composed Locator; the plain path keeps
    // the exact page.* calls so existing flows behave byte-for-byte the same.
    if (a.within) {
      const target = this.scopedTarget(page, need(a.selector, "selector"), a.within);
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

    switch (a.type) {
      case "click":
        await page.click(need(a.selector, "selector"), { timeout });
        return;
      case "fill":
        await page.fill(need(a.selector, "selector"), a.text ?? "", { timeout });
        return;
      case "select":
        await page.selectOption(need(a.selector, "selector"), a.text ?? "", { timeout });
        return;
      case "check":
        await page.check(need(a.selector, "selector"), { timeout });
        return;
      case "uncheck":
        await page.uncheck(need(a.selector, "selector"), { timeout });
        return;
      case "hover":
        await page.hover(need(a.selector, "selector"), { timeout });
        return;
      case "press":
        if (a.selector) await page.press(a.selector, need(a.key, "key"), { timeout });
        else await page.keyboard.press(need(a.key, "key"));
        return;
      case "waitFor":
        if (a.selector) await page.waitForSelector(a.selector, { timeout });
        else await page.waitForTimeout(a.timeoutMs ?? 1000);
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
  private scopedTarget(page: Page, selector: string, within: string) {
    const text = JSON.stringify(within);
    const container = `:has-text(${text}):has(${selector})`;
    return page.locator(`${container}:not(:has(${container}))`).locator(selector).first();
  }

  private counter = 0;
  private nextId(): string {
    // Monotonic per-process counter — Date.now()/random are intentionally avoided
    // so screenshot names stay deterministic within a run.
    this.counter += 1;
    return String(this.counter).padStart(3, "0");
  }

  async close(): Promise<void> {
    await this.primaryPage?.close().catch(() => {});
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.primaryPage = null;
    this.primaryDiag = null;
    this.context = null;
    this.browser = null;
    this.loggedIn = false;
    this.loginError = null;
  }
}

/**
 * Reduce a network-buffer slice to the app's API calls: keep xhr/fetch or any
 * URL under `/api/`, drop the query string, dedupe by method + pathname, and
 * cap the list so a chatty step can't flood the report.
 */
function toApiCalls(requests: NetworkEntry[]): ApiCall[] {
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

/** One-line, secret-safe description of an action for the report. */
function describeAction(a: FlowAction): string {
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
