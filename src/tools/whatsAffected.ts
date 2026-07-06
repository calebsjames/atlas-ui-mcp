import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { RouteAnalyzer } from "../analyzer/routeAnalyzer.js";
import type { BrowserConfig, Component } from "../types.js";
import { ensureCatalog } from "./shared.js";
import { getRouteMap } from "./getRouteMap.js";

const execFileAsync = promisify(execFile);

/** Source file extensions worth tracing; everything else is ignored. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".vue"];
/** Upstream traversal depth cap; distance 1 = a direct importer/renderer. */
const MAX_DEPTH = 5;
/** Default page size for affected items so the payload stays compact. */
const DEFAULT_MAX_ITEMS = 100;
/** Hard ceiling on a single page even when maxItems asks for more. */
const HARD_MAX_ITEMS = 500;
/** Ceiling on suggested check hints. */
const MAX_SUGGESTED_CHECKS = 10;
const DEFAULT_DEV_SERVER = "http://localhost:5173";

export interface ChangedFileEntry {
  file: string;
  inCatalog: boolean;
  name?: string;
  layer?: string;
  note?: string;
}

export interface AffectedItem {
  name: string;
  layer: string;
  relativePath: string;
  /** 0 = the changed item itself, 1 = a direct user, and so on. */
  distance: number;
  /** Which changed file this item traces back to (multi-file attribution). */
  seed?: string;
  /** The immediate downstream dependency that links this item into the graph. */
  via?: string;
}

export interface AffectedRoute {
  path: string;
  component: string;
  url: string;
  isProtected: boolean;
  /** How isProtected was determined; "unknown" = an unparsable global guard exists. */
  protection?: string;
  dynamicSegments?: string[];
}

export interface WhatsAffectedResult {
  changedFiles: ChangedFileEntry[];
  affectedItems: AffectedItem[];
  affectedRoutes: AffectedRoute[];
  suggestedChecks: string[];
  notes: string[];
  /** Set when this page doesn't cover all affected items (see notes for paging). */
  truncated?: boolean;
  /** Total affected items before offset/maxItems slicing. */
  totalAffected?: number;
  /** Set when the app root (src/App.*, src/main.*) is in the affected set —
   *  impact can surface on ANY route, not just affectedRoutes. */
  rootAffected?: boolean;
}

export interface WhatsAffectedError {
  error: string;
  details?: string;
}

/**
 * The edit -> verify glue: given a set of changed files (or auto-detected via
 * `git status`), walk UPSTREAM through the catalog to every component that
 * imports, renders, or hook-consumes them, resolve which routes those changes
 * surface on, and hand back ready-to-run browser checks. Lets an agent close
 * the loop on a change without re-deriving the dependency graph by hand.
 */
