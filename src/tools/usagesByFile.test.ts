import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ComponentScanner } from "../scanner/componentScanner.js";
import { CacheManager } from "../cache/cacheManager.js";
import { loadConfig } from "../config/configLoader.js";
import { findComponentUsages } from "./findComponentUsages.js";

/**
 * F7 regression: `VideoSwingTab` is declared in two directories. The tool
 * merged both files' usages with no attribution and had no `file` argument, so
 * a rename-impact list for one included the other's consumers.
 */

const TAB = `<template><div>video</div></template>\n<script setup lang="ts">\nconst x = 1;\n</script>\n`;
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ dependencies: { vue: "^3.5.0" } }),
  "src/components/fittingSession/VideoSwingTab.vue": TAB,
  "src/components/newFitting/VideoSwingTab.vue": TAB,
  "src/components/fittingSession/SessionModal.vue":
    `<template><VideoSwingTab /></template>\n` +
    `<script setup lang="ts">\nimport VideoSwingTab from "./VideoSwingTab.vue";\n</script>\n`,
  "src/components/newFitting/NewFittingModal.vue":
    `<template><div><VideoSwingTab :session="s" /></div></template>\n` +
    `<script setup lang="ts">\nimport VideoSwingTab from "@/components/newFitting/VideoSwingTab.vue";\nconst s = 1;\n</script>\n`,
};

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-f7-"));
  for (const [rel, content] of Object.entries(FILES)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
  const config = await loadConfig(root);
  return { root, config, scanner: new ComponentScanner(root, config), cache: new CacheManager() };
}

test("each usage says which declaration it resolves to", async () => {
  const { root, config, scanner, cache } = await setup();
  try {
    const report = await findComponentUsages({ name: "VideoSwingTab" }, scanner, cache, root, config);
    const external = report.usages.filter((u) => u.scope !== "self-module");
    assert.ok(external.length >= 4, `expected import + template usages in both consumers, got ${external.length}`);
    for (const u of external) {
      const expected = u.file.includes("newFitting")
        ? "src/components/newFitting/VideoSwingTab.vue"
        : "src/components/fittingSession/VideoSwingTab.vue";
      assert.equal((u as any).resolvesTo, expected, `${u.file}:${u.line} ${u.usageType}`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("`file` scopes the report to one declaration", async () => {
  const { root, config, scanner, cache } = await setup();
  try {
    const report = await findComponentUsages(
      { name: "VideoSwingTab", file: "newFitting/VideoSwingTab" } as any, scanner, cache, root, config
    );
    assert.deepEqual(report.resolution.declaredIn, ["src/components/newFitting/VideoSwingTab.vue"]);
    const files = new Set(report.usages.map((u) => u.file));
    assert.ok(files.has("src/components/newFitting/NewFittingModal.vue"));
    assert.ok(!files.has("src/components/fittingSession/SessionModal.vue"), "the other declaration's consumer leaked in");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
