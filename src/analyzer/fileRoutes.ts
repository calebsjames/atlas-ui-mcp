import fs from "fs/promises";
import path from "path";
import type { RouteEntry } from "../types.js";

/**
 * File-based routing analyzer for frameworks that derive routes from the
 * filesystem rather than a route config object (Next.js App/Pages Router,
 * Nuxt pages). The route map is the spine of every browser tool, so a Next/Nuxt
 * app that emits zero routes leaves those tools blind. This closes that gap by
 * mapping page files to `RouteEntry` records with the same segment/dynamic
 * semantics as the AST-based RouteAnalyzer.
 *
 * Component names are a best-effort read of the file's default export, falling
 * back to a PascalCase name derived from the route path (e.g.
 * `app/users/[id]/page.tsx` -> "UsersIdPage"). `isProtected` is always false:
 * auth wrapping is not statically knowable from the filesystem layout.
 */
export async function analyzeFileRoutes(workspaceRoot: string): Promise<RouteEntry[]> {
  const deps = await readPackageDeps(workspaceRoot);
  const routes: RouteEntry[] = [];

  if ("next" in deps) {
    // App Router lives in app/ or src/app/; Pages Router in pages/ or src/pages/.
    for (const appDir of ["app", "src/app"]) {
      await walkAppRouter(path.join(workspaceRoot, appDir), [], undefined, routes);
    }
    for (const pagesDir of ["pages", "src/pages"]) {
      await walkFlatRoutes(path.join(workspaceRoot, pagesDir), [], routes, NEXT_PAGES_OPTIONS);
    }
  }

  if ("nuxt" in deps || "nuxt3" in deps || "nuxt-edge" in deps) {
    // Nuxt keeps pages at the project root by default; support src/ layouts too.
    for (const pagesDir of ["pages", "src/pages"]) {
      await walkFlatRoutes(path.join(workspaceRoot, pagesDir), [], routes, NUXT_PAGES_OPTIONS);
    }
  }

  return dedupeRoutes(routes);
}

/** Directories never worth descending into during a route walk. */
const EXCLUDED_DIRS = new Set([
  "node_modules", "dist", "build", ".next", ".nuxt", ".git", "coverage",
]);

/** Default-export names too generic to be useful; trigger the path-derived fallback. */
const GENERIC_EXPORT_NAMES = new Set([
  "Page", "Layout", "Default", "Component", "Index", "default",
]);

const PAGE_FILE = /^page\.(tsx|jsx|ts|js)$/;
const LAYOUT_FILE = /^layout\.(tsx|jsx|ts|js)$/;

interface FlatRouteOptions {
  /** Extensions that count as a routable page file. */
  extensions: string[];
  /** File basenames (sans extension) to skip, e.g. Next's `_app`. */
  skipBaseNames: Set<string>;
  /** Directory names to skip at the pages root, e.g. Next's `api`. */
  skipRootDirNames: Set<string>;
}

const NEXT_PAGES_OPTIONS: FlatRouteOptions = {
  extensions: [".tsx", ".jsx", ".ts", ".js"],
  skipBaseNames: new Set(["_app", "_document", "_error"]),
  skipRootDirNames: new Set(["api"]),
};

const NUXT_PAGES_OPTIONS: FlatRouteOptions = {
  extensions: [".vue"],
  skipBaseNames: new Set(),
  skipRootDirNames: new Set(),
};

/**
 * Recursively walk a Next.js App Router tree. Each `page.*` maps its directory
 * path to a route; the nearest ancestor `layout.*` (including the page's own
 * directory) supplies `parentLayout`. Route groups `(group)` contribute a layout
 * but are dropped from the URL.
 */
async function walkAppRouter(
  dir: string,
  rawSegments: string[],
  parentLayout: string | undefined,
  routes: RouteEntry[]
): Promise<void> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  let layout = parentLayout;
  const layoutFile = entries.find((e) => e.isFile() && LAYOUT_FILE.test(e.name));
  if (layoutFile) {
    const parsed = await readDefaultExportName(path.join(dir, layoutFile.name));
    layout = parsed ?? deriveLayoutName(rawSegments);
  }

  const pageFile = entries.find((e) => e.isFile() && PAGE_FILE.test(e.name));
  if (pageFile) {
    const routePath = toRoutePath(rawSegments);
    const parsed = await readDefaultExportName(path.join(dir, pageFile.name));
    const component = parsed ?? deriveComponentName(rawSegments);
    routes.push(makeRoute(routePath, component, layout));
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || EXCLUDED_DIRS.has(entry.name)) continue;
    // Route groups `(marketing)` and parallel-route slots `@modal` never appear
    // in the URL; groups still pass their layout down.
    const isGroup = entry.name.startsWith("(") && entry.name.endsWith(")");
    if (entry.name.startsWith("@")) continue;
    const nextSegments = isGroup ? rawSegments : [...rawSegments, entry.name];
    await walkAppRouter(path.join(dir, entry.name), nextSegments, layout, routes);
  }
}

/**
 * Recursively walk a flat file-per-route tree (Next Pages Router, Nuxt pages).
 * `index` files map to their directory; every other file adds its basename as a
 * segment. Dynamic `[param]` / catch-all `[...slug]` segments use the shared
 * segment transform.
 */