export async function whatsAffected(
  args: { files?: string[]; offset?: number; maxItems?: number; maxDistance?: number },
  scanner: ComponentScanner,
  cache: CacheManager,
  routeAnalyzer: RouteAnalyzer,
  workspaceRoot: string,
  browserConfig: BrowserConfig
): Promise<WhatsAffectedResult | WhatsAffectedError> {
  let files = args.files?.filter((f) => f.trim().length > 0) ?? [];
  let autoDetected = false;

  const offset = Math.max(0, Math.floor(args.offset ?? 0));
  const maxItems = Math.min(HARD_MAX_ITEMS, Math.max(1, Math.floor(args.maxItems ?? DEFAULT_MAX_ITEMS)));
  const maxDistance = Math.min(MAX_DEPTH, Math.max(1, Math.floor(args.maxDistance ?? MAX_DEPTH)));

  if (files.length === 0) {
    try {
      // `-uall` enumerates untracked files individually instead of collapsing a
      // new directory into one entry, so freshly-added components are captured.
      const { stdout } = await execFileAsync("git", ["status", "--porcelain", "-uall"], {
        cwd: workspaceRoot,
        maxBuffer: 10 * 1024 * 1024,
      });
      files = parseGitStatus(stdout);
      autoDetected = true;
    } catch (err) {
      return {
        error:
          "Could not run `git status` to auto-detect changed files. Pass `files` " +
          "explicitly as workspace-relative paths (e.g. src/components/Foo.tsx).",
        details: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const normalized = [
    ...new Set(files.map((f) => normalizeToRelative(f, workspaceRoot)).filter(isSourceFile)),
  ];

  if (normalized.length === 0) {
    return {
      changedFiles: [],
      affectedItems: [],
      affectedRoutes: [],
      suggestedChecks: [],
      notes: [
        autoDetected
          ? "No changed source files detected by `git status` (clean tree, or only non-source files changed). Pass `files` to analyze specific paths."
          : "No source files provided. Pass `files` with workspace-relative paths.",
      ],
    };
  }

  const catalog = await ensureCatalog(scanner, cache);
  const byRelPath = new Map<string, Component>();
  const hookUsers = new Map<string, Component[]>();
  for (const component of catalog.components) {
    byRelPath.set(toForwardSlashes(component.relativePath), component);
    for (const hook of component.hooks || []) {
      const key = hook.toLowerCase();
      const list = hookUsers.get(key);
      if (list) list.push(component);
      else hookUsers.set(key, [component]);
    }
  }

  const notes: string[] = [];
  if (autoDetected) {
    notes.push(`Auto-detected ${normalized.length} changed source file(s) from git status.`);
  }

  const changedFiles: ChangedFileEntry[] = [];
  const seeds: Component[] = [];
  for (const rel of normalized) {
    const item = byRelPath.get(rel);
    if (item) {
      changedFiles.push({ file: rel, inCatalog: true, name: item.name, layer: item.architectureLayer });
      seeds.push(item);
    } else {
      changedFiles.push({ file: rel, inCatalog: false, note: await noteForUnmatched(rel, workspaceRoot) });
    }
  }

  const visited = bfsUpstream(seeds, cache, hookUsers, maxDistance);

  const affectedAll = [...visited.values()].sort(
    (a, b) => a.distance - b.distance || a.item.name.localeCompare(b.item.name)
  );
  const totalAffected = affectedAll.length;
  const page = affectedAll.slice(offset, offset + maxItems);
  const truncated = totalAffected > offset + page.length || offset > 0;
  const affectedItems: AffectedItem[] = page.map((v) => ({
    name: v.item.name,
    layer: v.item.architectureLayer,
    relativePath: v.item.relativePath,
    distance: v.distance,
    ...(v.seed && v.distance > 0 ? { seed: v.seed.name } : {}),
    ...(v.parent && v.distance > 1 ? { via: v.parent.name } : {}),
  }));

  const rootHit = affectedAll.find((v) => v.item.architectureLayer === "root");
  if (rootHit) {
    notes.push(
      `${rootHit.item.relativePath} (app root) is in the affected set` +
        (rootHit.distance > 0 ? ` via ${rootHit.seed?.name ?? "a changed file"}` : "") +
        " — the root hosts app-global UI (modals, toast hosts, panels), so impact can surface on ANY route, not just affectedRoutes."
    );
  }

  const affectedRoutes = await resolveAffectedRoutes(
    visited,
    routeAnalyzer,
    scanner,
    cache,
    browserConfig.devServerUrl || DEFAULT_DEV_SERVER
  );

  if (affectedRoutes.some((r) => r.protection === "unknown")) {
    notes.push(
      "A global router guard (beforeEach) exists but couldn't be statically parsed — " +
        "isProtected may under-report on routes marked protection: \"unknown\"."
    );
  }

  const suggestedChecks = buildSuggestedChecks(affectedRoutes, browserConfig);

  if (affectedRoutes.length === 0) {
    const nearestPage = affectedAll.find((v) => v.item.architectureLayer === "page");
    if (nearestPage) {
      const hint = `verify_data_flow ${JSON.stringify({ name: nearestPage.item.name })}`;
      if (suggestedChecks.length < MAX_SUGGESTED_CHECKS) suggestedChecks.push(hint);
      notes.push(
        `No changed file maps directly to a route. Nearest affected page is ${nearestPage.item.name}; ` +
          "verify it with verify_data_flow, or check the hooks/services it consumes."
      );
    } else {
      notes.push(
        "No affected routes or pages found — the change lives in shared code (hook/service/component). " +
          "Verify a page that consumes it via verify_data_flow."
      );
    }
  }

  if (truncated) {
    const from = offset + 1;
    const to = offset + page.length;
    notes.push(
      `affectedItems ${from}-${to} of ${totalAffected} shown. ` +
        `Pass offset=${to} for the next page, maxItems (≤${HARD_MAX_ITEMS}) for a bigger page, ` +
        `or maxDistance to narrow the walk.`
    );
  }

  return {
    changedFiles,
    affectedItems,
    affectedRoutes,
    suggestedChecks,
    notes,
    ...(truncated ? { truncated, totalAffected } : {}),
    ...(rootHit ? { rootAffected: true } : {}),
  };
}

/**
 * Breadth-first walk from the changed items to everything that depends on them,
 * following importers, JSX renderers (both by real name and fileAlias), and —
 * for hooks — the components whose `hooks` list references them. Keyed by
 * relativePath so shared nodes are visited once, at their shortest distance.
 */
interface VisitedNode {
  item: Component;
  distance: number;
  /** The changed file this node traces back to (first one to reach it). */
  seed?: Component;
  /** The immediate downstream node whose edge pulled this one in. */
  parent?: Component;
}

function bfsUpstream(
  seeds: Component[],
  cache: CacheManager,
  hookUsers: Map<string, Component[]>,
  maxDistance: number = MAX_DEPTH
): Map<string, VisitedNode> {
  const visited = new Map<string, VisitedNode>();
  const queue: VisitedNode[] = [];

  for (const seed of seeds) {
    const key = toForwardSlashes(seed.relativePath);
    if (!visited.has(key)) {
      const node: VisitedNode = { item: seed, distance: 0, seed };
      visited.set(key, node);
      queue.push(node);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.distance >= maxDistance) continue;

    for (const user of upstreamUsers(current.item, cache, hookUsers)) {
      const key = toForwardSlashes(user.relativePath);
      if (visited.has(key)) continue;
      const next: VisitedNode = {
        item: user,
        distance: current.distance + 1,
        seed: current.seed,
        parent: current.item,
      };
      visited.set(key, next);
      queue.push(next);
    }
  }

  return visited;
}

/** Components that import, render, or hook-consume the given item. */
function upstreamUsers(
  item: Component,
  cache: CacheManager,
  hookUsers: Map<string, Component[]>
): Component[] {
  const names = [item.name];
  if (item.fileAlias) names.push(item.fileAlias);

  const users: Component[] = [];
  for (const name of names) {
    users.push(...cache.getImportersOf(name));
    users.push(...cache.getRenderersOf(name));
  }

  // Path-keyed importers: catches files that import only a NAMED export
  // (e.g. `updateClockOffset` from useTokenRefreshTimer) — the name-keyed
  // lookup above misses those entirely and skews distances.
  users.push(...cache.getImportersOfFile(item.relativePath));

  if (item.architectureLayer === "hook" || item.name.startsWith("use")) {
    for (const name of names) {
      users.push(...(hookUsers.get(name.toLowerCase()) || []));
    }
  }

  return users;
}

/**
 * Map the affected components onto routes: a route is affected when its
 * component name (or fileAlias) matches an affected item, or when the route's
 * resolved page file is itself in the affected set. Each route is turned into a
 * concrete dev-server URL with `:params` left in place.
 */
async function resolveAffectedRoutes(
  visited: Map<string, VisitedNode>,
  routeAnalyzer: RouteAnalyzer,
  scanner: ComponentScanner,
  cache: CacheManager,
  devServerUrl: string
): Promise<AffectedRoute[]> {
  const affectedNames = new Set<string>();
  const affectedRelPaths = new Set<string>();
  for (const { item } of visited.values()) {
    affectedNames.add(item.name.toLowerCase());
    if (item.fileAlias) affectedNames.add(item.fileAlias.toLowerCase());
    affectedRelPaths.add(toForwardSlashes(item.relativePath));
  }

  const routeMap = await getRouteMap(routeAnalyzer, scanner, cache);
  const routes: AffectedRoute[] = [];
  const seen = new Set<string>();

  for (const route of routeMap) {
    const nameMatch = affectedNames.has(route.component.toLowerCase());
    const relPath = route.componentDetails
      ? toForwardSlashes(route.componentDetails.relativePath)
      : undefined;
    const pathMatch = relPath ? affectedRelPaths.has(relPath) : false;
    if (!nameMatch && !pathMatch) continue;

    const key = `${route.path}:${route.component}`;
    if (seen.has(key)) continue;
    seen.add(key);

    routes.push({
      path: route.path,
      component: route.component,
      url: buildUrl(devServerUrl, route.path),
      isProtected: route.isProtected,
      ...(route.protection ? { protection: route.protection } : {}),
      ...(route.dynamicSegments?.length ? { dynamicSegments: route.dynamicSegments } : {}),
    });
  }

  return routes;
}

/** Ready-to-paste verification hints, one per affected route, deduped and capped. */
function buildSuggestedChecks(routes: AffectedRoute[], browserConfig: BrowserConfig): string[] {
  const checks: string[] = [];
  const seen = new Set<string>();
  const defaults = browserConfig.routeParams || {};

  for (const route of routes) {
    let hint: string;
    if (route.dynamicSegments?.length) {
      // Fill params from configured routeParams defaults so the suggestion is
      // runnable as-is; "<value>" marks the ones that still need input.
      const params = Object.fromEntries(
        route.dynamicSegments
          .filter((s) => s !== "*")
          .map((s) => [s, defaults[s] ?? "<value>"])
      );
      hint = `render_component ${JSON.stringify({ component: route.component, params })}`;
    } else {
      hint = `check_page ${JSON.stringify({ url: route.path })}`;
    }
    if (seen.has(hint)) continue;
    seen.add(hint);
    checks.push(hint);
    if (checks.length >= MAX_SUGGESTED_CHECKS) break;
  }

  return checks;
}

/**
 * Parse `git status --porcelain` output into workspace-relative paths, taking
 * the new path for renames and skipping deletions (a deleted file can't be
 * rendered or resolved in the catalog).
 */
function parseGitStatus(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const x = line[0];
    const y = line[1];
    if (x === "D" || y === "D") continue;

    let pathPart = line.slice(3);
    if (pathPart.includes(" -> ")) {
      pathPart = pathPart.slice(pathPart.indexOf(" -> ") + 4);
    }
    pathPart = pathPart.trim();
    if (pathPart.startsWith('"') && pathPart.endsWith('"')) {
      pathPart = pathPart.slice(1, -1);
    }
    if (pathPart) paths.push(pathPart);
  }
  return paths;
}

/** Normalize a user- or git-supplied path to a workspace-relative, forward-slash path. */
function normalizeToRelative(file: string, workspaceRoot: string): string {
  const rel = path.isAbsolute(file) ? path.relative(workspaceRoot, file) : file;
  return toForwardSlashes(rel);
}

function toForwardSlashes(p: string): string {
  return p.split(path.sep).join("/");
}

function isSourceFile(rel: string): boolean {
  if (/(^|\/)(node_modules|dist|build)\//.test(rel)) return false;
  return SOURCE_EXTENSIONS.some((ext) => rel.endsWith(ext));
}

/** Classify why a changed file isn't in the catalog, to guide the agent. */
async function noteForUnmatched(rel: string, workspaceRoot: string): Promise<string> {
  const base = rel.split("/").pop() || rel;

  if (/\.(spec|test)\./.test(base) || /(^|\/)(tests?|__tests__)\//.test(rel)) {
    return "test file — excluded from the catalog by design; pass the source file it tests to trace impact";
  }

  try {
    await fs.access(path.join(workspaceRoot, rel));
  } catch {
    return "file not found in the workspace — check the path";
  }

  if (/^(index|_app|_document)\.(t|j)sx?$/.test(base)) {
    return "entry/root file — not scanned as a catalog item";
  }
  if (rel.includes("/router/") || /router\.(t|j)s$/.test(base)) {
    return "route definition file — not a catalog item; its routes surface via affectedRoutes";
  }
  return "not in catalog — likely outside configured scanTargets (see .atlas-ui.json)";
}

/** Join a dev-server base with a route path, preserving `:params`. */
function buildUrl(base: string, routePath: string): string {
  const trimmed = base.replace(/\/$/, "");
  const suffix = routePath.startsWith("/") ? routePath : `/${routePath}`;
  return trimmed + suffix;
}
