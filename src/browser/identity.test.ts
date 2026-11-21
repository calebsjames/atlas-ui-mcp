import { test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { AddressInfo, Socket } from "net";
import { BrowserSession } from "./session.js";
import { extractIdentity, loginAccount, type StorageEntry } from "./identity.js";
import type { BrowserConfig } from "../types.js";
import { dispatchToolCall, type ToolContext } from "../server/dispatch.js";
import { loadConfig } from "../config/configLoader.js";
import { ComponentScanner } from "../scanner/componentScanner.js";
import { CacheManager } from "../cache/cacheManager.js";
import { RouteAnalyzer } from "../analyzer/routeAnalyzer.js";
import { PropParser } from "../parser/propParser.js";

/**
 * An agent saw different data than the owner's preview on the same route and
 * could not rule out a different account: the login env vars Studio injects
 * live only in atlas-ui's process, and nothing said who the browser was. Every
 * runtime result now carries `signedInAs` (the login email from config/env +
 * the app's own user, roles and impersonation, read from storage), and
 * server_info reports it per profile.
 */

const EMAIL = "ada@example.test";
const PASSWORD = "pw-Zq8-never-shown";
const jwt = (claims: object) =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2ln`;

const LOGIN = `<!doctype html><title>login</title>
<input id="email"><input id="password" type="password"><button id="go">Log in</button><script>
document.getElementById("go").onclick = () => {
  const as = new URLSearchParams(location.search).get("as");
  const email = as || document.getElementById("email").value;
  sessionStorage.setItem("app_user", JSON.stringify({ id: "u-1", email, firstName: "Ada", lastName: "Admin", roles: ["admin"] }));
  sessionStorage.setItem("app_token", ${JSON.stringify(jwt({ sub: "fu-1", email: EMAIL }))});
  location.href = "/home";
};
</script>`;
const HOME = `<!doctype html><title>home</title><button id="impersonate">View as coach</button><script>
document.getElementById("impersonate").onclick = () => {
  sessionStorage.setItem("app_impersonation_v1", JSON.stringify({
    version: 1, phase: "active",
    original: { token: "admin-token", userData: sessionStorage.getItem("app_user") },
    impersonation: { token: "coach-token", user: { id: "c-9", email: "coach@example.test", firstName: "Cody", lastName: "Coach", roles: ["fitter_coach"] } },
  }));
  document.title = "impersonating";
};
</script>`;

const loginFlow = (url: string) => ({
  url,
  actions: [
    { type: "fill", selector: "#email", text: "${ATLAS_ID_EMAIL}" },
    { type: "fill", selector: "#password", text: "${ATLAS_ID_PASSWORD}" },
    { type: "click", selector: "#go" },
  ],
  successUrlIncludes: "/home",
});

async function server(): Promise<{ base: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end((req.url || "/").startsWith("/landing") ? LOGIN : HOME);
  });
  srv.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => srv.close(() => r()));
    },
  };
}

function config(base: string, out: string): BrowserConfig {
  process.env.ATLAS_ID_EMAIL = EMAIL;
  process.env.ATLAS_ID_PASSWORD = PASSWORD;
  return {
    devServerUrl: base,
    headless: true,
    outputDir: out,
    login: loginFlow("/landing"),
    profiles: { other: loginFlow("/landing?as=someone.else@example.test") },
  } as unknown as BrowserConfig;
}

async function withSession(fn: (s: BrowserSession, base: string) => Promise<void>): Promise<void> {
  const fx = await server();
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-id-"));
  const session = new BrowserSession(out, config(fx.base, out));
  try {
    await fn(session, fx.base);
  } finally {
    await session.close();
    await fx.close();
    await fs.rm(out, { recursive: true, force: true });
  }
}

test("a runtime result names the login email and the app's own signed-in user", async () => {
  await withSession(async (session, base) => {
    const r = await session.capture(`${base}/home`, {});
    const who = r.signedInAs!;
    assert.equal(who.profile, "default");
    assert.equal(who.loggedIn, true);
    assert.equal(who.loginEmail, EMAIL);
    assert.equal(who.loginEmailFrom, "env ATLAS_ID_EMAIL");
    assert.deepEqual(who.app, { email: EMAIL, id: "u-1", name: "Ada Admin", roles: ["admin"], source: "sessionStorage.app_user" });
    assert.equal(who.impersonating, false);
    assert.equal(who.mismatch, undefined);
    assert.equal(who.alsoFound, undefined, "the JWT names the same person, so it is not listed again");
    assert.match(who.summary, /login: ada@example\.test \(env ATLAS_ID_EMAIL\); app user: ada@example\.test \[admin\]/);
    const text = JSON.stringify(who);
    assert.ok(!text.includes(PASSWORD), "the password never appears");
    assert.ok(!text.includes("eyJ"), "no token appears");
  });
});

test("impersonation stored by the app is reported with who is impersonated", async () => {
  await withSession(async (session, base) => {
    const flow = await session.runFlowDetailed(
      [{ label: "imp", url: `${base}/home`, actions: [{ type: "click", selector: "#impersonate" }], noScreenshot: true }],
      {}
    );
    const imp = flow.signedInAs.impersonating;
    assert.ok(imp, JSON.stringify(flow.signedInAs));
    assert.equal(imp.active, true);
    assert.equal(imp.phase, "active");
    assert.deepEqual(imp.as?.roles, ["fitter_coach"]);
    assert.equal(imp.as?.email, "coach@example.test");
    assert.equal(imp.original?.email, EMAIL, "the original user is read from a JSON-in-a-string snapshot");
    assert.match(flow.signedInAs.summary, /impersonating: coach@example\.test \[fitter_coach\]/);
    assert.ok(!JSON.stringify(flow.signedInAs).includes("coach-token"));
  });
});

test("an app user that is not the login email is flagged", async () => {
  await withSession(async (session, base) => {
    const r = await session.capture(`${base}/home`, { loginAs: "other" });
    assert.equal(r.signedInAs?.profile, "other");
    assert.equal(r.signedInAs?.app?.email, "someone.else@example.test");
    assert.equal(r.signedInAs?.mismatch, true);
    assert.match(r.signedInAs!.summary, /NOT the login email/);
  });
});

test("a public call says login was skipped and that no app user is signed in", async () => {
  await withSession(async (session, base) => {
    const r = await session.capture(`${base}/home`, { requireAuth: false });
    assert.equal(r.signedInAs?.loginSkipped, true);
    assert.equal(r.signedInAs?.loggedIn, false);
    assert.equal(r.signedInAs?.app, undefined);
    assert.match(r.signedInAs!.summary, /app user: none found in localStorage\/sessionStorage/);
  });
});

test("server_info and inspect_rendered_page report the account per profile", async () => {
  const fx = await server();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-id-tool-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { vue: "^3" } }));
  const cfg = await loadConfig(root);
  const browserConfig = config(fx.base, path.join(root, "caps"));
  const ctx: ToolContext = {
    workspaceRoot: root, config: cfg, browserConfig,
    scanner: new ComponentScanner(root, cfg), parser: new PropParser(), cache: new CacheManager(),
    routeAnalyzer: new RouteAnalyzer(root, cfg), browser: new BrowserSession(root, browserConfig),
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await dispatchToolCall(name, args, ctx)) as { content: Array<{ text?: string }>; isError?: boolean };
    assert.ok(!res.isError, res.content[0].text);
    return JSON.parse(res.content[0].text!);
  };
  try {
    const before = await call("server_info", {});
    assert.equal(before.login.account.loginEmail, EMAIL, "known from config/env before any browser call");
    assert.match(before.login.account.summary, /not read yet/);
    assert.equal(before.login.profiles[0].name, "other");
    assert.equal(before.login.profiles[0].account.loginEmail, EMAIL);

    const inspected = await call("inspect_rendered_page", { url: "/home" });
    assert.equal(inspected.signedInAs.app.email, EMAIL);

    const after = await call("server_info", {});
    assert.equal(after.login.loggedIn, true);
    assert.equal(after.login.account.app.email, EMAIL);
    assert.deepEqual(after.login.account.app.roles, ["admin"]);
    assert.ok(after.login.account.observedAt, "server_info dates the last read");
    assert.ok(!JSON.stringify(after).includes(PASSWORD));
  } finally {
    await ctx.browser.close();
    await fx.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("loginAccount: env-resolved email only; secrets never read; an unset var is named", () => {
  const login = (actions: any[]) => ({ url: "/l", actions });
  const env = { E: "x@y.test", P: "also@looks.like.email", U: "jdoe" };
  assert.deepEqual(
    loginAccount(login([{ type: "fill", selector: "#password", text: "${P}" }, { type: "fill", selector: "#email", text: "${E}" }]), env),
    { loginEmail: "x@y.test", loginEmailFrom: "env E" },
    "a password field is skipped even when its value looks like an email"
  );
  assert.deepEqual(loginAccount(login([{ type: "fill", selector: "#user", text: "${U}" }]), env), {}, "a non-email username is not reported");
  assert.deepEqual(loginAccount(login([{ type: "fill", selector: "#email", text: "${MISSING_EMAIL}" }]), env), {
    loginEmailFrom: "env MISSING_EMAIL — not set in atlas-ui's environment",
  });
  assert.deepEqual(loginAccount(login([{ type: "fill", selector: "#e", text: "demo@acme.dev" }]), env), {
    loginEmail: "demo@acme.dev",
    loginEmailFrom: "browser.login (literal)",
  });
  assert.deepEqual(loginAccount(undefined, env), {});
});

test("extractIdentity reads foreward-ui's storage shape", () => {
  const admin = { id: "e-1", email: "admin@x.test", firstName: "Al", lastName: "Admin", roles: ["admin"] };
  const entries: StorageEntry[] = [
    { area: "sessionStorage", key: "foreward_auth_token", value: jwt({ sub: "fu-1", email: "admin@x.test", roles: ["admin"] }) },
    { area: "sessionStorage", key: "foreward_user_data", value: JSON.stringify(admin) },
    {
      area: "sessionStorage",
      key: "foreward_impersonation_state_v1",
      value: JSON.stringify({
        version: 1,
        phase: "active",
        original: { token: "t1", userData: JSON.stringify(admin) },
        impersonation: { token: "t2", user: { id: "fa-7", email: "fitter@x.test", firstName: "Fi", lastName: "T", roles: ["fitter_coach"] } },
      }),
    },
    { area: "localStorage", key: "recentCustomers", value: JSON.stringify({ last: { id: "c-1", email: "golfer@x.test", name: "G", roles: ["customer"] } }) },
  ];
  const id = extractIdentity(entries);
  assert.equal(id.user?.email, "admin@x.test");
  assert.equal(id.user?.source, "sessionStorage.foreward_user_data");
  assert.deepEqual(id.alsoFound?.map((u) => u.email), ["golfer@x.test"], "the same admin in the JWT is not repeated");
  assert.ok(id.impersonating);
  assert.equal(id.impersonating.active, true);
  assert.equal(id.impersonating.as?.email, "fitter@x.test");
  assert.equal(id.impersonating.original?.email, "admin@x.test");

  const exiting = extractIdentity([{ ...entries[2], value: entries[2].value.replace('"phase":"active"', '"phase":"exiting"') }]);
  assert.ok(exiting.impersonating && exiting.impersonating.active === false && exiting.impersonating.phase === "exiting");
  assert.deepEqual(extractIdentity([]), { impersonating: false });
});
