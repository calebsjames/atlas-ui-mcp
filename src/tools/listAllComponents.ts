import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { ArchitectureLayer, Component, ScanCoverageWarning } from "../types.js";
import { countByLayer, ensureCatalog, toSummary, type CatalogItemSummary } from "./shared.js";

export interface ListAllComponentsResult {
  totalCount: number;
  lastScanned: number;
  byLayer: Record<string, number>;
  components: CatalogItemSummary[] | Component[];
  /** Only present when the scan likely missed most of the app's UI files. */
  coverageWarning?: ScanCoverageWarning;
}

/**
 * List catalog items, trimmed to CatalogItemSummary objects by default to keep
 * the payload small. `byLayer` counts always reflect the entire catalog so the
 * agent sees the whole shape even when `components` is narrowed by `layer`.
 * Pass `verbose` to get full Component objects instead of summaries. The
 * catalog's `categories` map (which duplicates every Component) is never
 * emitted.
 */
export async function listAllComponents(
  scanner: ComponentScanner,
  cache: CacheManager,
  opts?: { layer?: ArchitectureLayer; verbose?: boolean }
): Promise<ListAllComponentsResult> {
  const catalog = await ensureCatalog(scanner, cache);

  const byLayer = countByLayer(catalog.components);

  const filtered = opts?.layer
    ? catalog.components.filter((c) => c.architectureLayer === opts.layer)
    : catalog.components;

  const components = opts?.verbose ? filtered : filtered.map(toSummary);

  return {
    totalCount: catalog.totalCount,
    lastScanned: catalog.lastScanned,
    byLayer,
    components,
    ...(catalog.coverageWarning ? { coverageWarning: catalog.coverageWarning } : {}),
  };
}
