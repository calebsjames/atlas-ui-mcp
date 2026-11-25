import { test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { AddressInfo, Socket } from "net";
import { BrowserSession } from "./session.js";
import type { BrowserConfig } from "../types.js";
import { dispatchToolCall, type ToolContext } from "../server/dispatch.js";
import { loadConfig } from "../config/configLoader.js";
import { ComponentScanner } from "../scanner/componentScanner.js";
import { CacheManager } from "../cache/cacheManager.js";
import { RouteAnalyzer } from "../analyzer/routeAnalyzer.js";
import { PropParser } from "../parser/propParser.js";

/**
 * The browser session expires during a long agent turn (about 40 idle
 * minutes: "401 everywhere, landing page, Token refresh failed"). The tools
 * then ran logged out, and the only symptom was a failed click until the
 * agent thought to call reset_login. An authenticated call now notices a
 * signed-out session on its first navigation, signs in again once, retries
 * the call once, and says so (`reloggedIn`).
 *
 * The fixture app keeps server-side sessions the test can expire. Two gates,
 * the two ways real apps show a dead session: "redirect" (a protected page
 * redirects to /login) and "api" (the page loads, its API calls answer 401).
 */

interface App {
  base: string;
  close: () => Promise<void>;
  /** Users of each successful sign-in, in order. */
  logins: string[];
  /** Every page navigation the server answered (path only). */
  navs: string[];
  /** POST /api/add calls that were authorized. */
  adds: number;
  /** Invalidate every session, as an idle timeout does. */
  expire: () => void;
  /** When true, a sign-in is accepted but its session is never valid. */
  deadSessions: boolean;
  /** When true, the login page has no submit button (the login flow cannot finish). */
  loginBroken: boolean;
}

const LOGIN_PAGE = (broken: boolean) => `<!doctype html><title>login</title>
<input id="email">${broken ? "" : '<button id="go">Log in</button>'}<script>
const go = document.getElementById("go");
if (go) go.onclick = async () => {
  const user = new URLSearchParams(location.search).get("as") || document.getElementById("email").value;
  await fetch("/session", { method: "POST", body: user });
  location.href = "/home";
};
</script>`;
const ORDERS_PAGE = `<!doctype html><title>loading</title><button id="add">Add</button><script>
Promise.all([fetch("/api/me"), fetch("/api/orders")]).then((rs) => { document.title = "orders " + rs.map((r) => r.status).join(","); });
document.getElementById("add").onclick = () => fetch("/api/add", { method: "POST" }).then((r) => { document.title = "added " + r.status; });
</script>`;

async function app(gate: "redirect" | "api"): Promise<App> {
  const sockets = new Set<Socket>();
  const valid = new Set<string>();
  let seq = 0;
  const state: App = {
    base: "", logins: [], navs: [], adds: 0, deadSessions: false, loginBroken: false,
    expire: () => valid.clear(),
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://x");
    const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || "")?.[1];
    const authed = !!sid && valid.has(sid);
    const html = (body: string) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(body);
    };
    if (url.pathname === "/session" && req.method === "POST") {
      let user = "";
      req.on("data", (c) => (user += c));
      req.on("end", () => {
        const id = `${encodeURIComponent(user)}.${++seq}`;
        if (!state.deadSessions) valid.add(id);
        state.logins.push(user);
        res.writeHead(200, { "set-cookie": `sid=${id}; Path=/`, "content-type": "application/json" });
        res.end(JSON.stringify({ sessionToken: "server-secret-token" }));
      });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      if (!authed) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end('{"error":"Token refresh failed"}');
      }
      if (url.pathname === "/api/add") state.adds++;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(url.pathname === "/api/me" ? { user: decodeURIComponent(sid!.split(".")[0]) } : { items: [1, 2] }));
    }
    state.navs.push(url.pathname);
    if (url.pathname === "/login") return html(LOGIN_PAGE(state.loginBroken));
    if (url.pathname === "/public") return html("<!doctype html><title>public</title>");
    if (gate === "redirect" && !authed) {
      res.writeHead(302, { location: "/login" });
      return res.end();
    }
    if (url.pathname === "/orders") return html(ORDERS_PAGE);
    html("<!doctype html><title>home</title>");
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}

const loginFlow = (url: string) => ({
  url,
  actions: [
    { type: "fill", selector: "#email", text: "${ATLAS_RL_EMAIL}", timeoutMs: 1500 },
    { type: "click", selector: "#go", timeoutMs: 1500 },
  ],
  successUrlIncludes: "/home",
});

function config(base: string, out: string, extra: Partial<BrowserConfig> = {}): BrowserConfig {
  process.env.ATLAS_RL_EMAIL = "ada@example.test";
  return {
    devServerUrl: base,
    headless: true,
    outputDir: out,
    login: loginFlow("/login"),
    profiles: { coach: loginFlow("/login?as=coach@example.test") },
    ...extra,
  } as unknown as BrowserConfig;
}

