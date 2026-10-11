import { test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { AddressInfo, Socket } from "net";
import { BrowserSession } from "./session.js";
import type { BrowserConfig } from "../types.js";

/**
 * F11: the runtime tools had one fixed viewport, one login, and an action
 * set without scroll / wait / measure. Agents fell back to hand-rolled
 * Playwright scripts — once logging in with CI credentials without asking —
 * to check a breakpoint, another role, or an element's box.
 */

const LOGIN = `<!doctype html><title>login</title><input id="user"><button id="go"
  onclick="sessionStorage.setItem('who', document.getElementById('user').value); location.href='/whoami'">go</button>`;
const WHOAMI = `<!doctype html><title>?</title><script>document.title = sessionStorage.getItem('who') || 'anon';</script>`;
const SIZE = `<!doctype html><title>?</title><body style="margin:0">
<div id="box" style="position:absolute;top:900px;left:10px;width:200px;height:50px"></div>
<div style="height:3000px"></div><script>document.title = 'w' + innerWidth;</script></body>`;

async function fixture(): Promise<{ base: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    const u = req.url || "/";
    res.writeHead(200, { "content-type": "text/html" });
    res.end(u.startsWith("/login") ? LOGIN : u.startsWith("/whoami") ? WHOAMI : SIZE);
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const loginAs = (envVar: string) => ({
  url: "/login",
  actions: [
    { type: "fill", selector: "#user", text: `\${${envVar}}` },
    { type: "click", selector: "#go" },
  ],
  successUrlIncludes: "/whoami",
});

async function withSession(fn: (s: BrowserSession, base: string) => Promise<void>): Promise<void> {
  const fx = await fixture();
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-f11-"));
  process.env.ATLAS_TEST_ADMIN_USER = "admin";
  process.env.ATLAS_TEST_COACH_USER = "coach";
  const config = {
    devServerUrl: fx.base,
    headless: true,
    outputDir: out,
    login: loginAs("ATLAS_TEST_ADMIN_USER"),
    profiles: { coach: loginAs("ATLAS_TEST_COACH_USER") },
  } as unknown as BrowserConfig;
  const session = new BrowserSession(out, config);
  try {
    await fn(session, fx.base);
  } finally {
    await session.close();
    await fx.close();
    await fs.rm(out, { recursive: true, force: true });
  }
}

test("a per-call viewport applies to that call only", async () => {
  await withSession(async (session, base) => {
    const narrow = await session.capture(`${base}/size`, { requireAuth: false, viewport: { width: 375, height: 700 } } as any);
    assert.equal(narrow.title, "w375");
    const normal = await session.capture(`${base}/size`, { requireAuth: false });
    assert.equal(normal.title, "w1280", "the default viewport is back for the next call");
  });
});

test("scroll, wait and a read-only measure run as actions", async () => {
  await withSession(async (session, base) => {
    const steps = [{
      label: "measure",
      url: `${base}/size`,
      actions: [
        { type: "scroll", y: 600 },
        { type: "wait", ms: 50 },
        { type: "measure", selector: "#box", properties: ["position"] },
      ],
      noScreenshot: true,
    }];
    const [r] = (await session.runFlow(steps as any, { requireAuth: false })) as any[];
    assert.equal(r.error, undefined, r.error);
    const m = r.measurements?.[0];
    assert.ok(m, "the step reports its measurements");
    assert.equal(m.count, 1);
    assert.equal(m.elements[0].width, 200);
    assert.equal(m.elements[0].styles.position, "absolute");
    assert.ok(m.page.scrollY >= 600, `scrollY ${m.page.scrollY}`);
  });
});

test("loginAs picks a browser.profiles login in its own context", async () => {
  await withSession(async (session, base) => {
    const admin = await session.capture(`${base}/whoami`, {});
    assert.equal(admin.title, "admin");
    const coach = await session.capture(`${base}/whoami`, { loginAs: "coach" } as any);
    assert.equal(coach.title, "coach");
    const adminAgain = await session.capture(`${base}/whoami`, {});
    assert.equal(adminAgain.title, "admin", "profiles do not share storage");
  });
});

test("an unknown loginAs lists the configured profiles", async () => {
  await withSession(async (session, base) => {
    await assert.rejects(
      session.capture(`${base}/whoami`, { loginAs: "nobody" } as any),
      /nobody.*coach/s
    );
  });
});
