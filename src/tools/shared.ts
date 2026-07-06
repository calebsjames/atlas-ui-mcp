import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type {
  AmbiguousMatch,
  ArchitectureLayer,
  Component,
  ComponentCatalog,
} from "../types.js";

export async function ensureCatalog(
  scanner: ComponentScanner,
  cache: CacheManager
): Promise<ComponentCatalog> {
  const cached = cache.getCatalog();
  if (cached) return cached;

  const catalog = await scanner.scan();
  cache.setCatalog(catalog);
  return catalog;
}

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Narrow name matches by a `file` path substring. Returns the original list
 * when no file was given.
 */
export function filterByFile(matches: Component[], file?: string): Component[] {
  if (!file) return matches;
  return matches.filter(
    (c) => c.relativePath.includes(file) || c.path.includes(file)
  );
}

/** Build the standard "which one did you mean?" result for colliding names. */
export function ambiguousResult(name: string, matches: Component[]): AmbiguousMatch {
  return {
    ambiguous: true,
    message:
      `${matches.length} catalog items are named "${name}". ` +
      `Pass "file" (a path substring) to disambiguate.`,
    candidates: matches.map((m) => ({
      name: m.name,
      relativePath: m.relativePath,
      architectureLayer: m.architectureLayer,
    })),
  };
}

export function collectUnique(
  items: Component[],
  excludeName: string
): { name: string; relativePath: string; architectureLayer: string }[] {
  const excludeLower = excludeName.toLowerCase();
  const seen = new Set<string>();
  const result: { name: string; relativePath: string; architectureLayer: string }[] = [];

  for (const item of items) {
    const lower = item.name.toLowerCase();
    if (lower === excludeLower) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    result.push({
      name: item.name,
      relativePath: item.relativePath,
      architectureLayer: item.architectureLayer,
    });
  }

  return result;
}

/**
 * Trimmed projection of a Component carrying only the fields an agent needs to
 * triage the catalog. Full Component objects (imports, accessibility,
 * phiCompliance, ...) are large; summaries keep list/search payloads small.
 */
export interface CatalogItemSummary {
  name: string;
  architectureLayer: ArchitectureLayer;
  category: string;
  relativePath: string;
  description?: string;
  routePath?: string;
  fileAlias?: string;
}

/**
 * Project a full Component down to a CatalogItemSummary. Undefined optional
 * fields are omitted from the returned object rather than emitted as
 * `key: undefined`, keeping the serialized payload compact.
 */
export function toSummary(c: Component): CatalogItemSummary {
  const summary: CatalogItemSummary = {
    name: c.name,
    architectureLayer: c.architectureLayer,
    category: c.category,
    relativePath: c.relativePath,
  };
  if (c.description !== undefined) summary.description = c.description;
  if (c.routePath !== undefined) summary.routePath = c.routePath;
  if (c.fileAlias !== undefined) summary.fileAlias = c.fileAlias;
  return summary;
}

/** Type guard for the ambiguous-match sentinel returned by name resolution. */
export function isAmbiguousMatch(value: unknown): value is AmbiguousMatch {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as AmbiguousMatch).ambiguous === true
  );
}

/**
 * Resolve a name to a single Component, disambiguating by `file` when the name
 * collides. `matches` is whatever the caller looked up (optionally pre-narrowed,
 * e.g. to hook-layer items). Returns the sole match, `null` when nothing
 * matched, or an AmbiguousMatch when the name still resolves to multiple files.
 * When a `file` filter removes every candidate the ambiguity is reported over
 * the pre-filter matches so the agent still sees valid options.
 */
export function resolveByName(
  matches: Component[],
  name: string,
  file?: string
): Component | AmbiguousMatch | null {
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  const filtered = filterByFile(matches, file);
  if (filtered.length === 1) return filtered[0];
  if (filtered.length === 0) return ambiguousResult(name, matches);
  return ambiguousResult(name, filtered);
}
