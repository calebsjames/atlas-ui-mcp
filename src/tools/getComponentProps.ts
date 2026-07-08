import fs from "fs/promises";
import path from "path";
import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { PropParser } from "../parser/propParser.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { AmbiguousMatch, ComponentProps } from "../types.js";
import {
  ensureCatalog,
  isAmbiguousMatch,
  nameNotFound,
  resolveByName,
  type NameNotFound,
} from "./shared.js";

/**
 * Parse the props of a component identified either by `componentPath` (a path
 * relative to the workspace root, or absolute) or by catalog `name` (optionally
 * disambiguated with `file`). Results are content-hash cached so repeated calls
 * on an unchanged file skip re-parsing.
 *
 * Returns an AmbiguousMatch when a name resolves to multiple files, or an
 * `{ error }` object when the file can't be read or parsed — never a bare
 * `null`, so the caller always learns why a lookup failed.
 */
export async function getComponentProps(
  args: { componentPath?: string; name?: string; file?: string },
  workspaceRoot: string,
  parser: PropParser,
  cache: CacheManager,
  scanner: ComponentScanner
): Promise<ComponentProps | AmbiguousMatch | NameNotFound | { error: string }> {
  if (args.componentPath) {
    const fullPath = path.isAbsolute(args.componentPath)
      ? args.componentPath
      : path.join(workspaceRoot, args.componentPath);
    return parseProps(
      fullPath,
      args.componentPath,
      " — path is relative to the workspace root",
      parser,
      cache
    );
  }

  if (args.name) {
    await ensureCatalog(scanner, cache);
    const resolved = resolveByName(cache.getByName(args.name), args.name, args.file);
    if (resolved === null) return nameNotFound(args.name, cache);
    if (isAmbiguousMatch(resolved)) return resolved;
    return parseProps(resolved.path, resolved.relativePath, "", parser, cache);
  }

  throw new Error(
    'getComponentProps requires either "componentPath" (relative to the workspace root) or "name" (a catalog component name).'
  );
}

/**
 * Read, content-hash cache, and parse props for a single file. `displayPath` is
 * the path shown in error messages; `hint` is appended to the file-not-found
 * message (used to remind callers that `componentPath` is workspace-relative).
 */
async function parseProps(
  fullPath: string,
  displayPath: string,
  hint: string,
  parser: PropParser,
  cache: CacheManager
): Promise<ComponentProps | { error: string }> {
  let content: string;
  try {
    content = await fs.readFile(fullPath, "utf-8");
  } catch {
    return { error: `file not found: ${displayPath}${hint}` };
  }

  const cached = await cache.getProps(fullPath, content);
  if (cached !== undefined) {
    return cached ?? { error: `failed to parse props from ${displayPath}` };
  }

  const props = await parser.parseFile(fullPath);
  cache.setProps(fullPath, content, props);
  return props ?? { error: `failed to parse props from ${displayPath}` };
}
