import { test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { AddressInfo, Socket } from "net";
import { BrowserSession } from "./session.js";
import { toApiCalls } from "./actions.js";
import {
  BodyCapture,
  buildBody,
  compileBodyPatterns,
  MAX_BODY_CHARS,
  MAX_CALL_BODY_CHARS,
  shrinkJson,
} from "./captureBodies.js";
import type { BrowserConfig } from "../types.js";
import type { NetworkEntry } from "./types.js";
import { dispatchToolCall, type ToolContext } from "../server/dispatch.js";
import { loadConfig } from "../config/configLoader.js";
import { ComponentScanner } from "../scanner/componentScanner.js";
import { CacheManager } from "../cache/cacheManager.js";
import { RouteAnalyzer } from "../analyzer/routeAnalyzer.js";
import { PropParser } from "../parser/propParser.js";

/**
 * `apiCalls` lists status, bytes and a row count but never the response body,
 * so an agent that needed a mock shaped like the real response plus new
 * fields guessed the shape, and developers later found data bugs.
 * `captureBodies` (path patterns, per call, off by default) puts the body on
 * the matching call's entry — bounded, shortened structurally, redacted.
 */

const JWT = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: "u-1" })).toString("base64url")}.c2lnbmF0dXJl`;
const ORDERS = {
  total: 1578,
  items: Array.from({ length: 1578 }, (_, i) => ({ id: i, sku: `SKU-${i}`, lines: [{ club: "5i", qty: 1 }, { club: "6i", qty: 2 }] })),
};
const PAGE_2 = { total: 1578, items: [{ id: 9001, sku: "PAGE-2" }] };
const ME = { email: "ada@example.test", roles: ["admin"], accessToken: "opaque-secret-value", profile: { password: "hunter2", note: JWT } };
/** 35 chatty calls first, so the calls worth a body fall past the 30-call cap. */
const NOISE = 35;

const PAGE = `<!doctype html><title>loading</title><script>
(async () => {
  for (let i = 0; i < ${NOISE}; i++) await fetch("/api/n/" + i);
  for (const p of ["/api/orders", "/api/orders?page=2", "/api/me", "/api/text", "/api/img", "/api/small", "/api/small", "/api/empty"]) {
    await fetch(p).then((r) => r.arrayBuffer()).catch(() => {});
  }
  document.title = "done";
})();
</script>`;

interface Fixture { base: string; close: () => Promise<void> }

async function fixture(): Promise<Fixture> {
  const sockets = new Set<Socket>();
  const json = (res: http.ServerResponse, body: unknown) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const url = req.url || "/";
    if (url.startsWith("/api/n/")) return json(res, { n: url.slice(7) });
    if (url === "/api/orders") return json(res, ORDERS);
    if (url === "/api/orders?page=2") return json(res, PAGE_2);
    if (url === "/api/me") return json(res, ME);
    if (url === "/api/small") return json(res, { a: 1, nested: { b: [1, 2] } });
    if (url === "/api/text") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("plain words");
    }
    if (url === "/api/img") {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }
    if (url === "/api/empty") {
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

async function withSession(fn: (session: BrowserSession, base: string) => Promise<void>): Promise<void> {
  const fx = await fixture();
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-bodies-"));
  const session = new BrowserSession(out, { devServerUrl: fx.base, headless: true, outputDir: out } as BrowserConfig);
  try {
    await fn(session, fx.base);
  } finally {
    await session.close();
    await fx.close();
    await fs.rm(out, { recursive: true, force: true });
  }
}

test("without captureBodies nothing carries a body and the apiCalls list is what it was", async () => {
  await withSession(async (session, base) => {
    const r = await session.capture(`${base}/`, { requireAuth: false });
    assert.equal(r.title, "done");
    assert.equal(r.captureBodies, undefined);
    assert.ok(r.requests.every((q) => q.responseBody === undefined));
    const calls = toApiCalls(r.requests);
    assert.equal(calls.length, 30, "deduped by method + path and capped at 30, as before");
    assert.ok(calls.every((c) => !("responseBody" in c) && !("query" in c)));
    assert.ok(!calls.some((c) => c.path === "/api/small"), "the late call is past the cap (the case captureBodies must not lose)");
  });
});

test("a matching call carries its body: parsed JSON, shortened with truncated + original size, never lost to the cap", async () => {
  await withSession(async (session, base) => {
    const r = await session.capture(`${base}/`, {
      requireAuth: false,
      captureBodies: ["/api/small", "/api/orders", "GET /api/me", "/api/text", "/api/img", "/api/empty", "/api/never"],
    });
    const calls = toApiCalls(r.requests);
    const find = (p: string, query?: string) => calls.filter((c) => c.path === p && (query === undefined || (c.query ?? "") === query));

    // Small JSON: returned whole, parsed. Past the 30-call cap and requested twice — present once.
    const small = find("/api/small");
    assert.equal(small.length, 1, JSON.stringify(small));
    assert.deepEqual(small[0].responseBody, { json: { a: 1, nested: { b: [1, 2] } }, contentType: "application/json" });
    assert.equal(calls.filter((c) => !c.responseBody).length, 30, "calls without a body are still capped at 30");

    // Large JSON array: first rows kept, still valid JSON with the real shape.
    const orders = find("/api/orders", "")[0].responseBody!;
    assert.equal(orders.truncated, true);
    assert.equal(orders.originalBytes, Buffer.byteLength(JSON.stringify(ORDERS)));
    const kept = orders.json as typeof ORDERS;
    assert.equal(kept.total, 1578);
    assert.ok(kept.items.length >= 1 && kept.items.length <= 5, `first rows kept, got ${kept.items.length}`);
    assert.deepEqual(kept.items[0], ORDERS.items[0], "a kept row is whole, not cut mid-token");
    assert.ok(orders.truncation?.some((t) => /^\$\.items: kept \d of 1578 rows$/.test(t)), JSON.stringify(orders.truncation));
    assert.ok(JSON.stringify(orders.json).length <= MAX_BODY_CHARS);
    // The row count summary still describes the real response.
    assert.equal(find("/api/orders", "")[0].rowCount, 1578);

    // Same path, another query: its own entry.
    const page2 = find("/api/orders", "?page=2");
    assert.equal(page2.length, 1, JSON.stringify(calls.map((c) => c.path + (c.query ?? ""))));
    assert.deepEqual(page2[0].responseBody?.json, PAGE_2);

    // Credential-looking values are replaced; the shape stays.
    const me = find("/api/me")[0].responseBody!;
    assert.deepEqual(me.json, { email: "ada@example.test", roles: ["admin"], accessToken: "[redacted]", profile: { password: "[redacted]", note: "[redacted]" } });
    assert.equal(me.redacted, 3);
    assert.ok(!JSON.stringify(calls).includes("hunter2") && !JSON.stringify(calls).includes("opaque-secret-value") && !JSON.stringify(calls).includes(JWT));

    assert.deepEqual(find("/api/text")[0].responseBody, { text: "plain words", contentType: "text/plain" });
    assert.match(find("/api/img")[0].responseBody?.omitted ?? "", /binary content-type image\/png/);
    assert.match(find("/api/empty")[0].responseBody?.omitted ?? "", /empty response body|no response body/);
    assert.ok(calls.filter((c) => c.path.startsWith("/api/n/")).every((c) => c.responseBody === undefined), "unmatched calls carry nothing");

    const report = r.captureBodies!;
    assert.deepEqual(report.patterns.find((p) => p.pattern === "/api/small"), { pattern: "/api/small", matched: 2 });
    assert.equal(report.bodies, 5);
    assert.equal(report.truncated, 1);
    assert.deepEqual(report.unmatched, [{ pattern: "/api/never" }]);
    assert.match(report.warning ?? "", /1 pattern\(s\) matched no API call: \/api\/never/);
    assert.ok(report.chars <= MAX_CALL_BODY_CHARS);
  });
});

test("capture is per call: the next call without captureBodies carries no bodies", async () => {
  await withSession(async (session, base) => {
    await session.capture(`${base}/`, { requireAuth: false, captureBodies: ["**"] });
    const next = await session.capture(`${base}/`, { requireAuth: false });
    assert.ok(next.requests.every((q) => q.responseBody === undefined));
  });
});

test("the per-call total is bounded: later bodies are omitted with the reason", () => {
  const capture = new BodyCapture(compileBodyPatterns(["/api/big/*"]));
  const big = Buffer.from(JSON.stringify({ rows: Array.from({ length: 4 }, (_, i) => ({ i, text: "y".repeat(900) })) }));
  const entries: NetworkEntry[] = Array.from({ length: 30 }, (_, i) => ({
    url: `http://a/api/big/${i}`, method: "GET", resourceType: "fetch", status: 200,
  }));
  for (const e of entries) {
    assert.ok(capture.wants(e));
    // Distinct content per entry, so no two share a captured body.
    capture.record(e, Buffer.from(big.toString().replace('"i":0', `"i":${1000 + entries.indexOf(e)}`)), "application/json");
  }
  const kept = entries.filter((e) => e.responseBody && !e.responseBody.omitted);
  const omitted = entries.filter((e) => e.responseBody?.omitted);
  assert.ok(kept.length >= 5 && omitted.length >= 1, `${kept.length} kept, ${omitted.length} omitted`);
  const total = kept.reduce((n, e) => n + JSON.stringify(e.responseBody!.json ?? e.responseBody!.text).length, 0);
  assert.ok(total <= MAX_CALL_BODY_CHARS, `total ${total}`);
  assert.match(omitted[0].responseBody!.omitted!, /per-call (body budget \(48000 chars\) is used up|limit)/);
  assert.equal(toApiCalls(entries).length, 30, "every requested call is listed, with its body or the reason");
  assert.equal(capture.report(entries).chars, total);
});

