import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { Component, ArchitectureLayer } from "../types.js";
import { ensureCatalog, toSummary, type CatalogItemSummary } from "./shared.js";

/**
 * Lightweight Levenshtein distance for fuzzy matching
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

export interface SearchOptions {
  layer?: ArchitectureLayer;
  limit?: number;
}

export async function searchComponents(
  query: string,
  scanner: ComponentScanner,
  cache: CacheManager,
  options?: SearchOptions
): Promise<(CatalogItemSummary & { _score: number })[]> {
  const catalog = await ensureCatalog(scanner, cache);

  const queryLower = query.toLowerCase();
  const queryTokens = queryLower.split(/[\s\-_]+/).filter((t) => t.length > 0);
  const limit = options?.limit ?? 20;

  let candidates = catalog.components;
  if (options?.layer) {
    candidates = candidates.filter(
      (c) => c.architectureLayer === options.layer
    );
  }

  const scored = candidates.map((component) => {
    const score = scoreComponent(component, queryLower, queryTokens);
    return { component, score };
  });

  return scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => ({ ...toSummary(item.component), _score: item.score }));
}

function scoreComponent(
  component: Component,
  queryLower: string,
  queryTokens: string[]
): number {
  let score = 0;
  const nameLower = component.name.toLowerCase();
  const pathLower = component.relativePath.toLowerCase();
  const descLower = (component.description || "").toLowerCase();

  if (nameLower === queryLower) score += 100;
  else if (nameLower.startsWith(queryLower)) score += 60;
  else if (nameLower.includes(queryLower)) score += 40;
  else if (pathLower.includes(queryLower)) score += 20;
  else if (descLower.includes(queryLower)) score += 15;

  for (const token of queryTokens) {
    if (nameLower.includes(token)) score += 15;
    if (component.category.toLowerCase().includes(token)) score += 8;
    if (component.hooks?.some((h) => h.toLowerCase().includes(token))) score += 5;
    if (component.childComponents?.some((c) => c.toLowerCase().includes(token))) score += 5;
  }

  if (score > 0) return score;

  const distance = levenshtein(queryLower, nameLower);
  const maxLen = Math.max(queryLower.length, nameLower.length);
  const similarity = 1 - distance / maxLen;
  if (similarity >= 0.6) return Math.round(similarity * 30);

  return 0;
}
