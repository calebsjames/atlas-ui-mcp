import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { AmbiguousMatch, Component } from "../types.js";
import {
  ensureCatalog,
  findByLayers,
  isAmbiguousMatch,
  resolveByName,
  RENDERABLE_LAYERS,
} from "./shared.js";

export interface DataFlowStep {
  name: string;
  relativePath: string;
  layer: string;
  methods?: string[];
  endpoints?: string[];
}

export interface DataFlowChain {
  component: DataFlowStep;
  composables: DataFlowStep[];
  /**
   * Stores (Pinia / Zustand / Redux Toolkit) the component reads from. Stores
   * fetch data directly, so they're a first-class source alongside composables;
   * empty when the chain doesn't route through a store.
   */
  stores: DataFlowStep[];
  services: DataFlowStep[];
  adapters: DataFlowStep[];
  endpoints: string[];
  /**
   * Render path from the target to the component that owns this chain, e.g.
   * ["MyFittings"] means target → <MyFittings> fetched this. Empty/omitted for
   * the target's own chains.
   */
  via?: string[];
}

export interface DataFlowResult {
  target: string;
  chains: DataFlowChain[];
  /** Union of every endpoint reachable from rendering the target (incl. children). */
  allEndpoints: string[];
  /** How deep into the child tree the trace went. */
  depth: number;
  /** True if the node cap was hit and traversal stopped early. */
  truncated?: boolean;
}

const DEFAULT_DEPTH = 3;
// Backstop against pathological render trees; the visited set already bounds work.
const MAX_NODES = 300;

/**
 * Trace the full data path from a component through composables → services →
 * adapters → API endpoints — including data fetched by CHILD components.
 *
 * A page rarely fetches everything itself; its children do (e.g. a list child
 * via usePagination → service → adapter). Tracing only the target's direct calls
 * under-reports what the rendered route actually hits, which is why
 * verify_data_flow saw real calls as "unexpected". This walks the child render
 * tree (bounded by `depth` and a visited set) so the predicted endpoints match
 * what the page really loads.
 */
