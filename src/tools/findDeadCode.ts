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

  return {
    unusedExports: unusedExports.sort((a, b) => a.name.localeCompare(b.name)),
    totalScanned: candidates.length,
    totalUnused: unusedExports.length,
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
