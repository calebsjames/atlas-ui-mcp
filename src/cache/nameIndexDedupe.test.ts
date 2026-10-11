import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { CacheManager } from "./cacheManager.js";
import { ComponentScanner } from "../scanner/componentScanner.js";
import { getComponentDetail } from "../tools/getComponentDetail.js";
import { getDependencyChain } from "../tools/getDependencyChain.js";
import { resolveByName, isAmbiguousMatch } from "../tools/shared.js";
import { PropParser } from "../parser/propParser.js";
import type { Component, ComponentCatalog } from "../types.js";

/**
 * F1 regression: a class-named service in a camelCase file —
 * `export class InventoryService` in `src/services/inventoryService.ts` — gets a
 * `fileAlias` that differs from its name only by case. The name index is
 * lowercased, so the same node used to be pushed twice under
 * `inventoryservice`, and every by-name lookup came back `ambiguous` with two
 * IDENTICAL candidates that no `file` filter could separate. None of the corpus
 * apps has this shape, which is why the snapshots never caught it.
 */

function classService(): Component {
  return {
    name: "InventoryService",
    fileAlias: "inventoryService",
    path: "/fake/src/services/inventoryService.ts",
    relativePath: "src/services/inventoryService.ts",
    category: "service",
    architectureLayer: "service",
    lastModified: 0,
    exportedNames: ["InventoryService"],
  };
}

function seeded(components: Component[]): CacheManager {
  const catalog: ComponentCatalog = {
    components,
    categories: {},
    totalCount: components.length,
    lastScanned: Date.now(),
  };
  const cache = new CacheManager();
  cache.setCatalog(catalog);
  return cache;
}

test("a case-only fileAlias does not double-index the node", () => {
  const cache = seeded([classService()]);
  assert.equal(cache.getByName("InventoryService").length, 1);
  assert.equal(cache.getByName("inventoryService").length, 1);
});

test("resolveByName collapses identical candidates instead of reporting ambiguity", () => {
  const node = classService();
  const resolved = resolveByName([node, node], "InventoryService");
  assert.ok(!isAmbiguousMatch(resolved), "identical candidates must not be ambiguous");
  assert.equal((resolved as Component).relativePath, "src/services/inventoryService.ts");

  // Two distinct objects for the same FILE are still one candidate.
  const copy = { ...node };
  const again = resolveByName([node, copy], "InventoryService", "src/services/inventoryService.ts");
  assert.ok(!isAmbiguousMatch(again));
});

test("end to end: a scanned class-named service resolves by name, with and without `file`", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-f1-"));
  try {
    await fs.mkdir(path.join(dir, "src/services"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "src/services/inventoryService.ts"),
      `export class InventoryService {\n  static async list() { return fetch("/inventory"); }\n}\n`
    );
    const scanner = new ComponentScanner(dir);
    const cache = new CacheManager();

    const detail = await getComponentDetail({ name: "InventoryService" }, scanner, new PropParser(), cache);
    assert.ok(!("ambiguous" in detail), `expected a resolved node, got ${JSON.stringify(detail)}`);

    const chain = await getDependencyChain(
      { name: "InventoryService", file: "src/services/inventoryService.ts" },
      scanner,
      cache
    );
    assert.ok(!("ambiguous" in chain), `expected a resolved chain, got ${JSON.stringify(chain)}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