export async function getDataFlow(
  args: { name: string; depth?: number; file?: string },
  scanner: ComponentScanner,
  cache: CacheManager
): Promise<DataFlowResult | AmbiguousMatch | null> {
  const catalog = await ensureCatalog(scanner, cache);

  // Colliding names are a real footgun here: tracing the wrong "Header" gives a
  // confident but wrong endpoint prediction. Narrow by `file` when we can; if
  // that leaves the choice open, say so instead of guessing.
  const target = resolveByName(cache.getByName(args.name), args.name, args.file);
  if (target === null || isAmbiguousMatch(target)) return target;

  const maxDepth = Math.max(0, args.depth ?? DEFAULT_DEPTH);
  const chains: DataFlowChain[] = [];
  const visited = new Set<string>();
  let truncated = false;

  // Iterative DFS over the render tree. Each node contributes its own local
  // chains (direct service calls + composable calls); children are expanded
  // until the depth cap. The visited set (keyed by file path) prevents cycles
  // and re-tracing shared components.
  const stack: Array<{ component: Component; via: string[]; depth: number }> = [
    { component: target, via: [], depth: 0 },
  ];

  while (stack.length > 0) {
    const node = stack.pop()!;
    const key = node.component.relativePath || node.component.name;
    if (visited.has(key)) continue;
    if (visited.size >= MAX_NODES) {
      truncated = true;
      break;
    }
    visited.add(key);

    for (const chain of traceComponentLocal(node.component, catalog, cache)) {
      if (node.via.length) chain.via = node.via;
      chains.push(chain);
    }

    if (node.depth < maxDepth) {
      for (const childName of node.component.childComponents || []) {
        const child = resolveChildComponent(childName, cache);
        if (child && !visited.has(child.relativePath || child.name)) {
          stack.push({
            component: child,
            via: [...node.via, childName],
            depth: node.depth + 1,
          });
        }
      }
    }
  }

  // Deduplicate chains with identical origin + composables + endpoints.
  const seen = new Set<string>();
  const uniqueChains = chains.filter((chain) => {
    const k =
      chain.component.name +
      "|" +
      (chain.via || []).join(">") +
      "|" +
      chain.composables.map((c) => c.name).join(",") +
      "|" +
      chain.stores.map((s) => s.name).join(",") +
      "|" +
      chain.endpoints.join(",");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const allEndpoints = [...new Set(uniqueChains.flatMap((c) => c.endpoints))];

  return {
    target: target.name,
    chains: uniqueChains,
    allEndpoints,
    depth: maxDepth,
    ...(truncated ? { truncated } : {}),
  };
}

/**
 * Resolve a JSX child name (e.g. "MyFittings") to a catalog component we can
 * recurse into. Only renderable layers count; icons/lib elements not in the
 * catalog resolve to null and are skipped.
 */
function resolveChildComponent(name: string, cache: CacheManager): Component | null {
  return findByLayers(cache.getByName(name), RENDERABLE_LAYERS) || null;
}

/**
 * Trace the chains owned directly by a single component: its own service calls,
 * plus the service calls of every composable it uses. (No child expansion — the
 * caller handles the tree.)
 */
function traceComponentLocal(
  component: Component,
  catalog: { components: Component[] },
  cache: CacheManager
): DataFlowChain[] {
  const chains: DataFlowChain[] = [];

  // Composables used by this component (from its hooks list and imports).
  const composableNames = new Set<string>();
  for (const hookName of component.hooks || []) {
    if (hookName.startsWith("use") && !isVueBuiltinHook(hookName)) {
      composableNames.add(hookName);
    }
  }
  for (const imp of component.imports || []) {
    if (imp.source.includes("composable") || imp.source.includes("hooks")) {
      for (const name of imp.names) {
        if (name.startsWith("use")) composableNames.add(name);
      }
    }
  }

  // Store hooks read by this component: explicit storeCalls plus anything that
  // looks like a store accessor (useXStore). Collected up front so the
  // composable pass can also redirect misclassified store hooks in here.
  const storeNames = new Set<string>();
  for (const call of component.storeCalls || []) storeNames.add(call);
  for (const hookName of component.hooks || []) {
    if (/^use[A-Z]\w*Store$/.test(hookName)) storeNames.add(hookName);
  }

  // Direct service imports from the component itself.
  const directChain = traceFromServiceCalls(component, catalog, cache);
  if (directChain) {
    chains.push({
      component: toStep(component),
      composables: [],
      stores: [],
      services: directChain.services,
      adapters: directChain.adapters,
      endpoints: directChain.endpoints,
    });
  }

  // Service calls reached through each composable. A Zustand-style `useXStore`
  // resolves to a store item (not a hook) and fetches directly, so it would
  // trace to nothing here — reroute those into the store pass below instead of
  // dropping them.
  for (const composableName of composableNames) {
    const composable = cache.getByName(composableName)[0];
    if (!composable) continue;
    if (composable.architectureLayer === "store") {
      storeNames.add(composableName);
      continue;
    }

    const serviceTrace = traceFromServiceCalls(composable, catalog, cache);
    if (serviceTrace) {
      chains.push({
        component: toStep(component),
        composables: [toStep(composable, composable.adapterCalls)],
        stores: [],
        services: serviceTrace.services,
        adapters: serviceTrace.adapters,
        endpoints: serviceTrace.endpoints,
      });
    }
  }

  // Stores: a store's own apiEndpoints count directly, and a store may also
  // delegate to a service → adapter chain — trace both so store-mediated flows
  // aren't invisible.
  for (const storeName of storeNames) {
    const store = resolveStore(storeName, cache);
    if (!store) continue;

    const serviceTrace = traceFromServiceCalls(store, catalog, cache);
    const endpoints = [
      ...new Set([
        ...(store.apiEndpoints || []),
        ...(serviceTrace?.endpoints || []),
      ]),
    ];
    if (endpoints.length === 0 && !serviceTrace) continue;

    chains.push({
      component: toStep(component),
      composables: [],
      stores: [toStep(store, store.adapterCalls, store.apiEndpoints)],
      services: serviceTrace?.services || [],
      adapters: serviceTrace?.adapters || [],
      endpoints,
    });
  }

  return chains;
}

/**
 * Resolve a store name to its catalog item, preferring the "store" layer when a
 * name collides (a useXStore hook and its store definition can share a name).
 */
function resolveStore(name: string, cache: CacheManager): Component | null {
  const matches = cache.getByName(name);
  if (matches.length === 0) return null;
  return matches.find((c) => c.architectureLayer === "store") || matches[0];
}

/**
 * Names a source calls into: its recorded adapterCalls plus anything imported
 * from a path matching one of `sourceKeywords` (e.g. "service", "adapter").
 */
function collectCallNames(source: Component, sourceKeywords: string[]): string[] {
  const names = [...(source.adapterCalls || [])];
  for (const imp of source.imports || []) {
    if (!sourceKeywords.some((k) => imp.source.includes(k))) continue;
    for (const name of imp.names) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

function traceFromServiceCalls(
  source: Component,
  catalog: { components: Component[] },
  cache: CacheManager
): { services: DataFlowStep[]; adapters: DataFlowStep[]; endpoints: string[] } | null {
  const services: DataFlowStep[] = [];
  const adapters: DataFlowStep[] = [];
  const endpoints: string[] = [];

  for (const serviceName of collectCallNames(source, ["service", "adapter"])) {
    const service = cache.getByName(serviceName)[0];
    if (!service || service.architectureLayer !== "service") continue;

    services.push(toStep(service));

    for (const adapterName of collectCallNames(service, ["adapter"])) {
      const adapter = cache.getByName(adapterName)[0];
      if (!adapter || adapter.architectureLayer !== "adapter") continue;

      adapters.push(toStep(adapter, undefined, adapter.apiEndpoints));
      endpoints.push(...(adapter.apiEndpoints || []));
    }
  }

  if (services.length === 0 && adapters.length === 0) return null;
  return { services, adapters, endpoints: [...new Set(endpoints)] };
}

function toStep(item: Component, methods?: string[], apiEndpoints?: string[]): DataFlowStep {
  const step: DataFlowStep = {
    name: item.name,
    relativePath: item.relativePath,
    layer: item.architectureLayer,
  };
  if (methods?.length) step.methods = methods;
  if (apiEndpoints?.length) step.endpoints = apiEndpoints;
  return step;
}

function isVueBuiltinHook(name: string): boolean {
  return [
    "useRoute", "useRouter", "useSlots", "useAttrs",
    "useCssModule", "useCssVars",
  ].includes(name);
}
