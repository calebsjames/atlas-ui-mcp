import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { AmbiguousMatch, ArchitectureLayer } from "../types.js";
import {
  ensureCatalog,
  collectUnique,
  isAmbiguousMatch,
  nameNotFound,
  resolveByName,
  resolveExportedName,
  type NameNotFound,
} from "./shared.js";

export interface HookDetail {
  /** The symbol that was resolved — the name as queried, not the module's. */
  name: string;
  relativePath: string;
  /**
   * The layer of the FILE this symbol lives in, reported as indexed. A
   * composable exported from `src/services/` is layer `service`: that is where
   * the code sits, and relabelling it would make the catalog disagree with
   * itself. Shape (`use*`) and location are independent facts.
   */
  architectureLayer: ArchitectureLayer;
  /** False when `name` is one of the module's other exports, not its catalog name. */
  isPrimaryExport: boolean;
  /** The module's catalog name, when it differs from `name`. */
  modulePrimaryName?: string;
  /** The module's other exported symbols — what else shares this file's metadata. */
  siblingExports?: string[];
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
  /** Limits of this answer. Always present — read it before quoting the fields. */
  caveat: string;
}

/** `useThing` — the shape that makes a function a hook/composable, wherever it lives. */
const isUseName = (n: string) => /^use[A-Z0-9]/.test(n);

/**
 * Get detailed information about a specific hook or Vue composable.
 *
 * Resolution is by SYMBOL NAME, not by directory: a `use*`-named export is a
 * composable whether it lives in `src/composables/`, `src/services/`, or
 * anywhere else. The catalog indexes one node per file under a single primary
 * name, so a composable that is a module's secondary export (e.g.
 * `useImpersonation` out of `impersonationService.ts`) is found through that
 * module's `exportedNames` and reported with the file's real layer.
 *
 * Name matches are first narrowed to hook-shaped candidates; ambiguity is only
 * reported (as an AmbiguousMatch) when more than one survives the `file` filter.
 */
export async function getHookDetail(
  args: { name: string; file?: string },
  scanner: ComponentScanner,
  cache: CacheManager
): Promise<HookDetail | AmbiguousMatch | NameNotFound> {
  const catalog = await ensureCatalog(scanner, cache);

  const queryIsUseName = isUseName(args.name);
  const hookCandidates = cache
    .getByName(args.name)
    .filter(
      (c) =>
        c.architectureLayer === "hook" ||
        isUseName(c.name) ||
        // The queried name itself is hook-shaped and this module exports it —
        // the node's own name/layer describe the FILE, not this symbol.
        (queryIsUseName && resolveExportedName(c, args.name) !== undefined)
    );

  const resolved = resolveByName(hookCandidates, args.name, args.file);
  // Suggestions search the whole catalog (names AND every module's exports), so
  // a name that exists only in a non-hook layer comes back as a pointer instead
  // of a dead end.
  if (resolved === null) return nameNotFound(args.name, cache);
  if (isAmbiguousMatch(resolved)) return resolved;

  const hook = resolved;
  // Answer about the SYMBOL that was asked for. Using the node's primary name
  // here would silently report the usages of a different export of the file.
  const symbolName = resolveExportedName(hook, args.name) ?? hook.name;
  const isPrimaryExport = symbolName.toLowerCase() === hook.name.toLowerCase();
  const siblingExports = (hook.exportedNames || []).filter(
    (n) => n.toLowerCase() !== symbolName.toLowerCase()
  );

  const nameLower = symbolName.toLowerCase();
  const importers = cache.getImportersOf(symbolName);
  const usedBy = collectUnique(importers, symbolName);

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

  const caveats: string[] = [];
  if (!isPrimaryExport) {
    caveats.push(
      `"${symbolName}" is a secondary export of ${hook.relativePath}, whose catalog name is ` +
        `"${hook.name}" (layer "${hook.architectureLayer}" — that is the file's location, ` +
        `not a claim about this symbol's shape).`
    );
    caveats.push(
      "Every field except usedBy is FILE-level: parameters, returnType, stateVariables, hooks, " +
        "adapterCalls, apiEndpoints and imports cover the whole module, so they may describe " +
        `sibling exports rather than ${symbolName}. Read the file to attribute them.`
    );
  }
  if (hook.architectureLayer !== "hook") {
    caveats.push(
      `Indexed under layer "${hook.architectureLayer}" because of where the file lives; ` +
        "it is reported as a hook here because the symbol is `use*`-shaped."
    );
  }
  caveats.push(
    "usedBy = modules that import this name plus modules whose analysis recorded a call to it; " +
      "dynamic/re-exported usage is not tracked."
  );

  return {
    name: symbolName,
    relativePath: hook.relativePath,
    architectureLayer: hook.architectureLayer,
    isPrimaryExport,
    ...(isPrimaryExport ? {} : { modulePrimaryName: hook.name }),
    ...(siblingExports.length ? { siblingExports } : {}),
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
    caveat: caveats.join(" "),
  };
}
