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
 * F2 regression: an app that holds a long-lived `fetch` with
 * `Accept: text/event-stream` (foreward-ui's realtime client) never lets
 * Playwright's `networkidle` settle, so every navigation burned the full 30 s
 * goto timeout. The fixture serves exactly that shape: an SSE stream that never
 * closes, a slow-ish API call the page renders from, and an un-closing
 * long-poll for the idleIgnore case.
 */

const PAGE = `<!doctype html><html><head><title>SSE fixture</title></head><body>
<div id="app">loading</div>
<script>
  fetch('/realtime/stream?topics=x', { headers: { Accept: 'text/event-stream' } })
    .then((r) => { const rd = r.body.getReader(); const pump = () => rd.read().then((x) => { if (!x.done) pump(); }); pump(); });
  fetch('/api/data').then((r) => r.json()).then((d) => {
    document.getElementById('app').textContent = 'rows:' + d.items.length;
  });
  if (location.search.includes('poll')) fetch('/api/poll');
</script></body></html>`;

async function startFixture(): Promise<{ base: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();
  const server = http.createServer((req, res) => {
    const url = req.url || "/";
    if (url === "/" || url.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);
      return;
    }
    if (url.startsWith("/realtime/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": open\n\n");
      const t = setInterval(() => res.write(": ping\n\n"), 400);
      timers.add(t);
      req.on("close", () => clearInterval(t));
      return;
    }
    if (url === "/api/data") {
      const t = setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ items: [1, 2, 3] }));
      }, 300);
      timers.add(t);
      return;
    }
    if (url === "/api/poll") {
      // A long-poll the server holds open far past any sane wait.
      const t = setTimeout(() => res.end("{}"), 60_000);
      timers.add(t);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const t of timers) clearTimeout(t);
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function withSession(
  extra: Record<string, unknown>,
  fn: (session: BrowserSession, base: string) => Promise<void>
): Promise<void> {
  const fixture = await startFixture();
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-f2-"));
  const config = { devServerUrl: fixture.base, headless: true, outputDir: out, ...extra } as BrowserConfig;
  const session = new BrowserSession(out, config);
  try {
    await fn(session, fixture.base);
  } finally {
    await session.close();
    await fixture.close();
    await fs.rm(out, { recursive: true, force: true });
  }
}

test("default navigation does not wait on an open SSE stream, but does wait for the page's API call", async () => {
  await withSession({}, async (session, base) => {
    const result = await session.capture(`${base}/`, { label: "sse" });
    const navIssues = result.pageErrors.filter((e) => e.includes("Navigation issue"));
    assert.deepEqual(navIssues, [], `navigation stalled: ${navIssues.join(" | ")}`);
    assert.ok(result.durationMs < 15_000, `took ${result.durationMs}ms`);
    const data = result.requests.find((r) => r.url.endsWith("/api/data"));
    assert.equal(data?.status, 200, "the quiet window should cover the page's own API call");
  });
});

test("capture_flow steps honour waitUntil, and a stalled wait names the requests still in flight", async () => {
  await withSession({ navigationTimeoutMs: 2_000 }, async (session, base) => {
    const steps = [{ label: "idle", url: `${base}/`, waitUntil: "networkidle" }] as any;
    const [step] = await session.runFlow(steps, { requireAuth: false });
    assert.ok(step.error, "networkidle cannot settle while the stream is open");
    assert.match(step.error!, /networkidle/);
    assert.match(step.error!, /\/realtime\/stream/, "the error should list what was still in flight");
  });
});

test("browser.idleIgnore excludes a matching long-poll from the quiet window", async () => {
  await withSession({ idleIgnore: ["/api/poll"] }, async (session, base) => {
    const result = await session.capture(`${base}/?poll=1`, { label: "poll" });
    const navIssues = result.pageErrors.filter((e) => e.includes("Navigation issue"));
    assert.deepEqual(navIssues, []);
    assert.ok(result.durationMs < 6_000, `took ${result.durationMs}ms — the ignored poll held the wait`);
  });
});
