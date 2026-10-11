import type { ComponentScanner } from "../scanner/componentScanner.js";
import { CacheManager } from "../cache/cacheManager.js";
import type { AmbiguousMatch, ArchitectureLayer, Component } from "../types.js";
import {
  ensureCatalog,
  isAmbiguousMatch,
  nameNotFound,
  resolveName,
  symbolMatch,
  type AlsoMatched,
  type NameNotFound,
  type SymbolMatch,
} from "./shared.js";

export interface DependencyNode {
  name: string;
  relativePath: string;
  architectureLayer: ArchitectureLayer;
  dependsOn?: DependencyNode[];
  usedBy?: DependencyNode[];
}

export interface DependencyChain extends Partial<SymbolMatch> {
  target: DependencyNode;
  /** Other catalog nodes the name matched; an exact-case primary name was picked. */
  alsoMatched?: AlsoMatched[];
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

  const resolved = resolveName(cache.getByName(args.name), args.name, args.file);
  if (resolved === null) return nameNotFound(args.name, cache);
  if (isAmbiguousMatch(resolved)) return resolved;

  const target = resolved.node;
  const depth = Math.min(Math.max(args.depth || 1, 1), 3);

  const targetNode: DependencyNode = {
    name: target.name,
    relativePath: target.relativePath,
    architectureLayer: target.architectureLayer,
  };

  const sym = symbolMatch(
    target,
    args.name,
    "dependsOn is the whole module's dependencies (file-level); usedBy is scoped to files " +
      "that import this symbol (plus namespace imports of the module)."
  );
  if (sym.matchedExport) targetNode.name = sym.matchedExport;

  const dependsOn = collectDownstreamRecursive(target, cache, depth, new Set([target.relativePath]));
  const usedBy = collectUpstreamRecursive(
    target,
    cache,
    depth,
    new Set([target.relativePath]),
    sym.isPrimaryExport ? undefined : sym.matchedExport
  );

  return {
    target: targetNode,
    ...(sym.isPrimaryExport ? { isPrimaryExport: true } : sym),
    ...(resolved.alsoMatched ? { alsoMatched: resolved.alsoMatched } : {}),
    dependsOn,
    usedBy,
  };
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

/** Does `c` import `symbol` from the module at `fileKey` (or the whole module as a namespace)? */
function importsSymbol(c: Component, fileKey: string, symbol: string): boolean {
  const s = symbol.toLowerCase();
  return (c.imports || []).some((imp) => {
    if (!imp.resolvedPath) return false;
    const k = CacheManager.normalizeModulePath(imp.resolvedPath);
    if (k !== fileKey && `${k}/index` !== fileKey) return false;
    return imp.type === "namespace" || imp.names.some((n) => n.toLowerCase() === s);
  });
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
  seen: Set<string>,
  /** Scope the FIRST level to importers of this one exported symbol. */
  symbol?: string
): DependencyNode[] {
  const uppers = new Map<string, Component>();
  const fileKey = CacheManager.normalizeModulePath(target.relativePath);
  for (const c of cache.getImportersOfFile(target.relativePath)) {
    if (symbol && !importsSymbol(c, fileKey, symbol)) continue;
    uppers.set(c.relativePath, c);
  }
  for (const c of cache.getRenderersOf(symbol ?? target.name)) uppers.set(c.relativePath, c);
  if (target.fileAlias && !symbol) {
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
