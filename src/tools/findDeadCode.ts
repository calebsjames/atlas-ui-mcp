import fs from "fs/promises";
import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { RouteAnalyzer } from "../analyzer/routeAnalyzer.js";
import type { DeadCodeEntry, Component, ProjectConfig } from "../types.js";
import { ensureCatalog, escapeRegex } from "./shared.js";
import { loadReferenceContents } from "./referenceFiles.js";

export interface DeadCodeReport {
  unusedExports: DeadCodeEntry[];
  totalScanned: number;
  totalUnused: number;
  /**
   * Class / adapter-object methods (`Owner.method`) that nothing calls or
   * references — not in an importer of the owner, not via `this.`/the owner
   * inside their own module, not in an entry/route file.
   */
  unusedMethods?: Array<{ name: string; relativePath: string; architectureLayer: string; line: number; reason: string }>;
  membersScanned?: number;
  totalUnusedMethods?: number;
  methodCaveat?: string;
}

/**
 * Find dead code — exported symbols that are never imported/used anywhere else.
 * Uses the indexed cache for O(1) lookups per symbol.
 */
export async function findDeadCode(
  scanner: ComponentScanner,
  cache: CacheManager,
  workspaceRoot: string,
  options?: { layer?: string },
  routeAnalyzer?: RouteAnalyzer,
  config?: ProjectConfig
): Promise<DeadCodeReport> {
  const catalog = await ensureCatalog(scanner, cache);

  // Build set of routed component names to avoid false positives
  const routedComponents = new Set<string>();
  if (routeAnalyzer) {
    const routes = await routeAnalyzer.analyzeRoutes();
    for (const route of routes) {
      if (route.component && route.component !== "Unknown") {
        routedComponents.add(route.component.toLowerCase());
      }
    }
  }

  let candidates = catalog.components;
  if (options?.layer) {
    candidates = candidates.filter((c) => c.architectureLayer === options.layer);
  }

  // Pre-read all files once (O(n) reads instead of O(n^2))
  const contentIndex = new Map<string, string>();
  await Promise.all(
    catalog.components.map(async (comp) => {
      try {
        contentIndex.set(comp.path, await fs.readFile(comp.path, "utf-8"));
      } catch { /* skip */ }
    })
  );

  // Fold in entry points / route files (App.tsx, main.tsx, layouts) that live
  // outside scan targets. A component referenced only from there is very much
  // alive; without this it would be reported dead — and an agent might delete it.
  const referenceFiles = await loadReferenceContents(workspaceRoot, config);
  for (const [relativePath, content] of referenceFiles) {
    contentIndex.set(relativePath, content);
  }

  const unusedExports: DeadCodeEntry[] = [];

  for (const component of candidates) {
    // Entry/root files (App.*, main.*) are alive by definition — nothing imports main.
    if (component.architectureLayer === "root") continue;
    if (component.architectureLayer === "page" && component.routePath) continue;
    // Skip pages that are route components (even without routePath set on the catalog item)
    if (
      component.architectureLayer === "page" &&
      (routedComponents.has(component.name.toLowerCase()) ||
        (component.fileAlias && routedComponents.has(component.fileAlias.toLowerCase())))
    ) continue;

    const nameLower = component.name.toLowerCase();
    // Name-keyed + path-keyed importers: a multi-export module (utils) is
    // imported by its export names, not its catalog name — without the
    // path-keyed lookup it would be falsely flagged dead.
    const externalImporters = [
      ...cache.getImportersOf(component.name),
      ...cache.getImportersOfFile(component.relativePath),
    ].filter((c) => c.name.toLowerCase() !== nameLower);
    const externalRenderers = cache.getRenderersOf(component.name).filter(
      (c) => c.name.toLowerCase() !== nameLower
    );

    const hookUsers =
      component.architectureLayer === "hook"
        ? catalog.components.filter(
            (c) =>
              c.name.toLowerCase() !== nameLower &&
              c.hooks?.some((h) => h.toLowerCase() === nameLower)
          )
        : [];

    const totalUsages =
      externalImporters.length + externalRenderers.length + hookUsers.length;

    if (totalUsages > 0) continue;

    // Also check file alias name references (defineComponent name vs filename)
    const hasFileReference = checkFileReferencesFromIndex(component, contentIndex) ||
      (component.fileAlias ? checkNameInIndex(component.fileAlias, component.path, contentIndex) : false);

    if (hasFileReference) continue;

    unusedExports.push({
      name: component.name,
      relativePath: component.relativePath,
      architectureLayer: component.architectureLayer,
      exportType: component.exportType || "none",
      reason: buildReason(component),
    });
  }

  // Method level: members of the scanned modules that nothing calls or references.
  const candidatePaths = new Set(candidates.map((c) => c.path));
  const members = cache.allMembers().filter((m) => candidatePaths.has(m.component.path));
  const unusedMethods: NonNullable<DeadCodeReport["unusedMethods"]> = [];
  // One declaration can be reachable under several owners (the class and an
  // exported instance / alias of it): it is used if ANY of them is used.
  const byDecl = new Map<string, typeof members>();
  for (const m of members) {
    const k = `${m.component.path}:${m.line}`;
    byDecl.set(k, [...(byDecl.get(k) || []), m]);
  }
  const isUsed = (m: (typeof members)[number]): boolean => {
    const access = `\\s*\\??\\.\\s*${escapeRegex(m.method)}\\b`;
    const external = new RegExp(`\\b${escapeRegex(m.owner)}${access}`);
    const importerPaths = new Set<string>([
      ...cache.getImportersOfFile(m.component.relativePath).map((c) => c.path),
      ...cache.getImportersOf(m.owner).map((c) => c.path),
      ...referenceFiles.keys(),
    ]);
    importerPaths.delete(m.component.path);
    if ([...importerPaths].some((p) => external.test(contentIndex.get(p) ?? ""))) return true;
    const internal = new RegExp(`\\b(?:this|${escapeRegex(m.owner)})${access}`);
    const lines = (contentIndex.get(m.component.path) ?? "").split("\n");
    return lines.some((l, i) => i + 1 !== m.line && internal.test(l));
  };
  for (const all of byDecl.values()) {
    // Only members callable through a statically named owner can be judged.
    const group = all.filter((m) => m.tracked);
    if (!group.length || group.some(isUsed)) continue;
    const m = group[0];
    unusedMethods.push({
      name: m.qualified,
      relativePath: m.component.relativePath,
      architectureLayer: m.component.architectureLayer,
      line: m.line,
      reason:
        `"${m.qualified}" is never called or referenced outside its declaration` +
        (group.length > 1 ? ` (also reachable as ${group.slice(1).map((g) => g.qualified).join(", ")})` : ""),
    });
  }

  return {
    unusedExports: unusedExports.sort((a, b) => a.name.localeCompare(b.name)),
    totalScanned: candidates.length,
    totalUnused: unusedExports.length,
    unusedMethods: unusedMethods.sort((a, b) => a.name.localeCompare(b.name)),
    membersScanned: members.filter((m) => m.tracked).length,
    totalUnusedMethods: unusedMethods.length,
    methodCaveat:
      "Methods are matched as `Owner.method` text in importers of the owner (and `this.`/`Owner.` " +
      "inside the module). Only static methods, object-literal methods and in-module exported " +
      "instances are judged — an instance method of a class instantiated elsewhere is never listed. " +
      "A renamed import, destructuring, dynamic access, or framework-invoked " +
      "methods (lifecycle hooks, interface implementations) can make a live method look unused — " +
      "confirm with a grep before deleting.",
  };
}