async function withApp(
  gate: "redirect" | "api",
  fn: (ctx: { session: BrowserSession; app: App }) => Promise<void>,
  extra: Partial<BrowserConfig> = {}
): Promise<void> {
  const fx = await app(gate);
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-relogin-"));
  const session = new BrowserSession(out, config(fx.base, out, extra));
  try {
    await fn({ session, app: fx });
  } finally {
    await session.close();
    await fx.close();
    await fs.rm(out, { recursive: true, force: true });
  }
}

test("an expired session (redirect to the login page) is signed in again once and the navigation retried", async () => {
  await withApp("redirect", async ({ session, app }) => {
    const first = await session.capture(`${app.base}/orders`, {});
    assert.equal(first.title, "orders 200,200");
    assert.equal(first.reloggedIn, undefined, "a live session reports nothing");
    assert.deepEqual(app.logins, ["ada@example.test"]);

    app.expire();
    const again = await session.capture(`${app.base}/orders`, {});
    assert.equal(again.title, "orders 200,200", "the retried navigation rendered signed in");
    assert.equal(again.reloggedIn, true);
    assert.match(again.reloginReason ?? "", /\/orders ended on the login page \(\/login\)/);
    assert.deepEqual(app.logins, ["ada@example.test", "ada@example.test"], "signed in again exactly once");
    assert.equal(again.signedInAs?.loggedIn, true);
    assert.ok(again.requests.every((q) => !q.url.endsWith("/session")), "the result is the retried navigation only, not the login traffic");

    const next = await session.capture(`${app.base}/orders`, {});
    assert.equal(next.reloggedIn, undefined);
    assert.equal(app.logins.length, 2, "the new session is reused");
  });
});

test("an expired session that shows as API 401s is signed in again too", async () => {
  await withApp("api", async ({ session, app }) => {
    await session.capture(`${app.base}/orders`, {});
    app.expire();
    const r = await session.capture(`${app.base}/orders`, { captureBodies: ["**"] });
    assert.equal(r.title, "orders 200,200");
    assert.equal(r.reloggedIn, true);
    assert.match(r.reloginReason ?? "", /2 of 2 API call\(s\) answered 401 \(GET \/api\/(me|orders), GET \/api\/(me|orders)\)/);
    assert.equal(app.logins.length, 2);
    assert.ok(!JSON.stringify(r.requests).includes("server-secret-token"), "the re-login's own traffic is never captured");
  });
});

test("still signed out after the one re-login is a clear error, not a loop", async () => {
  await withApp("api", async ({ session, app }) => {
    await session.capture(`${app.base}/orders`, {});
    app.expire();
    app.deadSessions = true;
    const navsBefore = app.navs.filter((n) => n === "/orders").length;
    await assert.rejects(session.capture(`${app.base}/orders`, {}), (err: Error) => {
      assert.match(err.message, /^Still signed out after an automatic re-login: 2 of 2 API call\(s\) answered 401/);
      assert.match(err.message, /Not retried again/);
      assert.match(err.message, /reset_login/);
      return true;
    });
    assert.equal(app.logins.length, 2, "one re-login, no more");
    assert.equal(app.navs.filter((n) => n === "/orders").length - navsBefore, 2, "the navigation ran twice: once, and one retry");
  });
});

test("a re-login that cannot complete says the session was signed out and the re-login failed", async () => {
  await withApp("redirect", async ({ session, app }) => {
    await session.capture(`${app.base}/orders`, {});
    app.expire();
    app.loginBroken = true;
    await assert.rejects(
      session.capture(`${app.base}/orders`, {}),
      /The session was signed out and the automatic re-login failed: Login pre-step failed .*Not retried again/s
    );
    assert.equal(app.logins.length, 1);
  });
});

test("public calls, the login page itself, stubbed 401s and autoRelogin:false never sign in again", async () => {
  await withApp("redirect", async ({ session, app }) => {
    await session.capture(`${app.base}/orders`, {});
    app.expire();
    const pub = await session.capture(`${app.base}/orders`, { requireAuth: false });
    assert.equal(pub.title, "login", "a public call gets the page as the app served it");
    assert.equal(pub.reloggedIn, undefined);
    const page = await session.capture(`${app.base}/public`, { requireAuth: false });
    assert.equal(page.title, "public");
    const login = await session.capture(`${app.base}/login`, {});
    assert.equal(login.title, "login");
    assert.equal(login.reloggedIn, undefined, "asking for the login page is not a signed-out signal");
    assert.equal(app.logins.length, 1);
  });

  await withApp("api", async ({ session, app }) => {
    await session.capture(`${app.base}/orders`, {});
    const stubbed = await session.capture(`${app.base}/orders`, { mockApi: [{ path: "/api/*", status: 401, json: { error: "stub" } }] });
    assert.equal(stubbed.title, "orders 401,401");
    assert.equal(stubbed.reloggedIn, undefined, "a 401 the call stubbed itself is not a dead session");
    assert.equal(app.logins.length, 1);
  });

  await withApp(
    "redirect",
    async ({ session, app }) => {
      await session.capture(`${app.base}/orders`, {});
      app.expire();
      const r = await session.capture(`${app.base}/orders`, {});
      assert.equal(r.title, "login");
      assert.equal(r.reloggedIn, undefined);
      assert.equal(app.logins.length, 1, "browser.autoRelogin: false turns it off");
    },
    { autoRelogin: false }
  );
});

