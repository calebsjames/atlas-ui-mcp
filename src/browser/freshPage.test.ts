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
 * F13: every call shared ONE page, so a flow step without a URL acted on
 * whatever the previous call left open — e.g. a full-screen overlay (the
 * "z-[110] interceptor" an agent hit) swallowing the next call's clicks.
 * Each top-level call now gets a fresh page in the same context; auth kept in
 * sessionStorage (per-tab) is carried over by seeding the new page.
 */

const PAGE = `<!doctype html><html><head><title>Fresh</title></head><body>
<button id="open" onclick="document.getElementById('overlay').style.display='block'">open overlay</button>
<button id="target" onclick="document.title='clicked'">target</button>
<div id="overlay" style="display:none;position:fixed;inset:0;z-index:110;background:rgba(0,0,0,.4)"></div>
<script>
  if (location.search.includes('set')) sessionStorage.setItem('tok', 'abc');
  document.body.dataset.tok = sessionStorage.getItem('tok') || '';
</script></body></html>`;

async function fixture(): Promise<{ base: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
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

async function withSession(fn: (s: BrowserSession, base: string) => Promise<void>): Promise<void> {
  const fx = await fixture();
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-f13-"));
  const session = new BrowserSession(out, { devServerUrl: fx.base, headless: true, outputDir: out } as BrowserConfig);
  try {
    await fn(session, fx.base);
  } finally {
    await session.close();
    await fx.close();
    await fs.rm(out, { recursive: true, force: true });
  }
}

test("each top-level call gets its own page", async () => {
  await withSession(async (session, base) => {
    const first = await session.withPage(async (p) => p, { requireAuth: false });
    const second = await session.withPage(async (p) => p, { requireAuth: false });
    assert.notEqual(first, second);
    assert.ok(first.isClosed(), "the previous call's page is closed");
    void base;
  });
});

test("an overlay left open by one call does not swallow the next call's clicks", async () => {
  await withSession(async (session, base) => {
    const steps1 = [{ label: "open", url: `${base}/`, actions: [{ type: "click", selector: "#open" }], noScreenshot: true }];
    await session.runFlow(steps1 as any, { requireAuth: false });
    const steps2 = [{ label: "act", actions: [{ type: "click", selector: "#target", timeoutMs: 2_000 }], noScreenshot: true }];
    const [r] = await session.runFlow(steps2 as any, { requireAuth: false });
    assert.equal(r.error, undefined, `click was intercepted: ${r.error}`);
    assert.equal(r.title, "clicked");
  });
});

test("sessionStorage (where the app keeps its token) carries into the next call's page", async () => {
  await withSession(async (session, base) => {
    await session.capture(`${base}/?set=1`, { requireAuth: false });
    const tok = await session.withPage(async (p) => {
      await p.goto(`${base}/`);
      return p.evaluate(() => document.body.dataset.tok);
    }, { requireAuth: false });
    assert.equal(tok, "abc");
  });
});
