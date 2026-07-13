import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type {
  AmbiguousMatch,
  ArchitectureLayer,
  Component,
  ComponentCatalog,
} from "../types.js";

// escapeRegex lives in the leaf util module so analyzer code can use it without
// pulling in tools/shared (which would cycle: analyzer → shared → scanner →
// analyzer). Re-exported here so existing `from "../tools/shared.js"` importers
// keep working.
export { escapeRegex } from "../util.js";

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

/** Does this component's path contain the `file` substring? No filter = match. */
export function matchesFile(c: Component, file?: string): boolean {
  if (!file) return true;
  return c.relativePath.includes(file) || c.path.includes(file);
}

/**
 * Narrow name matches by a `file` path substring. Returns the original list
 * when no file was given.
 */
export function filterByFile(matches: Component[], file?: string): Component[] {
  if (!file) return matches;
  return matches.filter((c) => matchesFile(c, file));
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

/** Count catalog items per architecture layer. */
export function countByLayer(components: Component[]): Record<string, number> {
  const byLayer: Record<string, number> = {};
  for (const c of components) {
    byLayer[c.architectureLayer] = (byLayer[c.architectureLayer] || 0) + 1;
  }
  return byLayer;
}

/** Layers that own a route. */
export const ROUTE_OWNER_LAYERS: readonly ArchitectureLayer[] = ["page", "component"];

/** Layers that can appear mounted in a rendered component tree. */
export const RENDERABLE_LAYERS: readonly ArchitectureLayer[] = ["component", "page", "context"];

/** First match whose layer is in `layers` — e.g. the renderable item among name collisions. */
export function findByLayers(
  matches: Component[],
  layers: readonly ArchitectureLayer[]
): Component | undefined {
  return matches.find((c) => layers.includes(c.architectureLayer));
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
 * Returned when a name matches NOTHING in the catalog. A bare null told the
 * agent neither that the lookup failed nor what to try instead — inconsistent
 * with the AmbiguousMatch UX for colliding names.
 */
export interface NameNotFound {
  found: false;
  message: string;
  suggestions: {
    name: string;
    relativePath: string;
    architectureLayer: ArchitectureLayer;
  }[];
}

/** Type guard for the not-found sentinel returned by name resolution. */
export function isNameNotFound(value: unknown): value is NameNotFound {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as NameNotFound).found === false
  );
}

/**
 * Build the "no such name — did you mean?" result. Suggestions are catalog
 * items whose names contain the query (or vice versa) or sit within a small
 * edit distance, so a typo'd or partially-remembered name still lands.
 */
export function nameNotFound(name: string, cache: CacheManager): NameNotFound {
  const components = cache.getCatalog()?.components ?? [];
  const query = name.toLowerCase();

  const scored: { c: Component; score: number }[] = [];
  const seen = new Set<string>();
  for (const c of components) {
    if (seen.has(c.relativePath)) continue;
    const candidate = c.name.toLowerCase();
    let score: number;
    if (candidate.includes(query) || query.includes(candidate)) {
      // Substring either way — strongest signal; closer lengths rank higher.
      score = Math.abs(candidate.length - query.length);
    } else {
      const distance = editDistance(query, candidate, 3);
      if (distance > Math.min(3, Math.floor(query.length / 3))) continue;
      score = 10 + distance; // typo-range matches rank below substring matches
    }
    seen.add(c.relativePath);
    scored.push({ c, score });
  }
  scored.sort((a, b) => a.score - b.score || a.c.name.localeCompare(b.c.name));

  const suggestions = scored.slice(0, 5).map(({ c }) => ({
    name: c.name,
    relativePath: c.relativePath,
    architectureLayer: c.architectureLayer,
  }));

  return {
    found: false,
    message:
      `No catalog item is named "${name}".` +
      (suggestions.length
        ? " Closest matches are listed in suggestions — retry with one of those names."
        : " Nothing similar found; use search_components or list_all_components to browse the catalog."),
    suggestions,
  };
}

/** Levenshtein distance, capped at `max` (returns max+1 once it's exceeded). */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      rowMin = Math.min(rowMin, curr[j]);
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length];
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