function checkFileReferencesFromIndex(
  target: Component,
  contentIndex: Map<string, string>
): boolean {
  return checkNameInIndex(target.name, target.path, contentIndex);
}

function checkNameInIndex(
  name: string,
  excludePath: string,
  contentIndex: Map<string, string>
): boolean {
  const refRegex = new RegExp(`\\b${escapeRegex(name)}\\b`);

  for (const [path, content] of contentIndex) {
    if (path === excludePath) continue;
    if (refRegex.test(content)) return true;
  }

  return false;
}

function buildReason(component: Component): string {
  const layer = component.architectureLayer;

  switch (layer) {
    case "component":
      return `Component "${component.name}" is exported but never imported or rendered by any other file`;
    case "hook":
      return `Hook "${component.name}" is exported but never called by any component, page, or other hook`;
    case "service":
      return `Service "${component.name}" is exported but never imported by any hook or other service`;
    case "adapter":
      return `Adapter "${component.name}" is exported but never imported by any service or hook`;
    case "context":
      return `Context "${component.name}" is exported but never used as a provider in any component`;
    case "store":
      return `Store "${component.name}" is exported but never used by any component or hook`;
    case "page":
      return `Page "${component.name}" is exported but has no route and is not imported anywhere`;
    default:
      return `"${component.name}" is exported but never used anywhere in the codebase`;
  }
}