async function walkFlatRoutes(
  dir: string,
  rawSegments: string[],
  routes: RouteEntry[],
  opts: FlatRouteOptions
): Promise<void> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isFile()) {
      const ext = opts.extensions.find((e) => entry.name.endsWith(e));
      if (!ext) continue;
      const base = entry.name.slice(0, -ext.length);
      if (opts.skipBaseNames.has(base)) continue;
      if (/\.(test|spec|d)$/.test(base)) continue;

      const fileSegments = base === "index" ? [] : [base];
      const allRaw = [...rawSegments, ...fileSegments];
      const routePath = toRoutePath(allRaw);
      const parsed = await readDefaultExportName(path.join(dir, entry.name));
      const component = parsed ?? deriveComponentName(allRaw);
      routes.push(makeRoute(routePath, component, undefined));
    } else if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      if (rawSegments.length === 0 && opts.skipRootDirNames.has(entry.name)) continue;
      await walkFlatRoutes(path.join(dir, entry.name), [...rawSegments, entry.name], routes, opts);
    }
  }
}

/**
 * Map a single filesystem segment to its URL form:
 * `[[...slug]]` / `[...slug]` -> `*`, `[param]` -> `:param`,
 * `(group)` -> dropped (null). Static names pass through unchanged.
 */
function transformSegment(name: string): string | null {
  if (name.startsWith("(") && name.endsWith(")")) return null;
  if (name.startsWith("[[...") && name.endsWith("]]")) return "*";
  if (name.startsWith("[...") && name.endsWith("]")) return "*";
  if (name.startsWith("[") && name.endsWith("]")) return ":" + name.slice(1, -1);
  return name;
}

/** Join raw filesystem segments into a leading-slash URL path. */
function toRoutePath(rawSegments: string[]): string {
  const parts = rawSegments
    .map(transformSegment)
    .filter((s): s is string => s !== null);
  return parts.length === 0 ? "/" : "/" + parts.join("/");
}

/** Build a RouteEntry with dynamic-segment metadata matching RouteAnalyzer. */
function makeRoute(routePath: string, component: string, parentLayout?: string): RouteEntry {
  const dynamicSegments = extractDynamicSegments(routePath);
  return {
    path: routePath,
    component,
    isProtected: false,
    parentLayout,
    isDynamic: dynamicSegments.length > 0,
    dynamicSegments: dynamicSegments.length > 0 ? dynamicSegments : undefined,
  };
}

/** Extract `:param` names (and `*` for catch-alls) from a route path. */
function extractDynamicSegments(routePath: string): string[] {
  const segments = [...routePath.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1]);
  if (routePath.includes("*")) segments.push("*");
  return segments;
}

const DEFAULT_FN_EXPORT = /export\s+default\s+(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/;
const DEFAULT_CLASS_EXPORT = /export\s+default\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/;
const DEFAULT_IDENT_EXPORT = /export\s+default\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/;

/**
 * Light regex read of a file's default-exported component name. Vue SFCs report
 * the `name` from `defineComponent`/`export default {}`; TS/JS files report the
 * default function/class/identifier. Generic names ("Page", "Layout", ...) are
 * rejected so the caller can derive a distinct name from the path instead.
 */
async function readDefaultExportName(filePath: string): Promise<string | null> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  if (filePath.endsWith(".vue")) {
    const define = content.match(
      /defineComponent\s*\(\s*\{[\s\S]*?name\s*:\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/
    );
    if (define) return define[1];
    const obj = content.match(
      /export\s+default\s*\{[\s\S]*?name\s*:\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/
    );
    return obj ? obj[1] : null;
  }

  for (const pattern of [DEFAULT_FN_EXPORT, DEFAULT_CLASS_EXPORT, DEFAULT_IDENT_EXPORT]) {
    const match = content.match(pattern);
    if (match && !GENERIC_EXPORT_NAMES.has(match[1])) return match[1];
  }
  return null;
}

/** PascalCase a single raw segment, stripping brackets/dots and separators. */
function toPascalCase(raw: string): string {
  return raw
    .replace(/[[\]().]/g, "")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

/** Path-derived page name, e.g. ["users","[id]"] -> "UsersIdPage". */
function deriveComponentName(rawSegments: string[]): string {
  const base = rawSegments.map(toPascalCase).join("");
  return (base || "Home") + "Page";
}

/** Path-derived layout name, e.g. ["dashboard"] -> "DashboardLayout". */
function deriveLayoutName(rawSegments: string[]): string {
  const base = rawSegments.map(toPascalCase).join("");
  return (base || "Root") + "Layout";
}

/** Drop routes sharing an identical path + component pair. */
function dedupeRoutes(routes: RouteEntry[]): RouteEntry[] {
  const seen = new Set<string>();
  return routes.filter((route) => {
    const key = `${route.path}:${route.component}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Read merged dependencies + devDependencies from the workspace package.json. */
async function readPackageDeps(workspaceRoot: string): Promise<Record<string, string>> {
  try {
    const content = await fs.readFile(path.join(workspaceRoot, "package.json"), "utf-8");
    const pkg = JSON.parse(content);
    return { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return {};
  }
}
