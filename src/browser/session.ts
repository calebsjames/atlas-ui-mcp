import fs from "fs/promises";
import path from "path";
import type { Browser, BrowserContext, Page } from "playwright";
import type { BrowserConfig, BrowserLoginConfig } from "../types.js";
import type {
  CaptureOptions,
  CaptureResult,
  ConsoleEntry,
  FlowAction,
  FlowStepResult,
  Measurement,
  NetworkEntry,
  ResolvedFlowStep,
} from "./types.js";
import { describeAction, runAction, toApiCalls } from "./actions.js";
import { isApiRequest, summarizeJsonBody } from "./network.js";
import {
  blockingRequests,
  DEFAULT_QUIET,
  describeInflight,
  isLongLivedRequest,
  type InflightRequest,
  type QuietOptions,
  type WaitUntil,
} from "./quiet.js";
import { errMessage, toAbsoluteUrl } from "../util.js";
import { probeDevServer, type DevServerProbe } from "./preflight.js";

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
  /** Requests issued but not yet finished/failed — what the quiet window watches. */
  inflight: Map<unknown, InflightRequest>;
}

/** Default page.goto timeout (browser.navigationTimeoutMs overrides). */
const DEFAULT_NAV_TIMEOUT_MS = 30_000;

/**
 * Lazily-launched headless browser. The first browser tool call spins Chromium
 * up; it's reused across calls and torn down on server shutdown. Playwright is
 * imported lazily so the static-analysis tools keep working even if the browser
 * binaries were never installed.
 */
/**
 * One login identity: its own BrowserContext (cookies, localStorage,
 * IndexedDB), its own login state, and the sessionStorage snapshot carried
 * from one fresh page to the next. "default" is `browser.login`; others come
 * from `browser.profiles` and are selected per call with `loginAs`.
 */
interface Profile {
  name: string;
  context: BrowserContext | null;
  page: Page | null;
  diag: DiagBuffers | null;
  loggedIn: boolean;
  // Set when the login pre-step has failed. Remembered (instead of retrying a
  // broken credential on every call) and surfaced to authed calls only —
  // public calls never consult it, so one bad login can't blank all runtime work.
  loginError: string | null;
  sessionSnapshot: { origin: string; entries: [string, string][] } | null;
  /** The URL the last call's page ended on — a flow whose first step has no target reopens it. */
  lastUrl: string | null;
}

/** Per-call page options shared by every runtime entry point. */
export interface PageOptions {
  requireAuth?: boolean;
  /** A `browser.profiles` name; omitted = the default `browser.login`. */
  loginAs?: string;
  /** Viewport for THIS call's page only (the next call gets the configured default). */
  viewport?: { width: number; height: number };
}

const DEFAULT_PROFILE = "default";

