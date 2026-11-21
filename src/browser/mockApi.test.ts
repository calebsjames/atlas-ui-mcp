import { test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { AddressInfo, Socket } from "net";
import { BrowserSession } from "./session.js";
import { compileMocks } from "./mockApi.js";
import type { BrowserConfig } from "../types.js";
import { dispatchToolCall, type ToolContext } from "../server/dispatch.js";
import { loadConfig } from "../config/configLoader.js";
import { ComponentScanner } from "../scanner/componentScanner.js";
import { CacheManager } from "../cache/cacheManager.js";
import { RouteAnalyzer } from "../analyzer/routeAnalyzer.js";
import { PropParser } from "../parser/propParser.js";

/**
 * Studio builds a screen before its server part exists. The agent could not
 * see the screen with data (GET /orders/catalog didn't exist; a new field
 * wasn't served), so developers finished those PRs by hand. `mockApi` stubs
 * matching requests for ONE call; everything else reaches the real API.
 *
 * The fixture is two origins, like the app and its API: the page fetches
 * cross-origin with an Authorization header, so the browser preflights — and
 * the API only knows /orders/real (no route, no preflight for /orders/catalog).
 */

interface Server { base: string; close: () => Promise<void>; hits: string[] }

async function listen(handler: http.RequestListener): Promise<Server> {
  const sockets = new Set<Socket>();
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    hits,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** The API: only /orders/real exists (CORS for it alone). */
async function api(): Promise<Server> {
  return listen((req, res) => {
    const origin = req.headers.origin ?? "*";
    const cors = { "access-control-allow-origin": origin, "access-control-allow-credentials": "true" };
    const p = (req.url || "/").split("?")[0];
    if (p === "/orders/real" && req.method === "OPTIONS") {
      res.writeHead(204, { ...cors, "access-control-allow-headers": "authorization", "access-control-allow-methods": "GET" });
      return res.end();
    }
    if (p === "/orders/real" && req.method === "GET") {
      res.writeHead(200, { ...cors, "content-type": "application/json" });
      return res.end(JSON.stringify({ real: true }));
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("no such route");
  });
}

/** The app: fetches both endpoints cross-origin and writes the outcome to the title. */
function appPage(apiBase: string): string {
  return `<!doctype html><title>loading</title><script>
  (async () => {
    const out = {};
    for (const p of ["/orders/catalog", "/orders/real"]) {
      try {
        const r = await fetch(${JSON.stringify(apiBase)} + p, { credentials: "include", headers: { Authorization: "Bearer t" } });
        out[p] = r.status + " " + (await r.text());
      } catch (e) { out[p] = "ERR " + e.message; }
    }
    document.title = JSON.stringify(out);
  })();
  </script>`;
}

async function withFixture(
  fn: (ctx: { session: BrowserSession; app: string; api: Server; out: string }) => Promise<void>,
  extra: Partial<BrowserConfig> = {}
): Promise<void> {
  const apiServer = await api();
  const appServer = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(appPage(apiServer.base));
  });
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-mock-"));
  const session = new BrowserSession(out, { devServerUrl: appServer.base, headless: true, outputDir: out, ...extra } as BrowserConfig);
  try {
    await fn({ session, app: appServer.base, api: apiServer, out });
  } finally {
    await session.close();
    await appServer.close();
    await apiServer.close();
    await fs.rm(out, { recursive: true, force: true });
  }
}

const results = (title: string): Record<string, string> => JSON.parse(title);

/** Fetch from the page the last call left open (the page the stubs were on). */
async function fetchOnLastPage(session: BrowserSession, url: string): Promise<string> {
  const page = (session as any).profiles.get("default").page;
  assert.ok(page && !page.isClosed(), "the last call's page is still open");
  return page.evaluate(async (u: string) => {
    const r = await fetch(u, { headers: { Authorization: "Bearer t" } }).catch((e: Error) => ({ status: "ERR " + e.message, text: async () => "" }));
    return `${r.status} ${await r.text()}`;
  }, url);
}

test("a stub answers the matching request; the rest reaches the real API", async () => {
  await withFixture(async ({ session, app, api }) => {
    const r = await session.capture(`${app}/`, {
      requireAuth: false,
      mockApi: [{ path: "/orders/catalog", json: { items: [{ id: 1, irons: ["5i", "6i"] }, { id: 2 }] } }],
    });
    const seen = results(r.title);
    assert.equal(seen["/orders/catalog"], `200 ${JSON.stringify({ items: [{ id: 1, irons: ["5i", "6i"] }, { id: 2 }] })}`);
    assert.equal(seen["/orders/real"], '200 {"real":true}', "an unstubbed call passes through");
    assert.ok(!api.hits.some((h) => h.startsWith("GET /orders/catalog")), "the stubbed GET never reached the API");

    const catalog = r.requests.find((q) => q.url.endsWith("/orders/catalog") && q.method === "GET");
    assert.equal(catalog?.mocked, true, "the stubbed request is marked mocked");
    assert.equal(catalog?.rowCount, 2, "the stub's body is summarized like a real one");
    const real = r.requests.find((q) => q.url.endsWith("/orders/real") && q.method === "GET");
    assert.equal(real?.mocked, undefined);
    assert.deepEqual(r.mockApi?.mocks, [{ method: "GET", path: "/orders/catalog", status: 200, hits: 1 }]);
    assert.equal(r.mockApi?.unmatched, undefined);
  });
});

test("stubs are removed when the call ends: same page and next call see the real API", async () => {
  await withFixture(async ({ session, app, api }) => {
    await session.capture(`${app}/`, { requireAuth: false, mockApi: [{ path: "/orders/catalog", json: [] }] });
    // The page the stub was installed on, still open after the call.
    const after = await fetchOnLastPage(session, `${api.base}/orders/catalog`);
    assert.doesNotMatch(after, /^200/, `the stub outlived its call: ${after}`);
    const next = await session.capture(`${app}/`, { requireAuth: false });
    assert.match(results(next.title)["/orders/catalog"], /^(404|ERR)/, "a later call without mockApi sees the real API");
  });
});

test("stubs are removed even when the call throws", async () => {
  // outputDir under a regular file: the screenshot step fails after the stubs are installed.
  const blocker = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "atlas-mock-block-")), "file");
  await fs.writeFile(blocker, "x");
  await withFixture(
    async ({ session, app, api }) => {
      await assert.rejects(
        session.capture(`${app}/`, { requireAuth: false, mockApi: [{ path: "/orders/catalog", json: [] }] }),
        /ENOTDIR|EEXIST|not a directory/i
      );
      const after = await fetchOnLastPage(session, `${api.base}/orders/catalog`);
      assert.doesNotMatch(after, /^200/, `the stub outlived a failed call: ${after}`);
    },
    { outputDir: path.join(blocker, "captures") }
  );
  await fs.rm(path.dirname(blocker), { recursive: true, force: true });
});

