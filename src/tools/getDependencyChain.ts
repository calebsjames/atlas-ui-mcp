import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { AmbiguousMatch, ArchitectureLayer, Component } from "../types.js";
import {
  ensureCatalog,
  collectUnique,
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

  const dependsOn = collectDownstreamRecursive(target, cache, depth, new Set([target.name.toLowerCase()]));
  const usedBy = collectUpstreamRecursive(target, cache, depth, new Set([target.name.toLowerCase()]));

  return { target: targetNode, dependsOn, usedBy };
}

function collectDownstreamRecursive(
  target: Component | { imports?: { names: string[] }[]; childComponents?: string[] },
  cache: CacheManager,
  depth: number,
  seen: Set<string>
): DependencyNode[] {
  const result: DependencyNode[] = [];

  const names: string[] = [];
  if (target.imports) {
    for (const imp of target.imports) {
      names.push(...imp.names);
    }
  }
  if (target.childComponents) {
    names.push(...target.childComponents);
  }

  for (const name of names) {
    if (seen.has(name.toLowerCase())) continue;
    const deps = cache.getByName(name);
    for (const dep of deps) {
      seen.add(dep.name.toLowerCase());
      const node: DependencyNode = {
        name: dep.name,
        relativePath: dep.relativePath,
        architectureLayer: dep.architectureLayer,
      };
      if (depth > 1) {
        const children = collectDownstreamRecursive(dep, cache, depth - 1, seen);
        if (children.length > 0) {
          node.dependsOn = children;
        }
      }
      result.push(node);
    }
  }

  return result;
}

function collectUpstreamRecursive(
  target: Component,
  cache: CacheManager,
  depth: number,
  seen: Set<string>
): DependencyNode[] {
  const importers = cache.getImportersOf(target.name);
  const renderers = cache.getRenderersOf(target.name);
  // Also check fileAlias for upstream lookups
  if (target.fileAlias) {
    importers.push(...cache.getImportersOf(target.fileAlias));
    renderers.push(...cache.getRenderersOf(target.fileAlias));
  }

  const uniqueItems = collectUnique([...importers, ...renderers], target.name);
  const result: DependencyNode[] = [];

  for (const item of uniqueItems) {
    if (seen.has(item.name.toLowerCase())) continue;
    seen.add(item.name.toLowerCase());

    const node: DependencyNode = {
      name: item.name,
      relativePath: item.relativePath,
      architectureLayer: item.architectureLayer as ArchitectureLayer,
    };

    if (depth > 1) {
      const catalogItem = cache.getByName(item.name)[0];
      if (catalogItem) {
        const parents = collectUpstreamRecursive(catalogItem, cache, depth - 1, seen);
        if (parents.length > 0) {
          node.usedBy = parents;
        }
      }
    }

    result.push(node);
  }

  return result;
}