test("loginAs: only that profile is signed in again, with its own login", async () => {
  await withApp("redirect", async ({ session, app }) => {
    await session.capture(`${app.base}/orders`, {});
    await session.capture(`${app.base}/orders`, { loginAs: "coach" });
    assert.deepEqual(app.logins, ["ada@example.test", "coach@example.test"]);

    app.expire();
    const coach = await session.capture(`${app.base}/orders`, { loginAs: "coach" });
    assert.equal(coach.reloggedIn, true);
    assert.equal(coach.signedInAs?.profile, "coach");
    assert.deepEqual(app.logins, ["ada@example.test", "coach@example.test", "coach@example.test"], "the default profile was left alone");
  });
});

test("a flow signs in again before its first step and runs its actions once", async () => {
  await withApp("api", async ({ session, app }) => {
    await session.capture(`${app.base}/orders`, {});
    app.expire();
    const flow = await session.runFlowDetailed(
      [{ label: "orders", url: `${app.base}/orders`, actions: [{ type: "click", selector: "#add" }], noScreenshot: true }],
      {}
    );
    assert.equal(flow.reloggedIn, true);
    assert.match(flow.reloginReason ?? "", /answered 401/);
    assert.equal(flow.steps.length, 1);
    assert.equal(flow.steps[0].error, undefined);
    assert.equal(flow.steps[0].title, "added 200");
    assert.equal(app.adds, 1, "the click ran once, on the signed-in page");
    assert.equal(app.logins.length, 2);

    // A flow that starts "on the current page" still reopens it after a re-login.
    app.expire();
    const reopened = await session.runFlowDetailed([{ label: "again", noScreenshot: true }], {});
    assert.equal(reopened.reloggedIn, true);
    assert.equal(reopened.steps[0].url, `${app.base}/orders`);
    assert.equal(reopened.steps[0].title, "orders 200,200");
  });
});

// ── through the MCP tool layer ────────────────────────────────────────────

test("check_page, capture_flow and inspect_rendered_page report reloggedIn through dispatch", async () => {
  const fx = await app("redirect");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-relogin-tool-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { vue: "^3" } }));
  const projectConfig = await loadConfig(root);
  const browserConfig = config(fx.base, path.join(root, "caps"));
  const ctx: ToolContext = {
    workspaceRoot: root,
    config: projectConfig,
    browserConfig,
    scanner: new ComponentScanner(root, projectConfig),
    parser: new PropParser(),
    cache: new CacheManager(),
    routeAnalyzer: new RouteAnalyzer(root, projectConfig),
    browser: new BrowserSession(root, browserConfig),
  };
  const call = async (tool: string, args: Record<string, unknown>) => {
    const res = (await dispatchToolCall(tool, args, ctx)) as { content: Array<{ text?: string }>; isError?: boolean };
    assert.ok(!res.isError, res.content[0].text);
    return JSON.parse(res.content[0].text!);
  };
  try {
    const live = await call("check_page", { url: "/orders" });
    assert.equal(live.reloggedIn, undefined);
    assert.equal("reloginReason" in live, false);

    fx.expire();
    const page = await call("check_page", { url: "/orders" });
    assert.equal(page.reloggedIn, true);
    assert.match(page.reloginReason, /ended on the login page/);
    assert.equal(page.title, "orders 200,200");

    fx.expire();
    const flow = await call("capture_flow", { steps: [{ url: "/orders", noScreenshot: true }] });
    assert.equal(flow.reloggedIn, true);
    assert.equal(flow.passed, true);

    fx.expire();
    const inspected = await call("inspect_rendered_page", { url: "/orders" });
    assert.equal(inspected.reloggedIn, true);
    assert.match(inspected.reloginReason, /ended on the login page/);
    const calm = await call("inspect_rendered_page", { url: "/orders" });
    assert.equal(calm.reloggedIn, undefined);
    assert.equal(fx.logins.length, 4);
  } finally {
    await ctx.browser.close();
    await fx.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