test("a stub that matches nothing is reported, with near misses", async () => {
  await withFixture(async ({ session, app }) => {
    const r = await session.capture(`${app}/`, {
      requireAuth: false,
      mockApi: [
        { path: "/v2/catalog", json: [] },
        { method: "POST", path: "/orders/real", json: {} },
        { path: "**/orders/real", query: { page: "2" }, json: {} },
      ],
    });
    const un = r.mockApi?.unmatched ?? [];
    assert.equal(un.length, 3, JSON.stringify(r.mockApi));
    assert.ok(un[0].nearMisses?.some((m) => m.startsWith("GET /orders/catalog")), JSON.stringify(un[0]));
    assert.ok(un[1].nearMisses?.some((m) => /GET \/orders\/real.*method differs/.test(m)), JSON.stringify(un[1]));
    assert.ok(un[2].nearMisses?.some((m) => /query differs/.test(m)), JSON.stringify(un[2]));
    assert.match(r.mockApi?.warning ?? "", /3 stub\(s\) matched no request/);
    assert.equal(results(r.title)["/orders/real"], '200 {"real":true}');
  });
});

test("capture_flow stubs span the flow, mark the step's apiCalls, and come off after", async () => {
  await withFixture(async ({ session, app, api }) => {
    const flow = await session.runFlowDetailed(
      [{ label: "load", url: `${app}/`, noScreenshot: true }, { label: "again", url: `${app}/?2`, noScreenshot: true }],
      { requireAuth: false, mockApi: [{ path: "/orders/catalog", status: 201, body: "stubbed" }] }
    );
    for (const step of flow.steps) {
      const call = step.apiCalls.find((c) => c.path === "/orders/catalog");
      assert.equal(call?.mocked, true, JSON.stringify(step.apiCalls));
      assert.equal(call?.status, 201);
      assert.equal(step.apiCalls.find((c) => c.path === "/orders/real")?.mocked, undefined);
    }
    assert.equal(flow.mockApi?.mocks[0].hits, 2);
    assert.equal(results(flow.steps[1].title)["/orders/catalog"], "201 stubbed");
    const after = await fetchOnLastPage(session, `${api.base}/orders/catalog`);
    assert.doesNotMatch(after, /^201/, `the flow's stub outlived the flow: ${after}`);
  });
});