test("shortening keeps valid JSON; text and unshortenable JSON are cut with truncated", () => {
  const wide = { rows: Array.from({ length: 400 }, (_, i) => ({ id: i, name: `n${i}`, blob: "z".repeat(3000) })) };
  const s = shrinkJson(wide, 2000);
  assert.ok(s.truncated && s.json !== undefined);
  assert.ok(JSON.stringify(s.json).length <= 2000);
  assert.ok(s.notes.some((n) => /\$\.rows: kept \d of 400 rows/.test(n)) && s.notes.some((n) => /\$\.rows\[\]\.blob: strings cut/.test(n)), JSON.stringify(s.notes));
  assert.deepEqual(Object.keys((s.json as typeof wide).rows[0]), ["id", "name", "blob"], "the row shape survives");

  const same = shrinkJson({ a: [1, 2, 3] }, 2000);
  assert.deepEqual(same, { json: { a: [1, 2, 3] }, truncated: false, notes: [] });

  const text = buildBody("w".repeat(5000), 5000, "text/plain", 1000);
  assert.deepEqual([text.text?.length, text.truncated, text.originalBytes], [1000, true, 5000]);

  const keys = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`key_${i}`, "v".repeat(59)]));
  const hard = buildBody(JSON.stringify(keys), 3000, "application/json", 600);
  assert.equal(hard.truncated, true);
  assert.equal(hard.json, undefined);
  assert.equal(hard.text?.length, 600);
  assert.ok(hard.truncation?.some((t) => /not parseable/.test(t)));
});

