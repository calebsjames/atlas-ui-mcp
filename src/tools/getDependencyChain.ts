import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { AmbiguousMatch, ArchitectureLayer, Component } from "../types.js";
import {
  ensureCatalog,
  isAmbiguousMatch,
  nameNotFound,
  resolveByName,
  type NameNotFound,
} from "./shared.js";

export interface DependencyNode {
  name: string;
  relativePath: string;
  architectureLayer: ArchitectureLayer;
  dependsOn?: DependencyNode[];
  usedBy?: DependencyNode[];
}

export interface DependencyChain {
  target: DependencyNode;
  dependsOn: DependencyNode[];
  usedBy: DependencyNode[];
}

/**
 * Get the full dependency chain for a component/hook/service.
 * Supports optional depth parameter (1-3) for recursive traversal. When the
 * name matches multiple files and `file` fails to narrow to one, returns an
 * AmbiguousMatch rather than silently picking the first candidate.
 */
export async function getDependencyChain(
  args: { name: string; depth?: number; file?: string },
  scanner: ComponentScanner,
  cache: CacheManager
): Promise<DependencyChain | AmbiguousMatch | NameNotFound> {
  await ensureCatalog(scanner, cache);

  const resolved = resolveByName(cache.getByName(args.name), args.name, args.file);
  if (resolved === null) return nameNotFound(args.name, cache);
  if (isAmbiguousMatch(resolved)) return resolved;

  const target = resolved;
  const depth = Math.min(Math.max(args.depth || 1, 1), 3);

  const targetNode: DependencyNode = {
    name: target.name,
    relativePath: target.relativePath,
    architectureLayer: target.architectureLayer,
  };

  const dependsOn = collectDownstreamRecursive(target, cache, depth, new Set([target.relativePath]));
  const usedBy = collectUpstreamRecursive(target, cache, depth, new Set([target.relativePath]));

  return { target: targetNode, dependsOn, usedBy };
}

/**
 * What this item depends on: the catalog nodes its imports resolve to BY FILE,
 * plus any rendered child that isn't one of those imports (globally-registered
 * or same-file components, which have no import to resolve). Path-based import
 * resolution is what stops a same-named type/library/component from being
 * pulled in as a phantom dependency. Cycles are bounded by `seen` (keyed by
 * file path, so two files sharing a name don't collapse into one).
 */
function collectDownstreamRecursive(
  target: Component | { imports?: { names: string[]; resolvedPath?: string }[]; childComponents?: string[] },
  cache: CacheManager,
  depth: number,
  seen: Set<string>
): DependencyNode[] {
  const deps = new Map<string, Component>();

  const importedNames = new Set<string>();
  for (const imp of target.imports || []) {
    for (const name of imp.names) importedNames.add(name.toLowerCase());
    for (const node of cache.resolveImportedNodes(imp)) deps.set(node.relativePath, node);
  }
  // A rendered child that wasn't imported can only be matched by name (best
  // effort). Skip children that ARE imports — those were resolved by path
  // above, so name-matching them would only risk re-adding a wrong same-name node.
  for (const child of target.childComponents || []) {
    if (importedNames.has(child.toLowerCase())) continue;
    for (const node of cache.getByName(child)) deps.set(node.relativePath, node);
  }

  const result: DependencyNode[] = [];
  for (const dep of deps.values()) {
    if (seen.has(dep.relativePath)) continue;
    seen.add(dep.relativePath);
    const node: DependencyNode = {
      name: dep.name,
      relativePath: dep.relativePath,
      architectureLayer: dep.architectureLayer,
    };
    if (depth > 1) {
      const children = collectDownstreamRecursive(dep, cache, depth - 1, seen);
      if (children.length > 0) node.dependsOn = children;
    }
    result.push(node);
  }

  return result;
}

/**
 * What uses this item: everything that imports its FILE (catches named-export
 * imports the name index would miss, and never matches a same-named import from
 * a different module) plus everything that renders it as a JSX child (inherently
 * name-based). Deduped by file path.
 */
function collectUpstreamRecursive(
  target: Component,
  cache: CacheManager,
  depth: number,
  seen: Set<string>
): DependencyNode[] {
  const uppers = new Map<string, Component>();
  for (const c of cache.getImportersOfFile(target.relativePath)) uppers.set(c.relativePath, c);
  for (const c of cache.getRenderersOf(target.name)) uppers.set(c.relativePath, c);
  if (target.fileAlias) {
    for (const c of cache.getRenderersOf(target.fileAlias)) uppers.set(c.relativePath, c);
  }
  uppers.delete(target.relativePath);

  const result: DependencyNode[] = [];
  for (const item of uppers.values()) {
    if (seen.has(item.relativePath)) continue;
    seen.add(item.relativePath);

    const node: DependencyNode = {
      name: item.name,
      relativePath: item.relativePath,
      architectureLayer: item.architectureLayer as ArchitectureLayer,
    };
    if (depth > 1) {
      const parents = collectUpstreamRecursive(item, cache, depth - 1, seen);
      if (parents.length > 0) node.usedBy = parents;
    }
    result.push(node);
  }

  return result;
}
