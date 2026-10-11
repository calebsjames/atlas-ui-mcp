import { test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { AddressInfo, Socket } from "net";
import { dispatchToolCall, type ToolContext } from "../server/dispatch.js";
import { loadConfig } from "../config/configLoader.js";
import { ComponentScanner } from "../scanner/componentScanner.js";
import { CacheManager } from "../cache/cacheManager.js";
import { RouteAnalyzer } from "../analyzer/routeAnalyzer.js";
import { PropParser } from "../parser/propParser.js";
import { BrowserSession } from "./session.js";
import type { BrowserConfig } from "../types.js";

/**
 * F14: runtime failures said "timeout" and nothing about the environment, so
 * agents made confident, wrong environment claims ("the stock Vite scaffold is
 * being served"). Runtime calls now preflight the dev server, and every
 * runtime error names what the dev server actually answered; a login failure
 * names the page it stopped on and leaves a screenshot.
 */

async function fixture(): Promise<{ base: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url?.startsWith("/login") ? "<!doctype html><title>Sign in</title><p>no form here</p>" : "<!doctype html><title>Fixture App</title>");
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

async function context(devServerUrl: string, extra: Partial<BrowserConfig> = {}): Promise<{ ctx: ToolContext; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-f14-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { vue: "^3" } }));
  const config = await loadConfig(root);
  const browserConfig = { ...config.browser, devServerUrl, headless: true, outputDir: path.join(root, "caps"), ...extra } as BrowserConfig;
  return {
    root,
    ctx: {
      workspaceRoot: root, config, browserConfig,
      scanner: new ComponentScanner(root, config), parser: new PropParser(), cache: new CacheManager(),
      routeAnalyzer: new RouteAnalyzer(root, config), browser: new BrowserSession(root, browserConfig),
    },
  };
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

test("an unreachable dev server fails fast, without launching a browser", async () => {
  const { ctx, root } = await context("http://127.0.0.1:9");
  try {
    const r = (await dispatchToolCall("check_page", { url: "/", public: true }, ctx)) as { isError?: boolean };
    assert.equal(r.isError, true, text(r));
    assert.match(text(r), /unreachable/);
    assert.match(text(r), /127\.0\.0\.1:9/);
    assert.equal(ctx.browser.loginState().browserLaunched, false);
  } finally {
    await ctx.browser.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a runtime error carries the dev server's status and <title>", async () => {
  const fx = await fixture();
  const { ctx, root } = await context(fx.base);
  try {
    const r = (await dispatchToolCall("render_component", { component: "NoSuchThing", public: true }, ctx)) as { isError?: boolean };
    assert.equal(r.isError, true);
    assert.match(text(r), /200 \\"Fixture App\\"|200 "Fixture App"/);
  } finally {
    await ctx.browser.close();
    await fx.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a login failure names the page it stopped on and leaves a screenshot", async () => {
  const fx = await fixture();
  const { ctx, root } = await context(fx.base, {
    login: { url: "/login", actions: [{ type: "waitFor", selector: "#email", timeoutMs: 500 }] },
  });
  try {
    const r = (await dispatchToolCall("check_page", { url: "/" }, ctx)) as { isError?: boolean };
    assert.equal(r.isError, true);
    const msg = text(r);
    assert.match(msg, /\/login/, msg);
    assert.match(msg, /Sign in/);
    assert.match(msg, /\.png/);
  } finally {
    await ctx.browser.close();
    await fx.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
