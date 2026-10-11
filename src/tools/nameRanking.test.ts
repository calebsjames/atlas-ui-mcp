import { test } from "node:test";
import assert from "node:assert/strict";
import { CacheManager } from "../cache/cacheManager.js";
import { resolveByName, isAmbiguousMatch } from "./shared.js";
import { getDataFlow } from "./getDataFlow.js";
import { getDependencyChain } from "./getDependencyChain.js";
import type { ArchitectureLayer, Component, ComponentCatalog } from "../types.js";
import type { ComponentScanner } from "../scanner/componentScanner.js";

/**
 * F6 regression: a `.ts` file's camelCase fileAlias lands in the primary name
 * index, so `ShotDataTable` (a component) collided with
 * `src/types/shotDataTable.ts` (primary `shotDataTableColumns`) and every
 * lookup cost a `file` round trip. An exact-case primary name must outrank an
 * alias, and component-oriented tools must pick the single renderable
 * candidate — listing the rest under `alsoMatched` rather than hiding them.
 */

function comp(p: Partial<Component> & { name: string; relativePath: string; architectureLayer: ArchitectureLayer }): Component {
  return { path: `/fake/${p.relativePath}`, category: "test", lastModified: 0, ...p } as Component;
}

const FIXTURE: Component[] = [
  comp({ name: "ShotDataTable", relativePath: "src/components/fitting/ShotDataTable.vue", architectureLayer: "component" }),
  comp({
    name: "shotDataTableColumns", fileAlias: "shotDataTable",
    relativePath: "src/types/shotDataTable.ts", architectureLayer: "type",
  }),
  comp({ name: "BuildSheet", relativePath: "src/components/buildSheet/BuildSheet.vue", architectureLayer: "component" }),
  comp({ name: "BuildSheetDto", fileAlias: "buildSheet", relativePath: "src/dto/buildSheet.ts", architectureLayer: "dto" }),
  comp({ name: "BuildSheetRow", fileAlias: "buildSheet", relativePath: "src/types/buildSheet.ts", architectureLayer: "type" }),
];

const CATALOG: ComponentCatalog = { components: FIXTURE, categories: {}, totalCount: FIXTURE.length, lastScanned: 0 };
const scanner = { scan: async () => CATALOG } as unknown as ComponentScanner;
function seeded(): CacheManager {
  const cache = new CacheManager();
  cache.setCatalog(CATALOG);
  return cache;
}

test("an exact-case primary name outranks a camelCase file alias", () => {
  const cache = seeded();
  const r = resolveByName(cache.getByName("ShotDataTable"), "ShotDataTable");
  assert.ok(!isAmbiguousMatch(r), "should resolve, not ask");
  assert.equal((r as Component).relativePath, "src/components/fitting/ShotDataTable.vue");

  const r3 = resolveByName(cache.getByName("BuildSheet"), "BuildSheet");
  assert.ok(!isAmbiguousMatch(r3), "a 3-way collision with one exact-case primary resolves");
  assert.equal((r3 as Component).architectureLayer, "component");
});

test("a component tool auto-picks the single renderable candidate and lists the rest", async () => {
  const flow = (await getDataFlow({ name: "shotdatatable" }, scanner, seeded())) as any;
  assert.ok(!flow.ambiguous, "a lower-case query has no exact-case primary but one renderable candidate");
  assert.equal(flow.target, "ShotDataTable");
  assert.deepEqual(
    flow.alsoMatched?.map((m: { relativePath: string }) => m.relativePath),
    ["src/types/shotDataTable.ts"]
  );
});

test("a generic tool still asks when no exact-case primary exists", async () => {
  const chain = (await getDependencyChain({ name: "buildsheet" }, scanner, seeded())) as any;
  assert.equal(chain.ambiguous, true);
  const exact = (await getDependencyChain({ name: "BuildSheet" }, scanner, seeded())) as any;
  assert.equal(exact.target.relativePath, "src/components/buildSheet/BuildSheet.vue");
  assert.equal(exact.alsoMatched?.length, 2);
});
