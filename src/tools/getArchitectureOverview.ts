import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { RouteAnalyzer } from "../analyzer/routeAnalyzer.js";
import type { ArchitectureLayer } from "../types.js";
import { countByLayer, ensureCatalog } from "./shared.js";

export interface ArchitectureOverview {
  summary: {
    totalItems: number;
    byLayer: Record<ArchitectureLayer, number>;
    byCategory: Record<string, number>;
  };
  layers: {
    components: { count: number; categories: string[] };
    pages: { count: number; names: string[] };
    hooks: { count: number; names: string[] };
    services: { count: number; names: string[] };
    adapters: { count: number; names: string[] };
    contexts: { count: number; names: string[] };
    stores: { count: number; names: string[] };
    dtos: { count: number; names: string[] };
    types: { count: number; names: string[] };
  };
  dataFlowChains: string[];
  /** Only present when PHI compliance scanning is enabled (config-gated). */
  phiViolationCount?: number;
  routes: { path: string; component: string; isProtected: boolean }[];
}

/**
 * Get a high-level overview of the entire application architecture
 */
export async function getArchitectureOverview(
  scanner: ComponentScanner,
  cache: CacheManager,
  routeAnalyzer: RouteAnalyzer
): Promise<ArchitectureOverview> {
  const catalog = await ensureCatalog(scanner, cache);

  const routes = await routeAnalyzer.analyzeRoutes();

  const byLayer = countByLayer(catalog.components);
  const byCategory: Record<string, number> = {};
  for (const item of catalog.components) {
    byCategory[item.category] = (byCategory[item.category] || 0) + 1;
  }

  // Build layer summaries
  const layerItems = (layer: ArchitectureLayer) =>
    catalog.components.filter((c) => c.architectureLayer === layer);
  const namedLayer = (layer: ArchitectureLayer) => {
    const items = layerItems(layer);
    return { count: items.length, names: items.map((i) => i.name) };
  };

  const components = layerItems("component");
  const pages = layerItems("page");
  const hooks = layerItems("hook");

  // Build data flow chains (page -> hook -> service -> adapter)
  const dataFlowChains: string[] = [];
  for (const page of pages) {
    for (const hookImport of page.imports || []) {
      if (!hookImport.source.includes("hooks") && !hookImport.source.includes("composables")) {
        continue;
      }
      const hookName = hookImport.names[0];
      const hook = hooks.find((h) => h.name.toLowerCase() === hookName?.toLowerCase());
      if (!hook) continue;
      if (!hook.adapterCalls?.length) {
        dataFlowChains.push(`${page.name} -> ${hook.name}`);
        continue;
      }
      for (const serviceCall of hook.adapterCalls) {
        dataFlowChains.push(`${page.name} -> ${hook.name} -> ${serviceCall}`);
      }
    }
  }

  // Count PHI violations — only report at all when compliance scanning ran
  // (config-gated), so a disabled scan doesn't masquerade as "0 violations".
  let phiViolationCount = 0;
  let hasPhiData = false;
  for (const item of catalog.components) {
    if (item.phiCompliance) {
      hasPhiData = true;
      phiViolationCount += item.phiCompliance.violations.length;
    }
  }

  return {
    summary: {
      totalItems: catalog.totalCount,
      byLayer: byLayer as Record<ArchitectureLayer, number>,
      byCategory,
    },
    layers: {
      components: {
        count: components.length,
        categories: [...new Set(components.map((c) => c.category))],
      },
      pages: namedLayer("page"),
      hooks: namedLayer("hook"),
      services: namedLayer("service"),
      adapters: namedLayer("adapter"),
      contexts: namedLayer("context"),
      stores: namedLayer("store"),
      dtos: namedLayer("dto"),
      types: namedLayer("type"),
    },
    dataFlowChains: [...new Set(dataFlowChains)].slice(0, 30),
    ...(hasPhiData ? { phiViolationCount } : {}),
    routes: routes.map((r) => ({
      path: r.path,
      component: r.component,
      isProtected: r.isProtected,
    })),
  };
}