test("path forms: exact, glob, **, re:, full URL and ?query", () => {
  const m = (p: string, extra = {}) => compileMocks([{ path: p, ...extra }])[0];
  const hit = (c: ReturnType<typeof m>, url: string) => c.pathRe.test(new URL(url).pathname) && (!c.origin || new URL(url).origin === c.origin);
  assert.ok(hit(m("/orders/catalog"), "http://a/orders/catalog/"), "trailing slash ignored");
  assert.ok(hit(m("/Orders/Catalog"), "http://a/orders/catalog"), "case-insensitive");
  assert.ok(!hit(m("/orders/catalog"), "http://a/api/orders/catalog"), "exact is anchored");
  assert.ok(hit(m("**/orders/catalog"), "http://a/api/v1/orders/catalog"));
  assert.ok(hit(m("**/orders/catalog"), "http://a/orders/catalog"));
  assert.ok(!hit(m("**/orders/catalog"), "http://a/xorders/catalog"));
  assert.ok(hit(m("/orders/*"), "http://a/orders/42"));
  assert.ok(!hit(m("/orders/*"), "http://a/orders/42/items"));
  assert.ok(hit(m("re:^/orders/\\d+$"), "http://a/orders/42"));
  const full = m("http://api:5001/orders?status=open");
  assert.equal(full.origin, "http://api:5001");
  assert.deepEqual(full.query, [["status", "open"]]);
  assert.ok(!hit(full, "http://other:5001/orders"), "a full URL pins the origin");
});

test("invalid stubs fail with every problem named, unknown keys with a did-you-mean", () => {
  assert.throws(
    () => compileMocks([{ url: "/x", response: { a: 1 } }, { path: "/y", json: 1, body: "b", status: 99 }, { path: "/z", method: "FETCH" }]),
    (err: Error) =>
      /mockApi\[0\]: unknown key "url" — did you mean "path"\?/.test(err.message) &&
      /unknown key "response" — did you mean "json"\?/.test(err.message) &&
      /mockApi\[0\]: "path" \(string\) is required/.test(err.message) &&
      /mockApi\[1\]: status must be an integer/.test(err.message) &&
      /mockApi\[1\]: give "json" or "body", not both/.test(err.message) &&
      /mockApi\[2\]: method "FETCH"/.test(err.message)
  );
  assert.throws(() => compileMocks({ path: "/x" }), /must be an array/);
});

test("a single stub object instead of a list is an error, not silently ignored", async () => {
  await withFixture(async ({ session, app }) => {
    await assert.rejects(
      session.capture(`${app}/`, { requireAuth: false, mockApi: { path: "/orders/catalog" } as any }),
      /mockApi must be an array/
    );
  });
});

// ── through the MCP tool layer ────────────────────────────────────────────

async function toolContext(root: string, devServerUrl: string): Promise<ToolContext> {
  const config = await loadConfig(root);
  const browserConfig = { devServerUrl, headless: true, outputDir: path.join(root, "caps") } as BrowserConfig;
  return {
    workspaceRoot: root,
    config,
    browserConfig,
    scanner: new ComponentScanner(root, config),
    parser: new PropParser(),
    cache: new CacheManager(),
    routeAnalyzer: new RouteAnalyzer(root, config),
    browser: new BrowserSession(root, browserConfig),
  };
}

