import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { RouteAnalyzer } from "../analyzer/routeAnalyzer.js";
import type { ArchitectureLayer } from "../types.js";
import { ensureCatalog } from "./shared.js";

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

  // Count by layer
  const byLayer: Record<string, number> = {};
  const byCategory: Record<string, number> = {};

  for (const item of catalog.components) {
    byLayer[item.architectureLayer] =
      (byLayer[item.architectureLayer] || 0) + 1;
    byCategory[item.category] = (byCategory[item.category] || 0) + 1;
  }

  // Build layer summaries
  const layerItems = (layer: ArchitectureLayer) =>
    catalog.components.filter((c) => c.architectureLayer === layer);

  const components = layerItems("component");
  const pages = layerItems("page");
  const hooks = layerItems("hook");
  const services = layerItems("service");
  const adapters = layerItems("adapter");
  const contexts = layerItems("context");
  const stores = layerItems("store");
  const dtos = layerItems("dto");
  const types = layerItems("type");

  // Build data flow chains (page -> hook -> service -> adapter)
  const dataFlowChains: string[] = [];
  for (const page of pages) {
    for (const hookImport of page.imports || []) {
      if (hookImport.source.includes("hooks") || hookImport.source.includes("composables")) {
        const hookName = hookImport.names[0];
        const hook = hooks.find(
          (h) => h.name.toLowerCase() === hookName?.toLowerCase()
        );
        if (hook) {
          for (const serviceCall of hook.adapterCalls || []) {
            dataFlowChains.push(
              `${page.name} -> ${hook.name} -> ${serviceCall}`
            );
          }
          if (!hook.adapterCalls?.length) {
            dataFlowChains.push(`${page.name} -> ${hook.name}`);
          }
        }
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
      pages: { count: pages.length, names: pages.map((p) => p.name) },
      hooks: { count: hooks.length, names: hooks.map((h) => h.name) },
      services: {
        count: services.length,
        names: services.map((s) => s.name),
      },
      adapters: {
        count: adapters.length,
        names: adapters.map((a) => a.name),
      },
      contexts: {
        count: contexts.length,
        names: contexts.map((c) => c.name),
      },
      stores: {
        count: stores.length,
        names: stores.map((s) => s.name),
      },
      dtos: {
        count: dtos.length,
        names: dtos.map((d) => d.name),
      },
      types: {
        count: types.length,
        names: types.map((t) => t.name),
      },
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