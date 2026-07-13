import fs from "fs/promises";
import path from "path";
import type { Browser, BrowserContext, Page } from "playwright";
import type { BrowserConfig } from "../types.js";
import type {
  CaptureOptions,
  CaptureResult,
  ConsoleEntry,
  FlowAction,
  FlowStepResult,
  NetworkEntry,
  ResolvedFlowStep,
} from "./types.js";
import { describeAction, runAction, toApiCalls } from "./actions.js";
import { isApiRequest, summarizeJsonBody } from "./network.js";
import { errMessage, toAbsoluteUrl } from "../util.js";

/**
 * Skip body summarization above this size — record the byte count, but don't
 * buffer/parse a multi-megabyte payload just to count its rows.
 */
const MAX_BODY_SUMMARY_BYTES = 5_000_000;

interface DiagBuffers {
  consoleErrors: ConsoleEntry[];
  consoleWarnings: ConsoleEntry[];
  pageErrors: string[];
  failedRequests: NetworkEntry[];
  requests: NetworkEntry[];
  byUrl: Map<string, NetworkEntry>;
  /** In-flight response-body reads, awaited before a call slices diagnostics. */
  pending: Promise<void>[];
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
  private outputDirAbs: string;

  constructor(
    private readonly workspaceRoot: string,
    private config: BrowserConfig
  ) {
    this.outputDirAbs = path.resolve(
      workspaceRoot,
      config.outputDir || ".atlas-ui/captures"
    );
  }

  /**
   * Swap in a freshly-loaded browser config — e.g. `.atlas-ui.json` gained a
   * `browser.login` block after startup. Does not touch the live browser;
   * resetLogin() (the only caller path) tears the context down right after, so
   * the next page uses the new settings.
   */
  updateConfig(config: BrowserConfig): void {
    this.config = config;
    this.outputDirAbs = path.resolve(
      this.workspaceRoot,
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
      throw new Error(
        "Could not launch Chromium. If you see a 'missing browser' error, run " +
          "`npx playwright install chromium` in the atlas-ui directory. " +
          `Underlying error: ${errMessage(err)}`
      );
    }

    this.context = await this.browser.newContext({
      viewport: this.config.viewport || { width: 1280, height: 800 },
    });

    return this.context;
  }

  /**
   * Return the shared page, creating it (with listeners attached once) on first
   * use. Page creation does not trigger login — that's demand-driven via
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
      this.loginError = errMessage(err);
      throw err;
    }
  }

  /** Whether a `browser.login` flow is configured at all. */
  get loginConfigured(): boolean {
    return !!this.config.login;
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
    const url = toAbsoluteUrl(this.baseUrl, login.url);
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      for (const action of login.actions) {
        await runAction(page, resolveSecrets(action as FlowAction));
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
      throw new Error(
        `Login pre-step failed (${errMessage(err)}). Check browser.login selectors, success check, and credentials.`
      );
    }
  }

  /**
   * Navigate to a URL and capture a screenshot plus runtime diagnostics
   * (console errors/warnings, uncaught exceptions, failed + all network requests).
   */
  async capture(url: string, opts: CaptureOptions = {}): Promise<CaptureResult> {
    const { page, diag } = await this.ensurePage({ requireAuth: opts.requireAuth !== false });

    // Record buffer positions so we report only THIS call's diagnostics, not
    // everything accumulated on the shared page since login.
    const mark = this.markDiag(diag);

    const start = Date.now();
    try {
      await page.goto(url, {
        waitUntil: opts.waitUntil || "networkidle",
        timeout: 30_000,
      });
    } catch (err) {
      // A nav timeout still leaves a renderable page; record it and continue so
      // the agent gets a screenshot + whatever diagnostics accumulated.
      diag.pageErrors.push(`Navigation issue: ${errMessage(err)}`);
    }

    // Run any actions BEFORE settle/screenshot so the mutations they trigger
    // (and the network calls those mutations make) fall inside this call's
    // buffer slice. A failed action is reported, not thrown — the screenshot
    // still captures whatever state was reached.
    const performed: string[] = [];
    let actionError: string | undefined;
    for (const action of opts.actions || []) {
      try {
        await runAction(page, action);
        performed.push(describeAction(action));
      } catch (err) {
        actionError = errMessage(err);
        break;
      }
    }

    if (opts.settleMs) await page.waitForTimeout(opts.settleMs);

    const screenshotPath = await this.screenshotFile(opts.label || "capture");
    const buffer = await page.screenshot({
      path: screenshotPath,
      fullPage: opts.fullPage ?? false,
    });

    const title = await page.title().catch(() => "");
    const durationMs = Date.now() - start;

    // Ensure body summaries for this call's requests have resolved before slicing.
    await this.settlePending(diag);

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
    const { page, diag } = await this.ensurePage({ requireAuth: opts.requireAuth !== false });
    const results: FlowStepResult[] = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const result = await this.runFlowStep(page, diag, step, i, opts.settleMs);
      results.push(result);
      if (result.error && !step.continueOnError) break;
    }

