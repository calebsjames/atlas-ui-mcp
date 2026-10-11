import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { dispatchToolCall, type ToolContext } from "../server/dispatch.js";
import { loadConfig } from "../config/configLoader.js";
import { ComponentScanner } from "../scanner/componentScanner.js";
import { CacheManager } from "../cache/cacheManager.js";
import { RouteAnalyzer } from "../analyzer/routeAnalyzer.js";
import { PropParser } from "../parser/propParser.js";
import { BrowserSession } from "../browser/session.js";

/**
 * F16: the server reported 3.0.0 for both the committed code and an
 * uncommitted build, static config was loaded once at startup with no way to
 * reload it, and agents asked for a refresh in 3 sessions. server_info says
 * which code is running and against what; refresh rescans and reloads the
 * whole config without a restart.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function context(root: string): Promise<ToolContext> {
  const config = await loadConfig(root);
  const browserConfig = { ...(config.browser || {}), devServerUrl: "http://127.0.0.1:9" };
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

async function call(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<any> {
  const res = (await dispatchToolCall(name, args, ctx)) as { content: { text: string }[]; isError?: boolean };
  assert.ok(!res.isError, res.content[0].text);
  return JSON.parse(res.content[0].text);
}

test("server_info reports version, build, workspace, catalog, login and dev-server state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-f16-"));
  try {
    await fs.mkdir(path.join(root, "src/services"), { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { vue: "^3" } }));
    await fs.writeFile(path.join(root, "src/services/aService.ts"), "export const aService = {};\n");
    const ctx = await context(root);
    const info = await call("server_info", {}, ctx);
    const pkg = JSON.parse(await fs.readFile(path.join(REPO, "package.json"), "utf8"));
    assert.equal(info.version, pkg.version);
    assert.equal(info.workspaceRoot, root);
    assert.match(info.git?.sha ?? "", /^[0-9a-f]{7,40}$/);
    assert.equal(typeof info.git?.dirty, "boolean");
    assert.ok(info.build?.builtAt, "dist build time");
    assert.equal(info.catalog.size, 1);
    assert.ok(info.catalog.lastScanned);
    assert.equal(info.login.configured, false);
    assert.equal(info.devServer.reachable, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("server_info refresh reloads the full config and rescans", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-f16r-"));
  try {
    await fs.mkdir(path.join(root, "src/services"), { recursive: true });
    await fs.mkdir(path.join(root, "src/extra"), { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { vue: "^3" } }));
    await fs.writeFile(path.join(root, ".atlas-ui.json"), JSON.stringify({ fallbackScan: false }));
    await fs.writeFile(path.join(root, "src/services/aService.ts"), "export const aService = {};\n");
    await fs.writeFile(path.join(root, "src/extra/helper.ts"), "export const helper = 1;\n");
    const ctx = await context(root);
    assert.equal((await call("server_info", {}, ctx)).catalog.size, 1);

    // Config edited after startup: the scanner must pick it up without a restart.
    await fs.writeFile(path.join(root, ".atlas-ui.json"), JSON.stringify({ fallbackScan: true }));
    const after = await call("server_info", { refresh: true }, ctx);
    assert.equal(after.refreshed?.configReloaded, true);
    assert.equal(after.catalog.size, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("tests build to their own outDir and never ship", async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(REPO, "package.json"), "utf8"));
  assert.doesNotMatch(pkg.scripts.test, /node --test dist/, "npm test must not rebuild/run the live dist/");
  const tsconfig = JSON.parse(await fs.readFile(path.join(REPO, "tsconfig.json"), "utf8"));
  assert.ok(
    (tsconfig.exclude || []).some((e: string) => e.includes(".test.")),
    "the production build excludes *.test.*"
  );
  assert.ok(pkg.files.some((f: string) => f.startsWith("!") && f.includes(".test.")), "npm files exclude tests");
});