test("invalid captureBodies fails before the browser starts, naming the problem", async () => {
  assert.throws(() => compileBodyPatterns("/api/orders"), /captureBodies must be an array of path patterns/);
  assert.throws(() => compileBodyPatterns(["/ok", 7, "re:("]), (err: Error) =>
    /captureBodies\[1\] must be a path pattern \(string\)/.test(err.message) && /captureBodies\[2\]: invalid regex/.test(err.message));
  const [p] = compileBodyPatterns(["post **/orders/*"]);
  assert.equal(p.method, "POST");
  assert.ok(p.pathRe.test("/api/v1/orders/42"));
  await withSession(async (session, base) => {
    await assert.rejects(session.capture(`${base}/`, { requireAuth: false, captureBodies: true as any }), /captureBodies must be an array/);
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

test("check_page and capture_flow take captureBodies through dispatch; without it the result has no apiCalls bodies", async () => {
  const fx = await fixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-bodies-tool-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { vue: "^3" } }));
  const ctx = await toolContext(root, fx.base);
  type Res = { content: Array<{ text?: string }>; isError?: boolean };
  const call = async (tool: string, args: Record<string, unknown>) => {
    const res = (await dispatchToolCall(tool, args, ctx)) as Res;
    return { res, out: JSON.parse(res.content[0].text!) };
  };
  try {
    const plain = await call("check_page", { url: "/", public: true });
    assert.ok(!plain.res.isError, plain.res.content[0].text);
    assert.equal(plain.out.apiCalls, undefined, "check_page output is unchanged when captureBodies is absent");
    assert.equal(plain.out.captureBodies, undefined);

    const page = await call("check_page", { url: "/", public: true, captureBodies: ["/api/small", "/api/orders"] });
    assert.ok(!page.res.isError, page.res.content[0].text);
    const small = page.out.apiCalls.find((c: any) => c.path === "/api/small");
    assert.deepEqual(small.responseBody.json, { a: 1, nested: { b: [1, 2] } });
    const orders = page.out.apiCalls.find((c: any) => c.path === "/api/orders" && !c.query);
    assert.equal(orders.responseBody.truncated, true);
    assert.equal(page.out.captureBodies.bodies, 3, "small, orders, and orders?page=2 (a path pattern matches any query)");

    const flow = await call("capture_flow", { public: true, bodies: ["/api/me"], steps: [{ url: "/", noScreenshot: true }] });
    assert.ok(!flow.res.isError, flow.res.content[0].text);
    const me = flow.out.steps[0].apiCalls.find((c: any) => c.path === "/api/me");
    assert.equal(me.responseBody.json.email, "ada@example.test", "the `bodies` alias reaches capture_flow, per step");
    assert.equal(me.responseBody.json.accessToken, "[redacted]");
    assert.equal(flow.out.captureBodies.patterns[0].matched, 1);

    const plainFlow = await call("capture_flow", { public: true, steps: [{ url: "/", noScreenshot: true }] });
    assert.ok(plainFlow.out.steps[0].apiCalls.every((c: any) => c.responseBody === undefined));
    assert.equal(plainFlow.out.steps[0].apiCalls.length, 30);

    const bad = await call("check_page", { url: "/", public: true, captureBodies: "/api/small" });
    assert.ok(bad.res.isError);
    assert.match(bad.res.content[0].text!, /captureBodies must be an array of path patterns/);
  } finally {
    await ctx.browser.close();
    await fx.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
