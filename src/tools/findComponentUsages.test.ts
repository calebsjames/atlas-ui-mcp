import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CacheManager } from "../cache/cacheManager.js";
import { findComponentUsages } from "./findComponentUsages.js";
import type { ArchitectureLayer, Component, ComponentCatalog } from "../types.js";
import type { ComponentScanner } from "../scanner/componentScanner.js";

/**
 * Reproduces the reported defect on a miniature of the real corpus:
 * `isOrderItemSettled` — a free function exported from a dto/ module that
 * nothing imports by that name — returned `[]`, indistinguishable from "no
 * such symbol". Its sibling `areAllOrderItemsSettled` returned only the import
 * line, never the call site that is the actual Ready-gate wiring.
 *
 * Real files on disk: the tool reads candidate sources for line numbers and
 * parses SFC templates, so a purely in-memory fixture would prove nothing.
 */

const DTO_SRC = `export const OUTSTANDING = ["Ordered"] as const;

export function isOrderItemSettled(status: string): boolean {
  return status === "Packed";
}

export function areAllOrderItemsSettled(items: { status: string }[]): boolean {
  return items.every((item) => isOrderItemSettled(item.status));
}
`;

const MODAL_SRC = `<template>
  <div>
    <WeightInventoryPanel role="admin" embedded />
    <weight-inventory-panel
      v-if="showBuilder"
      role="builder"
      :range="activeRange"
    />
    <!-- <WeightInventoryPanel role="ghost" /> -->
  </div>
</template>
<script setup lang="ts">
import { areAllOrderItemsSettled } from "@/dto/orderItem";
import WeightInventoryPanel from "@/components/WeightInventoryPanel.vue";
const ready = areAllOrderItemsSettled(items);
</script>
`;

let root: string;

function comp(
  partial: Partial<Component> & {
    name: string;
    relativePath: string;
    architectureLayer: ArchitectureLayer;
  }
): Component {
  return {
    path: path.join(root, partial.relativePath),
    category: "test",
    lastModified: 0,
    ...partial,
  } as Component;
}

let cache: CacheManager;
let scanner: ComponentScanner;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-usages-"));
  await fs.mkdir(path.join(root, "src/dto"), { recursive: true });
  await fs.mkdir(path.join(root, "src/components"), { recursive: true });
  await fs.writeFile(path.join(root, "src/dto/orderItem.ts"), DTO_SRC);
  await fs.writeFile(path.join(root, "src/components/StageModal.vue"), MODAL_SRC);
  await fs.writeFile(
    path.join(root, "src/components/WeightInventoryPanel.vue"),
    `<template><div /></template>\n`
  );

  const components: Component[] = [
    comp({
      name: "OUTSTANDING",
      relativePath: "src/dto/orderItem.ts",
      architectureLayer: "dto",
      exportedNames: ["OUTSTANDING", "isOrderItemSettled", "areAllOrderItemsSettled"],
    }),
    comp({
      name: "StageModal",
      relativePath: "src/components/StageModal.vue",
      architectureLayer: "component",
      childComponents: ["WeightInventoryPanel"],
      imports: [
        {
          type: "named",
          names: ["areAllOrderItemsSettled"],
          source: "@/dto/orderItem",
          resolvedPath: "src/dto/orderItem.ts",
        },
      ],
    }),
    comp({
      name: "WeightInventoryPanel",
      relativePath: "src/components/WeightInventoryPanel.vue",
      architectureLayer: "component",
    }),
  ];
  const catalog: ComponentCatalog = {
    components,
    categories: {},
    totalCount: components.length,
    lastScanned: Date.now(),
  };
  cache = new CacheManager();
  cache.setCatalog(catalog);
  scanner = { scan: async () => catalog } as unknown as ComponentScanner;
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const find = (name: string) => findComponentUsages({ name }, scanner, cache, root);

// The whole point: "indexed with zero usages" and "never indexed" are
// different answers, and the old bare [] conflated them.
test("an indexed-but-unused export says so instead of returning a bare empty list", async () => {
  const r = await find("isOrderItemSettled");
  assert.equal(r.resolution.status, "indexed-as-export");
  assert.deepEqual(r.resolution.declaredIn, ["src/dto/orderItem.ts"]);
  assert.equal(r.externalUsageCount, 0);
  assert.ok(r.caveats.some((c) => /real 'unused'/.test(c)));
});

test("call sites inside the declaring module are found and marked self-module", async () => {
  const r = await find("isOrderItemSettled");
  const self = r.usages.filter((u) => u.scope === "self-module" && u.usageType === "call");
  assert.equal(self.length, 1, "the sibling's call site is a usage");
  assert.equal(r.selfModuleUsageCount, 1);
});

// A declaration line is not a usage of itself.
test("the declaration line is not reported as a call", async () => {
  const r = await find("isOrderItemSettled");
  assert.ok(!r.usages.some((u) => u.line === 3), "line 3 declares the function");
});

// Previously only the import line came back — the call was the load-bearing fact.
test("a plain exported function reports its call site, not just its import", async () => {
  const r = await find("areAllOrderItemsSettled");
  const kinds = r.usages.map((u) => u.usageType).sort();
  assert.deepEqual(kinds, ["call", "import"]);
  assert.equal(r.externalUsageCount, 2);
});

test("sibling exports carry their own import counts", async () => {
  const r = await find("isOrderItemSettled");
  const sibling = r.siblingExports?.find((s) => s.name === "areAllOrderItemsSettled");
  assert.equal(sibling?.importedByFiles, 1);
});

test("a name in no module is reported as not-in-catalog, with suggestions", async () => {
  const r = await find("isOrderItemSettledd");
  assert.equal(r.resolution.status, "not-in-catalog");
  assert.ok(r.suggestions?.some((s) => s.matchedExport === "isOrderItemSettled"));
  assert.ok(r.caveats.some((c) => /NOT INDEXED/.test(c)));
});

test("mount sites carry the props actually passed, static apart from bound", async () => {
  const r = await find("WeightInventoryPanel");
  const mounts = r.usages.filter((u) => u.usageType === "template");
  assert.equal(mounts.length, 2, "two live mounts; the commented-out one is not a mount");

  assert.deepEqual(mounts[0].staticProps, { role: "admin" });
  assert.deepEqual(mounts[0].flagProps, ["embedded"]);
  assert.equal(mounts[0].boundProps, undefined);

  assert.deepEqual(mounts[1].staticProps, { role: "builder" });
  assert.deepEqual(mounts[1].boundProps, { range: "activeRange" });
  assert.equal(mounts[1].renderedWhen?.vIf, "showBuilder");
});