    return results;
  }

  /** Run one flow step: navigate, act, settle, screenshot, slice diagnostics. */
  private async runFlowStep(
    page: Page,
    diag: DiagBuffers,
    step: ResolvedFlowStep,
    index: number,
    defaultSettleMs?: number
  ): Promise<FlowStepResult> {
    const mark = this.markDiag(diag);
    const performed: string[] = [];
    let error: string | undefined;

    try {
      if (step.url) {
        await page.goto(step.url, { waitUntil: "networkidle", timeout: 30_000 });
        performed.push(`navigated to ${step.url}`);
      }
      for (const action of step.actions || []) {
        await runAction(page, action);
        performed.push(describeAction(action));
      }
    } catch (err) {
      error = errMessage(err);
    }

    const settle = step.settleMs ?? defaultSettleMs;
    if (settle) await page.waitForTimeout(settle);

    let screenshotPath: string | undefined;
    let screenshotBase64: string | undefined;
    if (!step.noScreenshot) {
      screenshotPath = await this.screenshotFile(
        `flow-${String(index + 1).padStart(2, "0")}-${step.label}`
      );
      const buf = await page.screenshot({ path: screenshotPath }).catch(() => null);
      if (buf) screenshotBase64 = buf.toString("base64");
    }

    // Ensure body summaries for this step's requests have resolved before slicing.
    await this.settlePending(diag);

    const consoleErrors = diag.consoleErrors.slice(mark.ce).map((e) => e.text);
    const pageErrors = diag.pageErrors.slice(mark.pe);
    const failedRequests = diag.failedRequests.slice(mark.fr);
    return {
      label: step.label,
      url: step.url,
      title: await page.title().catch(() => ""),
      performed,
      error,
      screenshotPath,
      screenshotBase64,
      consoleErrors,
      pageErrors,
      failedRequests,
      requestCount: diag.requests.length - mark.rq,
      // API calls made during THIS step only — the buffer slice since `mark`.
      apiCalls: toApiCalls(diag.requests.slice(mark.rq)),
      clean:
        !error &&
        consoleErrors.length === 0 &&
        pageErrors.length === 0 &&
        failedRequests.length === 0,
    };
  }

  /**
   * Await any in-flight response-body summaries so the diagnostics slice a call
   * is about to read has its bytes/rowCount populated. Swaps in a fresh buffer
   * first, so a promise pushed mid-await isn't dropped when this batch clears.
   */
  private async settlePending(diag: DiagBuffers): Promise<void> {
    if (diag.pending.length === 0) return;
    const batch = diag.pending;
    diag.pending = [];
    await Promise.allSettled(batch);
  }

  /** Current diagnostics buffer positions, for slicing out one call's entries. */
  private markDiag(diag: DiagBuffers) {
    return {
      ce: diag.consoleErrors.length,
      cw: diag.consoleWarnings.length,
      pe: diag.pageErrors.length,
      fr: diag.failedRequests.length,
      rq: diag.requests.length,
    };
  }

  /** Ensure the output dir exists and return a unique screenshot path for `stem`. */
  private async screenshotFile(stem: string): Promise<string> {
    await fs.mkdir(this.outputDirAbs, { recursive: true });
    const safeStem = stem.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.outputDirAbs, `${safeStem}-${this.nextId()}.png`);
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
      pending: [],
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
      if (!entry) return;
      entry.status = res.status();
      entry.ok = res.ok();

      const headers = res.headers();
      const cl = headers["content-length"];
      if (cl && /^\d+$/.test(cl)) entry.bytes = parseInt(cl, 10);

      // Summarize API JSON bodies so count-level assertions ("1578 rows") don't
      // need a drop to curl. Only API-classified, JSON responses under the size
      // cap. Reading a body is async and can't be awaited from an event handler,
      // so we park the promise and settle it before a call slices diagnostics.
      const contentType = headers["content-type"] || "";
      if (
        isApiRequest(entry) &&
        /\bjson\b/i.test(contentType) &&
        (entry.bytes == null || entry.bytes <= MAX_BODY_SUMMARY_BYTES)
      ) {
        const p = res
          .body()
          .then((buf) => {
            if (entry.bytes == null) entry.bytes = buf.length;
            if (buf.length <= MAX_BODY_SUMMARY_BYTES) {
              const summary = summarizeJsonBody(buf);
              if (summary) Object.assign(entry, summary);
            }
          })
          .catch(() => {
            // No body (204/redirect/HEAD), or it was already consumed — the
            // header byte count (if any) still stands.
          });
        d.pending.push(p);
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

/** Replace `${ENV_VAR}` in an action's text with process.env values. */
function resolveSecrets(action: FlowAction): FlowAction {
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
