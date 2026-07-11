import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { AmbiguousMatch } from "../types.js";
import {
  ensureCatalog,
  collectUnique,
  isAmbiguousMatch,
  nameNotFound,
  resolveByName,
  type NameNotFound,
} from "./shared.js";

export interface HookDetail {
  name: string;
  relativePath: string;
  description?: string;
  parameters?: string[];
  returnType?: string;
  stateVariables?: string[];
  hooks: string[];
  queryKeys?: string[];
  adapterCalls?: string[];
  /** Endpoints the hook issues directly (colocated `api.get('/x')`), if any. */
  apiEndpoints?: string[];
  /** Those endpoints attributed to the hook's exported function that owns them. */
  endpointsByMethod?: Record<string, string[]>;
  dataFetchingPattern?: string;
  imports: { source: string; names: string[] }[];
  phiCompliance?: {
    hasZeroCacheTime: boolean;
    hasZeroStaleTime: boolean;
    violations: string[];
  };
  usedBy: { name: string; relativePath: string; architectureLayer: string }[];
}

/**
 * Get detailed information about a specific hook.
 * Uses indexed cache for O(1) usage lookups. Name matches are first narrowed to
 * hook-layer or `use`-prefixed candidates; ambiguity is only reported (as an
 * AmbiguousMatch) when more than one such candidate survives the `file` filter.
 */
export async function getHookDetail(
  args: { name: string; file?: string },
  scanner: ComponentScanner,
  cache: CacheManager
): Promise<HookDetail | AmbiguousMatch | NameNotFound> {
  const catalog = await ensureCatalog(scanner, cache);

  const hookCandidates = cache
    .getByName(args.name)
    .filter((c) => c.architectureLayer === "hook" || c.name.startsWith("use"));

  const resolved = resolveByName(hookCandidates, args.name, args.file);
  // Suggestions search the whole catalog, so a name that exists only in a
  // non-hook layer still comes back as a pointer instead of a dead end.
  if (resolved === null) return nameNotFound(args.name, cache);
  if (isAmbiguousMatch(resolved)) return resolved;

  const hook = resolved;

  const nameLower = hook.name.toLowerCase();
  const importers = cache.getImportersOf(hook.name);
  const usedBy = collectUnique(importers, hook.name);

  const seenNames = new Set(usedBy.map((u) => u.name.toLowerCase()));
  for (const item of catalog.components) {
    const itemLower = item.name.toLowerCase();
    if (itemLower === nameLower) continue;
    if (seenNames.has(itemLower)) continue;
    if (!item.hooks?.some((h) => h.toLowerCase() === nameLower)) continue;

    seenNames.add(itemLower);
    usedBy.push({
      name: item.name,
      relativePath: item.relativePath,
      architectureLayer: item.architectureLayer,
    });
  }

  return {
    name: hook.name,
    relativePath: hook.relativePath,
    description: hook.description,
    parameters: hook.parameters,
    returnType: hook.returnType,
    stateVariables: hook.stateVariables?.length ? hook.stateVariables : undefined,
    hooks: hook.hooks || [],
    queryKeys: hook.queryKeys,
    adapterCalls: hook.adapterCalls,
    apiEndpoints: hook.apiEndpoints,
    endpointsByMethod: hook.endpointsByMethod,
    dataFetchingPattern: hook.dataFetchingPattern,
    imports: (hook.imports || []).map((imp) => ({
      source: imp.source,
      names: imp.names,
    })),
    phiCompliance: hook.phiCompliance
      ? {
          hasZeroCacheTime: hook.phiCompliance.hasZeroCacheTime,
          hasZeroStaleTime: hook.phiCompliance.hasZeroStaleTime,
          violations: hook.phiCompliance.violations,
        }
      : undefined,
    usedBy,
  };
}
