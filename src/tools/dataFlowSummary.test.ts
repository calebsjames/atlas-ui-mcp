import { test } from "node:test";
import assert from "node:assert/strict";
import { CacheManager } from "../cache/cacheManager.js";
import { getDataFlow } from "./getDataFlow.js";
import type { ArchitectureLayer, Component, ComponentCatalog } from "../types.js";
import type { ComponentScanner } from "../scanner/componentScanner.js";

/**
 * F10: get_data_flow("HomePage") was 163,867 characters, and an empty result
 * looked identical whether the target had no data flow or the trace found
 * nothing to follow.
 */

function comp(p: Partial<Component> & { name: string; relativePath: string; architectureLayer: ArchitectureLayer }): Component {
  return { path: `/fake/${p.relativePath}`, category: "t", lastModified: 0, ...p } as Component;
}

function bigCatalog(): ComponentCatalog {
  const components: Component[] = [];
  const children: string[] = [];
  for (let i = 0; i < 120; i++) {
    const svc = `widget${i}Service`;
    components.push(comp({
      name: svc, relativePath: `src/services/${svc}.ts`, architectureLayer: "service",
      apiEndpoints: Array.from({ length: 8 }, (_, k) => `GET /api/widgets/${i}/collection-${k}/items`),
    }));
    components.push(comp({
      name: `Widget${i}`, relativePath: `src/components/Widget${i}.vue`, architectureLayer: "component",
      imports: [{ type: "named", names: [svc], source: `@/services/${svc}`, resolvedPath: `src/services/${svc}` }],
    }));
    children.push(`Widget${i}`);
  }
  components.push(comp({ name: "Dashboard", relativePath: "src/views/Dashboard.vue", architectureLayer: "page", childComponents: children }));
  components.push(comp({ name: "useNothing", relativePath: "src/composables/useNothing.ts", architectureLayer: "hook" }));
  return { components, categories: {}, totalCount: components.length, lastScanned: 0 };
}

function setup() {
  const catalog = bigCatalog();
  const cache = new CacheManager();
  cache.setCatalog(catalog);
  return { cache, scanner: { scan: async () => catalog } as unknown as ComponentScanner };
}

test("a huge trace summarizes automatically; summary:false returns every chain", async () => {
  const { cache, scanner } = setup();
  const auto = (await getDataFlow({ name: "Dashboard" }, scanner, cache)) as any;
  assert.equal(auto.mode, "summary");
  assert.equal(auto.allEndpoints.length, 960, "the endpoint union is always complete");
  assert.equal(auto.chains, undefined);
  assert.ok(JSON.stringify(auto).length < 60_000, `summary is ${JSON.stringify(auto).length} chars`);
  assert.equal(auto.chainCount, 120);

  const full = (await getDataFlow({ name: "Dashboard", summary: false } as any, scanner, cache)) as any;
  assert.equal(full.mode ?? "full", "full");
  assert.equal(full.chains.length, 120);
});

test("an empty trace says it resolved and why it is empty", async () => {
  const { cache, scanner } = setup();
  const r = (await getDataFlow({ name: "useNothing" }, scanner, cache)) as any;
  assert.deepEqual(r.chains, []);
  assert.equal(r.resolved, true);
  assert.equal(r.relativePath, "src/composables/useNothing.ts");
  assert.match(r.reason ?? "", /no service|no .*calls/i);
});