test("check_page and capture_flow take mockApi (and its alias) through dispatch", async () => {
  const apiServer = await api();
  const appServer = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(appPage(apiServer.base));
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-mock-tool-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { vue: "^3" } }));
  const ctx = await toolContext(root, appServer.base);
  try {
    const res = (await dispatchToolCall(
      "check_page",
      { url: "/", public: true, mockApi: [{ path: "/orders/catalog", json: { data: [1, 2, 3] } }] },
      ctx
    )) as { content: Array<{ text?: string }>; isError?: boolean };
    assert.ok(!res.isError, res.content[0].text);
    const out = JSON.parse(res.content[0].text!);
    assert.equal(out.mockApi.mocks[0].hits, 1);
    const call = out.apiCalls.find((c: any) => c.path === "/orders/catalog");
    assert.deepEqual([call.mocked, call.status, call.rowCount], [true, 200, 3]);
    assert.ok(out.signedInAs, "every runtime result says who the browser was signed in as");

    const flow = (await dispatchToolCall(
      "capture_flow",
      { public: true, mocks: [{ path: "/orders/catalog", json: [] }], steps: [{ url: "/", noScreenshot: true }] },
      ctx
    )) as { content: Array<{ text?: string }>; isError?: boolean };
    assert.ok(!flow.isError, flow.content[0].text);
    const f = JSON.parse(flow.content[0].text!);
    assert.equal(f.mockApi.mocks[0].hits, 1, "the `mocks` alias reaches capture_flow");
    assert.equal(f.steps[0].apiCalls.find((c: any) => c.path === "/orders/catalog").mocked, true);

    const bad = (await dispatchToolCall("check_page", { url: "/", public: true, mockApi: [{ pth: "/x" }] }, ctx)) as {
      content: Array<{ text?: string }>;
      isError?: boolean;
    };
    assert.ok(bad.isError);
    assert.match(bad.content[0].text!, /unknown key \\?"pth\\?" — did you mean \\?"path\\?"/);
  } finally {
    await ctx.browser.close();
    await appServer.close();
    await apiServer.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify_data_flow and render_component take mockApi: the stubbed call is matched and marked", async () => {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ dependencies: { vue: "^3.5.0", "vue-router": "^4" } }),
    "src/router/index.ts":
      `import { createRouter, createWebHistory } from "vue-router";\n` +
      `import CatalogPage from "@/views/CatalogPage.vue";\n` +
      `export default createRouter({ history: createWebHistory(), routes: [{ path: "/catalog", component: CatalogPage }] });\n`,
    "src/views/CatalogPage.vue":
      `<template><ul></ul></template>\n<script setup lang="ts">\nimport { onMounted } from "vue";\n` +
      `import { CatalogService } from "@/services/catalogService";\nonMounted(() => CatalogService.list());\n</script>\n`,
    "src/services/catalogService.ts":
      `export class CatalogService {\n  static async list() {\n    const r = await fetch("/orders/catalog");\n    return r.json();\n  }\n}\n`,
  };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-mock-vdf-"));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
  // The dev server renders the page; it has no /orders/catalog (404), like a server part not built yet.
  const app = await listen((req, res) => {
    if ((req.url || "").startsWith("/orders/")) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>catalog</title><script>fetch("/orders/catalog")</script>`);
  });
  const ctx = await toolContext(root, app.base);
  const run = async (args: Record<string, unknown>) => {
    const res = (await dispatchToolCall("verify_data_flow", { name: "CatalogPage", ...args }, ctx)) as {
      content: Array<{ text?: string }>;
      isError?: boolean;
    };
    assert.ok(!res.isError, res.content[0].text);
    return JSON.parse(res.content[0].text!);
  };
  try {
    const real = await run({});
    const realCall = real.matchedSample.find((c: any) => c.url.endsWith("/orders/catalog"));
    assert.equal(realCall?.status, 404, JSON.stringify(real));
    assert.equal(realCall.mocked, undefined);

    const stubbed = await run({ mockApi: [{ path: "/orders/catalog", json: [{ id: 1 }] }] });
    assert.equal(stubbed.verdict, "confirmed", JSON.stringify(stubbed));
    const call = stubbed.matchedSample.find((c: any) => c.url.endsWith("/orders/catalog"));
    assert.deepEqual([call?.status, call?.mocked, call?.rowCount], [200, true, 1]);
    assert.equal(stubbed.mockApi.mocks[0].hits, 1);

    const rendered = (await dispatchToolCall(
      "render_component",
      { component: "CatalogPage", mockApi: [{ path: "/orders/catalog", json: [] }] },
      ctx
    )) as { content: Array<{ text?: string }>; isError?: boolean };
    assert.ok(!rendered.isError, rendered.content[0].text);
    const r = JSON.parse(rendered.content[0].text!);
    assert.equal(r.apiCalls.find((c: any) => c.path === "/orders/catalog")?.mocked, true, "render_component takes mockApi too");
    assert.ok(r.signedInAs);
  } finally {
    await ctx.browser.close();
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
