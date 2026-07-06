import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { Component } from "../types.js";
import { ensureCatalog, toSummary, type CatalogItemSummary } from "./shared.js";

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been",
  "for", "of", "to", "in", "on", "at", "by", "with", "from",
  "and", "or", "not", "that", "this", "it", "its",
]);

/**
 * Find components similar to a description using both keyword AND structural matching.
 * Scores based on: keyword hits in name/path/description, shared hooks,
 * shared child components, same data fetching pattern, same category, similar props.
 */
export async function findSimilarComponents(
  description: string,
  scanner: ComponentScanner,
  cache: CacheManager
): Promise<(CatalogItemSummary & { _score: number })[]> {
  const catalog = await ensureCatalog(scanner, cache);

  const keywords = description
    .toLowerCase()
    .split(/[\s,;.]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));

  const scored = catalog.components.map((component) => {
    const score = scoreByKeywords(component, keywords);
    return { component, score };
  });

  return scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15)
    .map((item) => ({ ...toSummary(item.component), _score: item.score }));
}

function scoreByKeywords(component: Component, keywords: string[]): number {
  let score = 0;

  const searchText = [
    component.name,
    component.category,
    component.description || "",
    component.relativePath,
    component.architectureLayer,
    ...(component.hooks || []),
    ...(component.childComponents || []),
    ...(component.eventHandlers || []),
    component.dataFetchingPattern || "",
  ]
    .join(" ")
    .toLowerCase();

  for (const keyword of keywords) {
    if (component.name.toLowerCase().includes(keyword)) score += 20;
    if (searchText.includes(keyword)) score += 8;
    if (component.category.toLowerCase().includes(keyword)) score += 6;
    if (component.architectureLayer.includes(keyword)) score += 10;
    if (component.hooks?.some((h) => h.toLowerCase().includes(keyword))) score += 5;
    if (component.childComponents?.some((c) => c.toLowerCase().includes(keyword))) score += 4;
    if (component.dataFetchingPattern?.toLowerCase().includes(keyword)) score += 8;
    if (component.apiEndpoints?.some((e) => e.toLowerCase().includes(keyword))) score += 6;
  }

  return score;
}
