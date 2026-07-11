import fs from "fs/promises";
import path from "path";
import type { ScanCoverageWarning, ScanTarget } from "../types.js";
import { matchesExclude, readPackageDeps } from "../util.js";

/**
 * Scan-coverage check: after a scan, walk the workspace for UI source files
 * (.tsx/.jsx/.vue) that no scan target covers. Layout conventions are
 * unbounded, so defaults can never enumerate them all — but a scan that
 * cataloged 3 components while 80 sit in unscanned directories should say so
 * instead of presenting the near-empty catalog as the app. The warning names
 * the heaviest uncovered directories so the fix is a copy-paste scanTargets
 * entry, not an investigation.
 */

const UI_EXTENSIONS = [".tsx", ".jsx", ".vue"];

/** Never worth descending into, regardless of the project's exclude config. */
const ALWAYS_SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "coverage",
]);

/**
 * Next.js App Router special files are consumed by file-based route discovery
 * (see analyzer/fileRoutes.ts), not by scan targets — finding them outside a
 * target is expected, not a coverage gap.
 */
const NEXT_APP_SPECIAL_FILE =
  /^(page|layout|loading|error|global-error|not-found|template|default)\.(tsx|jsx)$/;

/** Cap the walk so a pathological workspace can't stall the scan. */
const MAX_VISITED_FILES = 50_000;

export interface CoverageCheckOptions {
  workspaceRoot: string;
  scanTargets: ScanTarget[];
  excludePatterns: string[];
  /** Files consumed outside scanTargets (root entry files, configured route files). */
  extraCoveredFiles: string[];
  /** How many UI-extension files the scan actually cataloged, for scale. */
  scannedUiFileCount: number;
}

/**
 * Returns a warning when uncovered UI files outweigh what the scan cataloged
 * (or when the scan cataloged nothing at all), undefined otherwise.
 */
export async function computeCoverageWarning(
  opts: CoverageCheckOptions
): Promise<ScanCoverageWarning | undefined> {
  const missed = await findUncoveredUiFiles(opts);
  const missedFileCount = missed.length;
  const { scannedUiFileCount } = opts;

  // Fire on an empty catalog with any UI files elsewhere, or when the misses
  // outweigh the hits — stay quiet when the targets caught the bulk of the app.
  const fires =
    scannedUiFileCount === 0
      ? missedFileCount > 0
      : missedFileCount >= 5 && missedFileCount > scannedUiFileCount;
  if (!fires) return undefined;

  // Aggregate at up to three path segments (src/app/components, not each of
  // its 30 subdirectories) so one deep subtree can't crowd every other missed
  // convention root out of the top-8 list.
  const byDir = new Map<string, number>();
  for (const rel of missed) {
    const dir = path.posix.dirname(rel).split("/").slice(0, 3).join("/");
    byDir.set(dir, (byDir.get(dir) || 0) + 1);
  }
  const uncoveredDirs = [...byDir.entries()]
    .map(([dir, count]) => ({ dir, count }))
    .sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir))
    .slice(0, 8);

  const dirList = uncoveredDirs
    .map(({ dir, count }) => `${dir} (${count})`)
    .join(", ");
  const message =
    `${missedFileCount} UI source files (.tsx/.jsx/.vue) are not covered by any scan target, ` +
    `while the catalog holds ${scannedUiFileCount} — the scan likely missed most of the app. ` +
    `Heaviest uncovered directories: ${dirList}. If these are part of the app, add matching ` +
    `scanTargets entries to .atlas-ui.json.`;

  return { missedFileCount, scannedUiFileCount, uncoveredDirs, message };
}

/**
 * Walk the workspace and collect posix-relative paths of UI files that no
 * scan target, extra covered file, or file-routing convention accounts for.
 */
async function findUncoveredUiFiles(opts: CoverageCheckOptions): Promise<string[]> {
  const { workspaceRoot, scanTargets, excludePatterns } = opts;
  const deps = await readPackageDeps(workspaceRoot);
  const hasNext = "next" in deps;
  const hasNuxt = "nuxt" in deps || "nuxt3" in deps || "nuxt-edge" in deps;

  const targets = scanTargets.map((t) => ({
    prefix: toPosix(t.dir).replace(/\/$/, "") + "/",
    extensions: t.extensions,
  }));
  const extraCovered = new Set(opts.extraCoveredFiles.map(toPosix));

  const missed: string[] = [];
  let visited = 0;
  const stack = [workspaceRoot];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (visited++ > MAX_VISITED_FILES) return missed;
      const name = entry.name;

      if (entry.isDirectory()) {
        if (name.startsWith(".")) continue; // .git, .next, .nuxt, .atlas-ui, ...
        if (ALWAYS_SKIP_DIRS.has(name)) continue;
        if (matchesExclude(name, excludePatterns)) continue;
        stack.push(path.join(dir, name));
        continue;
      }

      if (!entry.isFile()) continue;
      if (!UI_EXTENSIONS.some((ext) => name.endsWith(ext))) continue;
      if (matchesExclude(name, excludePatterns)) continue;

      const rel = toPosix(path.relative(workspaceRoot, path.join(dir, name)));
      if (extraCovered.has(rel)) continue;
      if (targets.some((t) => rel.startsWith(t.prefix) && t.extensions.some((e) => rel.endsWith(e)))) {
        continue;
      }
      if (isFileRoutingOwned(rel, name, hasNext, hasNuxt)) continue;

      missed.push(rel);
    }
  }

  return missed;
}

/**
 * Is this file consumed by file-based route discovery rather than scan
 * targets? Mirrors the directories analyzer/fileRoutes.ts walks: Next App
 * Router special files under app|src/app, everything routable under
 * pages|src/pages (Next routes all of it; Nuxt routes the .vue files).
 */
function isFileRoutingOwned(
  rel: string,
  baseName: string,
  hasNext: boolean,
  hasNuxt: boolean
): boolean {
  const underDir = (root: string) => rel.startsWith(root + "/");
  if (hasNext) {
    if ((underDir("app") || underDir("src/app")) && NEXT_APP_SPECIAL_FILE.test(baseName)) {
      return true;
    }
    if (underDir("pages") || underDir("src/pages")) return true;
  }
  if (hasNuxt && (underDir("pages") || underDir("src/pages")) && rel.endsWith(".vue")) {
    return true;
  }
  return false;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}
