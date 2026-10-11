import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ComponentScanner } from "../scanner/componentScanner.js";
import { CacheManager } from "../cache/cacheManager.js";
import { PropParser } from "../parser/propParser.js";
import { loadConfig } from "../config/configLoader.js";
import { getComponentDetail } from "./getComponentDetail.js";
import { getDependencyChain } from "./getDependencyChain.js";
import { getDataFlow } from "./getDataFlow.js";
import { getComponentProps } from "./getComponentProps.js";

/**
 * F5 regression: the catalog is per FILE with one primary name. A lookup of a
 * module's OTHER export fell back to the export index and answered with the
 * file node as-is — `get_component_detail("isOrderItemSettled")` returned
 * `name: "OUTSTANDING_ORDER_ITEM_STATUSES"`, that constant's line and
 * description, and no caveat. get_hook_detail / find_component_usages were
 * already symbol-honest; these four tools were not.
 */

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ dependencies: { vue: "^3.5.0" } }),
  "src/dto/orderItem.ts":
    `/** Statuses still outstanding. */\n` +
    `export const OUTSTANDING_ORDER_ITEM_STATUSES = ["Ordered"];\n` +
    `\n` +
    `/** True once the item is packed or received. */\n` +
    `export function isOrderItemSettled(s: string) {\n  return s === "Packed";\n}\n`,
  "src/components/SettledBadge.vue":
    `<template><span>{{ isOrderItemSettled(s) }}</span></template>\n` +
    `<script setup lang="ts">\nimport { isOrderItemSettled } from "@/dto/orderItem";\nconst s = "Packed";\n</script>\n`,
  "src/components/OutstandingList.vue":
    `<template><ul><li v-for="x in OUTSTANDING_ORDER_ITEM_STATUSES">{{ x }}</li></ul></template>\n` +
    `<script setup lang="ts">\nimport { OUTSTANDING_ORDER_ITEM_STATUSES } from "@/dto/orderItem";\n</script>\n`,
};

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-f5-"));
  for (const [rel, content] of Object.entries(FILES)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
  const scanner = new ComponentScanner(root, await loadConfig(root));
  return { root, scanner, cache: new CacheManager() };
}

test("get_component_detail answers about the secondary export, not the file's primary", async () => {
  const { root, scanner, cache } = await setup();
  try {
    const d = (await getComponentDetail({ name: "isOrderItemSettled" }, scanner, new PropParser(), cache)) as any;
    assert.equal(d.name, "isOrderItemSettled");
    assert.equal(d.isPrimaryExport, false);
    assert.equal(d.matchedExport, "isOrderItemSettled");
    assert.equal(d.modulePrimaryName, "OUTSTANDING_ORDER_ITEM_STATUSES");
    assert.equal(d.line, 5, "the symbol's own declaration line");
    assert.match(d.description ?? "", /packed or received/);
    assert.match(d.caveat ?? "", /file-level/i);

    const primary = (await getComponentDetail(
      { name: "OUTSTANDING_ORDER_ITEM_STATUSES" }, scanner, new PropParser(), cache
    )) as any;
    assert.equal(primary.isPrimaryExport, true);
    assert.equal(primary.caveat, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("get_dependency_chain scopes usedBy to importers of that symbol", async () => {
  const { root, scanner, cache } = await setup();
  try {
    const c = (await getDependencyChain({ name: "isOrderItemSettled" }, scanner, cache)) as any;
    assert.equal(c.isPrimaryExport, false);
    assert.equal(c.matchedExport, "isOrderItemSettled");
    const users = c.usedBy.map((u: { name: string }) => u.name);
    assert.deepEqual(users, ["SettledBadge"], `usedBy was ${users.join(", ")}`);
    assert.match(c.caveat ?? "", /dependsOn/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("get_data_flow and get_component_props flag a secondary export", async () => {
  const { root, scanner, cache } = await setup();
  try {
    const flow = (await getDataFlow({ name: "isOrderItemSettled" }, scanner, cache)) as any;
    assert.equal(flow.isPrimaryExport, false);
    assert.equal(flow.matchedExport, "isOrderItemSettled");
    assert.match(flow.caveat ?? "", /file-level|whole module/i);

    const props = (await getComponentProps(
      { name: "isOrderItemSettled" }, root, new PropParser(), cache, scanner
    )) as any;
    assert.equal(props.isPrimaryExport, false);
    assert.equal(props.matchedExport, "isOrderItemSettled");
    assert.ok(props.caveat);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