export class BrowserSession {
  private browser: Browser | null = null;
  // Each top-level call gets a FRESH page in its profile's context, so a
  // previous call's open modal/overlay can't swallow this call's clicks.
  // Cookies, localStorage and IndexedDB live in the context and carry over;
  // sessionStorage is per-page, so it is snapshotted when a page is retired
  // and seeded into the next (apps keep auth tokens there).
  private profiles = new Map<string, Profile>();
  private outputDirAbs: string;
  private diagByPage = new WeakMap<Page, DiagBuffers>();

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
    this.lastProbe = null;
    this.outputDirAbs = path.resolve(
      this.workspaceRoot,
      config.outputDir || ".atlas-ui/captures"
    );
  }

  get baseUrl(): string {
    return this.config.devServerUrl || "http://localhost:5173";
  }

  private lastProbe: { at: number; probe: DevServerProbe } | null = null;

  /**
   * Is the dev server answering, and with what? Cached for a few seconds so a
   * burst of calls probes once. Runtime tools run this first and every
   * runtime error quotes it, so "timeout" never stands in for "the server is
   * down" or "it's serving something else".
   */
  async preflight(maxAgeMs = 5_000): Promise<DevServerProbe> {
    if (this.lastProbe && Date.now() - this.lastProbe.at < maxAgeMs) return this.lastProbe.probe;
    const probe = await probeDevServer(this.baseUrl);
    this.lastProbe = { at: Date.now(), probe };
    return probe;
  }

  /** The configured profile names (`browser.profiles`), plus "default" when browser.login is set. */
  get profileNames(): string[] {
    return [
      ...(this.config.login ? [DEFAULT_PROFILE] : []),
      ...Object.keys(this.config.profiles ?? {}),
    ];
  }

  /** The login flow for a profile; throws for a name that isn't configured. */
  private loginFor(name: string): BrowserLoginConfig | undefined {
    if (name === DEFAULT_PROFILE) return this.config.login;
    const login = this.config.profiles?.[name];
    if (!login) {
      const known = Object.keys(this.config.profiles ?? {});
      throw new Error(
        `Unknown loginAs "${name}". ` +
          (known.length
            ? `Configured browser.profiles: ${known.join(", ")}.`
            : "No browser.profiles are configured in .atlas-ui.json.") +
          " Omit loginAs for the default browser.login."
      );
    }
    return login;
  }

  private profile(name = DEFAULT_PROFILE): Profile {
    this.loginFor(name); // validate
    let p = this.profiles.get(name);
    if (!p) {
      p = {
        name, context: null, page: null, diag: null, loggedIn: false,
        loginError: null, sessionSnapshot: null, lastUrl: null,
      };
      this.profiles.set(name, p);
    }
    return p;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;

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
    return this.browser;
  }

  private async ensureContext(p: Profile): Promise<BrowserContext> {
    if (p.context) return p.context;
    const browser = await this.ensureBrowser();
    p.context = await browser.newContext({
      viewport: this.config.viewport || { width: 1280, height: 800 },
    });
    return p.context;
  }

  /**
   * A fresh page for this call, in the requested profile's context. Page
   * creation does not trigger login — that's demand-driven via `requireAuth`,
   * so a public call always gets a usable page even when the configured
   * credential is broken. When `requireAuth` is set, the profile's login
   * pre-step runs (once per profile) before returning.
   */
  private async ensurePage(
    opts: PageOptions = {}
  ): Promise<{ page: Page; diag: DiagBuffers; profile: Profile }> {
    const p = this.profile(opts.loginAs);
    const context = await this.ensureContext(p);
    await this.retirePage(p);

    const page = await context.newPage();
    p.diag = this.attach(page);
    p.page = page;
    if (opts.viewport) await page.setViewportSize(opts.viewport);
    if (p.sessionSnapshot) {
      // Seed only an EMPTY sessionStorage on the app's origin, so later
      // navigations in this page keep whatever the app wrote meanwhile.
      await page.addInitScript((snap: { origin: string; entries: [string, string][] }) => {
        try {
          if (location.origin !== snap.origin || sessionStorage.length > 0) return;
          for (const [k, v] of snap.entries) sessionStorage.setItem(k, v);
        } catch {
          /* storage blocked — nothing to seed */
        }
      }, p.sessionSnapshot);
    }

    if (opts.requireAuth || opts.loginAs) {
      await this.ensureLoggedIn(p);
    }

    return { page, diag: p.diag, profile: p };
  }

  /** Snapshot the profile's current page's sessionStorage + URL, then close it. */
  private async retirePage(p: Profile): Promise<void> {
    const page = p.page;
    p.page = null;
    p.diag = null;
    if (!page || page.isClosed()) return;
    await this.snapshotSession(p, page);
    await page.close().catch(() => {});
  }

  private async snapshotSession(p: Profile, page: Page): Promise<void> {
    try {
      const url = page.url();
      if (/^https?:/.test(url)) p.lastUrl = url;
      const origin = new URL(url).origin;
      if (origin !== new URL(this.baseUrl).origin) return;
      const entries = await page.evaluate(() => Object.entries(sessionStorage) as [string, string][]);
      p.sessionSnapshot = { origin, entries };
    } catch {
      /* about:blank, closed, or cross-origin — keep the previous snapshot */
    }
  }

  /**
   * Run the profile's login pre-step once, on demand. On failure we
   * deliberately DON'T tear the browser down — that would blank public routes
   * too. Instead we remember the error and throw only for this authed call, so
   * public checks keep working and reset_login can retry a fixed credential.
   */
  private async ensureLoggedIn(p: Profile): Promise<void> {
    const login = this.loginFor(p.name);
    if (p.loggedIn || !login) return;
    if (p.loginError) {
      throw new Error(
        `Login${p.name === DEFAULT_PROFILE ? "" : ` as "${p.name}"`} is unavailable: ${p.loginError} ` +
          `Fix browser.${p.name === DEFAULT_PROFILE ? "login" : `profiles.${p.name}`}/credentials and call ` +
          `reset_login to retry. Public routes are still checkable — pass "public": true to skip login.`
      );
    }
    try {
      await this.performLogin(p.page!, login);
      p.loggedIn = true;
      // The token the login wrote to sessionStorage must reach later pages.
      await this.snapshotSession(p, p.page!);
    } catch (err) {
      p.loginError = errMessage(err);
      throw err;
    }
  }

  /** Whether a `browser.login` flow is configured at all. */
  get loginConfigured(): boolean {
    return !!this.config.login;
  }

  /** Login state for server_info: configured, logged in, or stuck on an error — per profile. */
  loginState(): {
    configured: boolean;
    loggedIn: boolean;
    browserLaunched: boolean;
    error?: string;
    profiles?: Array<{ name: string; loggedIn: boolean; error?: string }>;
  } {
    const d = this.profiles.get(DEFAULT_PROFILE);
    const named = Object.keys(this.config.profiles ?? {}).map((name) => {
      const p = this.profiles.get(name);
      return { name, loggedIn: !!p?.loggedIn, ...(p?.loginError ? { error: p.loginError } : {}) };
    });
    return {
      configured: !!this.config.login,
      loggedIn: !!d?.loggedIn,
      browserLaunched: !!this.browser,
      ...(d?.loginError ? { error: d.loginError } : {}),
      ...(named.length ? { profiles: named } : {}),
    };
  }

  /**
   * Force-reset auth: drop the page AND context (clearing cookies + storage)
   * of one profile (`loginAs`) or of every profile, clear a stuck login error,
   * then — if `relogin` — run that login flow again immediately. The in-session
   * equivalent of restarting the server, without losing the browser process.
   */
  async resetLogin(opts: { relogin?: boolean; loginAs?: string } = {}): Promise<{ loggedIn: boolean; error?: string }> {
    const names = opts.loginAs ? [opts.loginAs] : [...this.profiles.keys()];
    if (opts.loginAs) this.loginFor(opts.loginAs); // validate before tearing anything down
    for (const name of names) {
      const p = this.profiles.get(name);
      if (!p) continue;
      await p.page?.close().catch(() => {});
      await p.context?.close().catch(() => {});
      this.profiles.delete(name);
    }

    const target = opts.loginAs ?? DEFAULT_PROFILE;
    if (!this.loginFor(target)) return { loggedIn: false };

    if (opts.relogin) {
      try {
        const { profile } = await this.ensurePage({ requireAuth: true, loginAs: opts.loginAs });
        return { loggedIn: profile.loggedIn };
      } catch {
        const p = this.profiles.get(target);
        return { loggedIn: false, error: p?.loginError ?? "login failed" };
      }
    }
    return { loggedIn: false };
  }

  /**
   * Run a login flow on `page`. A success check (selector or URL) keeps us
   * from proceeding before the auth round-trip persists.
   */
  private async performLogin(page: Page, login: BrowserLoginConfig): Promise<void> {
    const url = toAbsoluteUrl(this.baseUrl, login.url);
    try {
      await this.navigate(page, url, "quiet");
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
      // Say where the login stopped: the URL, the page title, and a screenshot
      // of that state — a bare selector timeout sent agents to wrong theories.
      const where = await this.describeFailedPage(page, "login-failed");
      throw new Error(
        `Login pre-step failed (${errMessage(err).split("\n")[0]}). ${where} ` +
          "Check browser.login selectors, success check, and credentials."
      );
    }
  }

  /** `Stopped at <url> "<title>" (screenshot: <path>)` for an error message. */
  private async describeFailedPage(page: Page, stem: string): Promise<string> {
    const url = (() => {
      try {
        return page.url();
      } catch {
        return "(unknown)";
      }
    })();
    const title = await page.title().catch(() => "");
    let shot = "";
    try {
      const file = await this.screenshotFile(stem);
      await page.screenshot({ path: file });
      shot = ` (screenshot: ${file})`;
    } catch {
      /* page gone — no screenshot */
    }
    return `Stopped at ${url}${title ? ` "${title}"` : " (no <title>)"}${shot}.`;
  }

  /**
   * Navigate to a URL and capture a screenshot plus runtime diagnostics
   * (console errors/warnings, uncaught exceptions, failed + all network requests).
   */
  async capture(url: string, opts: CaptureOptions = {}): Promise<CaptureResult> {
    const { page, diag } = await this.ensurePage({
      requireAuth: opts.requireAuth !== false,
      loginAs: opts.loginAs,
      viewport: opts.viewport,
    });

    // Record buffer positions so we report only THIS call's diagnostics, not
    // everything accumulated on the shared page since login.
    const mark = this.markDiag(diag);

    const start = Date.now();
    let pendingRequests: string[] | undefined;
    try {
      pendingRequests = await this.navigate(page, url, opts.waitUntil);
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
    const measurements: Measurement[] = [];
    for (const action of opts.actions || []) {
      try {
        const out = await runAction(page, action);
        if (out) measurements.push(out);
        performed.push(describeAction(action));
      } catch (err) {
        actionError = errMessage(err);
        break;
      }
    }
    // Let the requests those actions fired land in this call's slice.
    if (opts.actions?.length && (opts.waitUntil ?? "quiet") === "quiet") {
      pendingRequests = (await this.waitForQuiet(page)) ?? pendingRequests;
    }

    if (opts.settleMs) await page.waitForTimeout(opts.settleMs);
    // Read-only measurements requested for the settled page (check_page / render_component `measure`).
    for (const selector of opts.measure ?? []) {
      const out = await runAction(page, { type: "measure", selector }).catch((err) => {
        actionError ??= `measure ${selector}: ${errMessage(err)}`;
        return undefined;
      });
      if (out) measurements.push(out);
    }
    const viewport = page.viewportSize() ?? undefined;

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
      ...(pendingRequests?.length ? { pendingRequests } : {}),
      ...(measurements.length ? { measurements } : {}),
      ...(viewport ? { viewport } : {}),
      clean:
        consoleErrors.length === 0 &&
        pageErrors.length === 0 &&
        failedRequests.length === 0,
      durationMs,
    };
  }

  /**
   * Navigate `page` and wait per `waitUntil` (default `quiet`). `quiet` waits for
   * `load`, then for a bounded window with no short-lived request in flight —
   * streams (SSE, websockets), long-polls and `browser.idleIgnore` URLs never
   * hold it open. Returns the requests still in flight when the bounded window
   * gave up (not an error: the page rendered). A failed goto throws with the
   * in-flight list appended, so a stall names its cause.
   */
  async navigate(page: Page, url: string, waitUntil: WaitUntil = "quiet"): Promise<string[] | undefined> {
    const timeout = this.config.navigationTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;
    try {
      await page.goto(url, { waitUntil: waitUntil === "quiet" ? "load" : waitUntil, timeout });
    } catch (err) {
      const diag = this.diagByPage.get(page);
      const inflight = diag ? describeInflight(diag.inflight.values(), Date.now()) : [];
      throw new Error(
        `${errMessage(err).split("\n")[0]}` +
          (inflight.length ? ` Still in flight: ${inflight.join("; ")}.` : "") +
          (waitUntil === "networkidle"
            ? ` networkidle never settles while a stream is open — use waitUntil "quiet" (the default).`
            : "")
      );
    }
    if (waitUntil === "quiet") return this.waitForQuiet(page);
    return undefined;
  }

  /**
   * Wait until no blocking request has been in flight for `quietMs`, bounded by
   * `maxMs`. Returns the in-flight list when the bound was hit, else undefined.
   */
  private async waitForQuiet(page: Page): Promise<string[] | undefined> {
    const diag = this.diagByPage.get(page);
    if (!diag) return undefined;
    const opts = this.quietOptions();
    const start = Date.now();
    let quietSince = Date.now();
    while (Date.now() - start < opts.maxMs) {
      const now = Date.now();
      if (blockingRequests(diag.inflight.values(), now, opts).length > 0) quietSince = now;
      else if (now - quietSince >= opts.quietMs) return undefined;
      await page.waitForTimeout(50).catch(() => {});
      if (page.isClosed()) return undefined;
    }
    const now = Date.now();
    return describeInflight(blockingRequests(diag.inflight.values(), now, opts), now);
  }

  private quietOptions(): QuietOptions {
    return {
      quietMs: this.config.quietMs ?? DEFAULT_QUIET.quietMs,
      maxMs: this.config.quietMaxMs ?? DEFAULT_QUIET.maxMs,
      longPollMs: this.config.longPollMs ?? DEFAULT_QUIET.longPollMs,
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
    opts: PageOptions = {}
  ): Promise<T> {
    const { page } = await this.ensurePage({ ...opts, requireAuth: opts.requireAuth !== false });
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
    opts: { settleMs?: number; waitUntil?: WaitUntil } & PageOptions = {}
  ): Promise<FlowStepResult[]> {
    // One fresh page for the whole flow, logged in as the requested profile
    // (requireAuth:false for a public flow). Steps share it.
    const { page, diag, profile } = await this.ensurePage({
      requireAuth: opts.requireAuth !== false,
      loginAs: opts.loginAs,
      viewport: opts.viewport,
    });
    const results: FlowStepResult[] = [];

    // The page is fresh. A flow that starts by acting "on the current page"
    // reopens the previous call's URL — from a clean load, so its in-page
    // state (an open modal, a typed-in form) is NOT carried over.
    if (steps.length && !steps[0].url) {
      if (!profile.lastUrl) {
        throw new Error(
          "The first step has no navigation target and there is no previous page to act on — " +
            "give it a component, route or url."
        );
      }
      steps = [{ ...steps[0], url: profile.lastUrl, reopened: true }, ...steps.slice(1)];
    }

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const result = await this.runFlowStep(page, diag, step, i, opts.settleMs, opts.waitUntil);
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
    defaultSettleMs?: number,
    defaultWaitUntil?: WaitUntil
  ): Promise<FlowStepResult> {
    const mark = this.markDiag(diag);
    const performed: string[] = [];
    let error: string | undefined;
    let pendingRequests: string[] | undefined;
    const waitUntil = step.waitUntil ?? defaultWaitUntil ?? "quiet";

    const measurements: Measurement[] = [];
    try {
      if (step.viewport) await page.setViewportSize(step.viewport);
      if (step.url) {
        pendingRequests = await this.navigate(page, step.url, waitUntil);
        performed.push(
          step.reopened
            ? `reopened ${step.url} (fresh page — the previous call's in-page state is not carried over)`
            : `navigated to ${step.url}`
        );
      }
      for (const action of step.actions || []) {
        const out = await runAction(page, action);
        if (out) measurements.push(out);
        performed.push(describeAction(action));
      }
      if (step.actions?.length && waitUntil === "quiet") {
        pendingRequests = (await this.waitForQuiet(page)) ?? pendingRequests;
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
      ...(pendingRequests?.length ? { pendingRequests } : {}),
      ...(measurements.length ? { measurements } : {}),
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
      inflight: new Map(),
    };
    this.diagByPage.set(page, d);
    const idleIgnore = this.config.idleIgnore ?? [];
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
      d.inflight.set(req, {
        method: req.method(),
        url: req.url(),
        resourceType: req.resourceType(),
        start: Date.now(),
        longLived: isLongLivedRequest(
          { url: req.url(), resourceType: req.resourceType(), accept: req.headers()["accept"] },
          idleIgnore
        ),
      });
    });
    page.on("requestfinished", (req) => {
      d.inflight.delete(req);
    });
    page.on("response", (res) => {
      // A response that turns out to be a stream never "finishes" — stop
      // counting it against the quiet window as soon as its headers say so.
      const live = d.inflight.get(res.request());
      if (live && /text\/event-stream/i.test(res.headers()["content-type"] || "")) live.longLived = true;
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
      const live = d.inflight.get(req);
      d.inflight.delete(req);
      // A stream (SSE/websocket) aborted because the page navigated away is
      // the app working as intended, not a failed request.
      if (live?.longLived && /ERR_ABORTED|aborted/i.test(req.failure()?.errorText || "")) return;
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
    for (const p of this.profiles.values()) {
      await p.page?.close().catch(() => {});
      await p.context?.close().catch(() => {});
    }
    this.profiles.clear();
    await this.browser?.close().catch(() => {});
    this.browser = null;
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
