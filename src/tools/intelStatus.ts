import fs from "fs/promises";
import path from "path";
import type { ProjectConfig, ScanTarget } from "../types.js";
import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { RouteAnalyzer } from "../analyzer/routeAnalyzer.js";
import type { BrowserSession } from "../browser/session.js";
import { countByLayer, ensureCatalog } from "./shared.js";
import { analyzeFileRoutes } from "../analyzer/fileRoutes.js";
import { matchesExclude, readPackageDeps } from "../util.js";

const DEFAULT_DEV_SERVER = "http://localhost:5173";
const REACHABILITY_TIMEOUT_MS = 1500;
const CANDIDATE_EXTENSIONS = [".tsx", ".jsx", ".vue"];
const EXCLUDED_DIRS = new Set([
  "node_modules", "dist", "build", ".next", ".nuxt", ".git", "coverage",
]);
const DEFAULT_EXCLUDES = ["node_modules", "dist", "build", "__tests__", "*.test.*", "*.spec.*"];

export interface FrameworkFlags {
  react: boolean;
  vue: boolean;
  next: boolean;
  nuxt: boolean;
}

export interface ScanTargetStatus {
  dir: string;
  type: string;
  exists: boolean;
  fileCount: number;
}

export interface RouteFileStatus {
  file: string;
  exists: boolean;
}

export interface IntelStatusResult {
  workspaceRoot: string;
  framework: FrameworkFlags;
  scanTargets: ScanTargetStatus[];
  catalog: {
    totalItems: number;
    byLayer: Record<string, number>;
    lastScanned: number;
  };
  routes: {
    routeFiles: RouteFileStatus[];
    totalRoutes: number;
    fileBasedRoutes: number;
  };
  browser: {
    devServerUrl: string;
    reachable: boolean;
    playwrightInstalled: boolean;
    headless: boolean;
    loginConfigured: boolean;
    authenticated: boolean;
    /** Last login pre-step failure, if any. Public routes work regardless. */
    loginError: string | null;
  };
  warnings: string[];
}

/**
 * The doctor for the whole pipeline. A mismatched project layout silently yields
 * an empty catalog, at which point every tool returns nothing and an agent
 * wrongly concludes the codebase has no components. This reports what was
 * detected at each stage — framework, scan targets, catalog, routes, browser —
 * and, crucially, emits actionable warnings (with candidate directories) when a
 * stage looks misconfigured.
 */
export async function intelStatus(
  config: ProjectConfig,
  workspaceRoot: string,
  scanner: ComponentScanner,
  cache: CacheManager,
  routeAnalyzer: RouteAnalyzer,
  browser: BrowserSession
): Promise<IntelStatusResult> {
  const deps = await readPackageDeps(workspaceRoot);
  const framework: FrameworkFlags = {
    react: "react" in deps,
    vue: "vue" in deps,
    next: "next" in deps,
    nuxt: "nuxt" in deps || "nuxt3" in deps || "nuxt-edge" in deps,
  };

  const excludes = config.exclude || DEFAULT_EXCLUDES;
  const scanTargets = await Promise.all(
    (config.scanTargets || []).map((target) => describeScanTarget(target, workspaceRoot, excludes))
  );

  const catalog = await ensureCatalog(scanner, cache);
  const byLayer = countByLayer(catalog.components);

  const routeFiles = await Promise.all(
    (config.routeFiles || []).map(async (file) => ({
      file,
      exists: await pathExists(path.join(workspaceRoot, file)),
    }))
  );
  const totalRoutes = (await routeAnalyzer.analyzeRoutes()).length;
  const fileBasedRoutes = (await analyzeFileRoutes(workspaceRoot)).length;

  const browserCfg = config.browser || {};
  const devServerUrl = browserCfg.devServerUrl || browser.baseUrl || DEFAULT_DEV_SERVER;
  const [reachable, playwrightInstalled] = await Promise.all([
    isReachable(devServerUrl),
    isPlaywrightInstalled(),
  ]);

  const warnings = await buildWarnings({
    workspaceRoot,
    catalogEmpty: catalog.totalCount === 0,
    reachable,
    playwrightInstalled,
    devServerUrl,
    totalRoutes,
    hasNextOrNuxt: framework.next || framework.nuxt,
    loginConfigured: !!config.browser?.login,
    loginError: browser.loginFailure,
  });

  return {
    workspaceRoot,
    framework,
    scanTargets,
    catalog: {
      totalItems: catalog.totalCount,
      byLayer,
      lastScanned: catalog.lastScanned,
    },
    routes: { routeFiles, totalRoutes, fileBasedRoutes },
    browser: {
      devServerUrl,
      reachable,
      playwrightInstalled,
      headless: browserCfg.headless !== false,
      loginConfigured: !!config.browser?.login,
      authenticated: browser.authenticated,
      loginError: browser.loginFailure,
    },
    warnings,
  };
}

