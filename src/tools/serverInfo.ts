import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import type { ToolContext } from "../server/dispatch.js";
import { loadConfig } from "../config/configLoader.js";
import { ComponentScanner } from "../scanner/componentScanner.js";
import { RouteAnalyzer } from "../analyzer/routeAnalyzer.js";
import { ensureCatalog, countByLayer } from "./shared.js";
import { probeDevServer } from "../browser/preflight.js";
import { errMessage } from "../util.js";

const execFileAsync = promisify(execFile);

/** The atlas-ui install (repo) root: this module sits at <root>/<outDir>/tools/. */
const INSTALL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** The module the MCP process started from — its mtime is the build time. */
const SERVER_MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../server.js");
const PROCESS_STARTED = new Date(Date.now() - process.uptime() * 1000);

export interface ServerInfo {
  version: string;
  git: { sha: string; dirty: boolean; changedFiles: number } | null;
  build: { builtAt?: string; module: string; processStartedAt: string; stale?: string };
  workspaceRoot: string;
  config: {
    scanTargets: number;
    fallbackScan: boolean;
    routeFiles: string[];
    devServerUrl: string;
    idleIgnore?: string[];
  };
  catalog: {
    size: number;
    lastScanned: string;
    byLayer: Record<string, number>;
    coverageWarning?: string;
  };
  /** Directories under src/ holding source files the catalog does not index (empty = full coverage). */
  unscannedDirs: { dir: string; count: number }[];
  login: { configured: boolean; loggedIn: boolean; browserLaunched: boolean; error?: string; profiles?: string[] };
  devServer: { url: string; reachable: boolean; status?: number; title?: string; error?: string };
  refreshed?: { configReloaded: boolean; ms: number; error?: string };
}

/**
 * What code is answering, against what workspace, with what catalog — plus an
 * optional `refresh` that reloads the WHOLE config (scan targets, aliases,
 * routes, browser) and rescans, the in-session equivalent of a restart.
 */
export async function serverInfo(args: { refresh?: boolean }, ctx: ToolContext): Promise<ServerInfo> {
  let refreshed: ServerInfo["refreshed"];
  if (args.refresh) refreshed = await refresh(ctx);

  const [pkg, git, builtAt] = await Promise.all([readVersion(), gitState(), mtime(SERVER_MODULE)]);
  const catalog = await ensureCatalog(ctx.scanner, ctx.cache);
  const devServerUrl = ctx.browser.baseUrl;
  const probe = await probeDevServer(devServerUrl);

  const build: ServerInfo["build"] = {
    module: path.relative(INSTALL_ROOT, SERVER_MODULE),
    processStartedAt: PROCESS_STARTED.toISOString(),
    ...(builtAt ? { builtAt: builtAt.toISOString() } : {}),
  };
  if (builtAt && builtAt > PROCESS_STARTED) {
    build.stale =
      "The build on disk is newer than this server process — the running tools are the OLDER code. " +
      "Reconnect the MCP server (/mcp) to load the new build.";
  }

  return {
    version: pkg,
    git,
    build,
    workspaceRoot: ctx.workspaceRoot,
    config: {
      scanTargets: ctx.config.scanTargets?.length ?? 0,
      fallbackScan: ctx.config.fallbackScan !== false,
      routeFiles: ctx.config.routeFiles ?? [],
      devServerUrl,
      ...(ctx.browserConfig.idleIgnore?.length ? { idleIgnore: ctx.browserConfig.idleIgnore } : {}),
    },
    catalog: {
      size: catalog.totalCount,
      lastScanned: new Date(catalog.lastScanned).toISOString(),
      byLayer: countByLayer(catalog.components),
      ...(catalog.coverageWarning ? { coverageWarning: catalog.coverageWarning.message } : {}),
    },
    unscannedDirs: catalog.unscannedDirs ?? [],
    login: ctx.browser.loginState(),
    devServer: {
      url: probe.url,
      reachable: probe.reachable,
      ...(probe.status !== undefined ? { status: probe.status } : {}),
      ...(probe.title ? { title: probe.title } : {}),
      ...(probe.error ? { error: probe.error } : {}),
    },
    ...(refreshed ? { refreshed } : {}),
  };
}

/** Reload .atlas-ui.json + .env-derived config, rebuild scanner/route analyzer, rescan. */
async function refresh(ctx: ToolContext): Promise<NonNullable<ServerInfo["refreshed"]>> {
  const start = Date.now();
  try {
    const config = await loadConfig(ctx.workspaceRoot);
    ctx.config = config;
    ctx.browserConfig = config.browser || {};
    ctx.browser.updateConfig(ctx.browserConfig);
    ctx.scanner = new ComponentScanner(ctx.workspaceRoot, config);
    ctx.routeAnalyzer = new RouteAnalyzer(ctx.workspaceRoot, config);
    ctx.cache.invalidateCatalog();
    await ctx.restartWatcher?.();
    await ensureCatalog(ctx.scanner, ctx.cache);
    return { configReloaded: true, ms: Date.now() - start };
  } catch (err) {
    return { configReloaded: false, ms: Date.now() - start, error: errMessage(err) };
  }
}

async function readVersion(): Promise<string> {
  try {
    return JSON.parse(await fs.readFile(path.join(INSTALL_ROOT, "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
}

async function gitState(): Promise<ServerInfo["git"]> {
  try {
    const opts = { cwd: INSTALL_ROOT, timeout: 3_000 };
    const [{ stdout: sha }, { stdout: status }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "--short=12", "HEAD"], opts),
      execFileAsync("git", ["status", "--porcelain", "--untracked-files=no"], opts),
    ]);
    const changed = status.split("\n").filter((l) => l.trim()).length;
    return { sha: sha.trim(), dirty: changed > 0, changedFiles: changed };
  } catch {
    return null;
  }
}

async function mtime(file: string): Promise<Date | undefined> {
  try {
    return (await fs.stat(file)).mtime;
  } catch {
    return undefined;
  }
}
