import fs from "fs/promises";
import type { RouteAnalyzer } from "../analyzer/routeAnalyzer.js";
import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { Component } from "../types.js";
import type { Section, ViewContainer } from "../analyzer/viewContainer.js";
import { extractViewContainer } from "../analyzer/extractViewContainer.js";
import { getRouteMap } from "./getRouteMap.js";
import { ensureCatalog, findByLayers, ROUTE_OWNER_LAYERS } from "./shared.js";

/** One view-multiplexing component, with its route (when routed) and sections. */
export interface SectionMapEntry {
  /** The component hosting the section switch. */
  container: string;
  relativePath: string;
  framework: "vue" | "react";
  /** The route this container lives under, when it's a routed page. */
  route?: string;
  /** The state variable the switch keys on. */
  selector: string;
  sections: Section[];
}

export interface SectionMap {
  containers: SectionMapEntry[];
  /** Present only when nothing was found, explaining the empty result. */
  note?: string;
}

/**
 * The "section map" companion to get_route_map. Route maps describe navigation
 * BETWEEN URLs; this describes navigation WITHIN a single route — the shells
 * that multiplex several sub-views (prescriptions / build-sheets / …) off one
 * state variable, where the "lists" are section switches rather than routes.
 *
 * For each routed page (and each page/root-layer shell) it runs the matching
 * framework extractor and, when a multiplexer is found, reports the sections
 * and how to reveal each one — a URL query param, or a click on a named control.
 */
export async function getSectionMap(
  routeAnalyzer: RouteAnalyzer,
  scanner: ComponentScanner,
  cache: CacheManager
): Promise<SectionMap> {
  const routes = await getRouteMap(routeAnalyzer, scanner, cache);
  const catalog = await ensureCatalog(scanner, cache);

  const seen = new Set<string>();
  const containers: SectionMapEntry[] = [];

  const tryExtract = async (comp: Component, route?: string) => {
    if (seen.has(comp.path)) return;
    seen.add(comp.path);
    const vc = await extractFromComponent(comp);
    if (!vc) return;
    containers.push({
      container: vc.container,
      relativePath: comp.relativePath,
      framework: vc.framework,
      ...(route ? { route } : {}),
      selector: vc.selector,
      sections: vc.sections,
    });
  };

  // 1. Routed pages first, so a container that owns a route reports it.
  for (const route of routes) {
    const page = findByLayers(cache.getByName(route.component), ROUTE_OWNER_LAYERS);
    if (page) await tryExtract(page, route.path);
  }

  // 2. Page/root-layer shells not reached above (a switch can live in a layout
  //    that isn't the directly-routed element).
  for (const c of catalog.components) {
    if (c.architectureLayer === "page" || c.architectureLayer === "root") {
      await tryExtract(c);
    }
  }

  if (containers.length === 0) {
    return {
      containers,
      note:
        "No in-route view multiplexer detected. Either navigation is fully route-based " +
        "(use get_route_map), or a section switch keys on something not statically resolvable " +
        "(a store/reducer, a non-literal condition) — drive the UI to explore it.",
    };
  }
  return { containers };
}

/** Read a component's source and run the extractor for its framework. Best-effort. */
async function extractFromComponent(comp: Component): Promise<ViewContainer | null> {
  let source: string;
  try {
    source = await fs.readFile(comp.path, "utf-8");
  } catch {
    return null;
  }
  try {
    return extractViewContainer(source, comp.name, comp.path);
  } catch {
    return null;
  }
}