async function describeScanTarget(
  target: ScanTarget,
  workspaceRoot: string,
  excludes: string[]
): Promise<ScanTargetStatus> {
  const dirAbs = path.join(workspaceRoot, target.dir);
  const exists = await pathExists(dirAbs);
  const fileCount = exists ? await countMatchingFiles(dirAbs, target.extensions, excludes) : 0;
  return { dir: target.dir, type: target.type, exists, fileCount };
}

/** Recursively count files matching the target extensions, honoring excludes. */
async function countMatchingFiles(
  dir: string,
  extensions: string[],
  excludes: string[]
): Promise<number> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let count = 0;
  for (const entry of entries) {
    if (matchesExclude(entry.name, excludes)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += await countMatchingFiles(full, extensions, excludes);
    } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      count += 1;
    }
  }
  return count;
}

/**
 * Compose the actionable warnings that make this tool worth calling. Each is a
 * single line naming the likely cause and the concrete next step.
 */
async function buildWarnings(ctx: {
  workspaceRoot: string;
  catalogEmpty: boolean;
  reachable: boolean;
  playwrightInstalled: boolean;
  devServerUrl: string;
  totalRoutes: number;
  hasNextOrNuxt: boolean;
  loginConfigured: boolean;
  loginError: string | null;
}): Promise<string[]> {
  const warnings: string[] = [];

  if (ctx.catalogEmpty) {
    const candidates = await findComponentDirs(ctx.workspaceRoot);
    if (candidates.length > 0) {
      const list = candidates.map((c) => `${c.dir} (${c.files})`).join(", ");
      warnings.push(
        `Catalog is empty — scanTargets are likely misconfigured. Directories with component files: ${list}. ` +
          "Point scanTargets at them in .atlas-ui.json."
      );
    } else {
      warnings.push(
        "Catalog is empty and no component files were found under src/ or app/. " +
          "Verify the workspace root and scanTargets in .atlas-ui.json."
      );
    }
  }

  if (!ctx.reachable) {
    warnings.push(
      `Dev server unreachable at ${ctx.devServerUrl} — browser tools (check_page/render_component/capture_flow) will fail. ` +
        "Start the dev server, or set browser.devServerUrl in .atlas-ui.json."
    );
  }

  if (!ctx.playwrightInstalled) {
    warnings.push(
      "Playwright is not installed — browser tools will fail. Run `npm install`, then " +
        "`npx playwright install chromium` in the atlas-ui server directory."
    );
  }

  if (ctx.loginConfigured && ctx.loginError) {
    warnings.push(
      `Login pre-step failed (${ctx.loginError}) — authed routes will fail until fixed. ` +
        "Correct browser.login/credentials and call reset_login to retry. " +
        'Public routes still work: pass "public": true on check_page/render_component/capture_flow.'
    );
  }

  if (ctx.totalRoutes === 0) {
    warnings.push(
      ctx.hasNextOrNuxt
        ? "No routes detected — ensure the app/ or pages/ directory exists so file-based routing resolves."
        : "No routes detected — set routeFiles in .atlas-ui.json to your router entry file(s)."
    );
  }

  return warnings;
}

/**
 * Walk one and two levels under src/ and app/ for directories that directly
 * contain component files, so an empty-catalog warning can name real candidates.
 */
async function findComponentDirs(
  workspaceRoot: string
): Promise<{ dir: string; files: number }[]> {
  const out: { dir: string; files: number }[] = [];
  for (const base of ["src", "app"]) {
    await collectComponentDirs(path.join(workspaceRoot, base), base, 2, out);
  }
  return out.sort((a, b) => b.files - a.files).slice(0, 12);
}

/** Depth-limited walk recording every directory that directly contains component files. */
async function collectComponentDirs(
  dirAbs: string,
  dirRel: string,
  depth: number,
  out: { dir: string; files: number }[]
): Promise<void> {
  const files = await directComponentCount(dirAbs);
  if (files > 0) out.push({ dir: dirRel, files });
  if (depth === 0) return;

  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || EXCLUDED_DIRS.has(entry.name)) continue;
    await collectComponentDirs(path.join(dirAbs, entry.name), `${dirRel}/${entry.name}`, depth - 1, out);
  }
}

/** Count component files directly inside a directory (non-recursive). */
async function directComponentCount(dir: string): Promise<number> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.isFile() && CANDIDATE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) count += 1;
  }
  return count;
}

/** HEAD then GET, each bounded by a short AbortController timeout. Any HTTP response means "up". */
async function isReachable(url: string): Promise<boolean> {
  for (const method of ["HEAD", "GET"] as const) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS);
    try {
      await fetch(url, { method, signal: controller.signal });
      return true;
    } catch {
      // Try the next method; a HEAD-rejecting server may still answer GET.
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

async function isPlaywrightInstalled(): Promise<boolean> {
  try {
    await import("playwright");
    return true;
  } catch {
    return false;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
