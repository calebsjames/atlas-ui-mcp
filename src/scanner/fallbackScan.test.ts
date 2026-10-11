import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ComponentScanner } from "./componentScanner.js";
import { computeCoverageWarning } from "./coverage.js";
import { CacheManager } from "../cache/cacheManager.js";
import { findComponentUsages } from "../tools/findComponentUsages.js";
import { loadConfig } from "../config/configLoader.js";

/**
 * F8 regression: the default Vue scan targets list a fixed set of
 * directories, so plain `.ts` modules anywhere else under src/ —
 * src/constants, src/realtime, src/navigation (the ops-shell nav model),
 * src/config, src/lib, src/styles, and src/config.ts itself — were never
 * indexed, and the coverage warning could not notice because it counted only
 * .vue/.tsx/.jsx files.
 */

async function workspace(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-f8-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  return dir;
}

const VUE_APP = {
  "package.json": JSON.stringify({ dependencies: { vue: "^3.5.0" } }),
  "src/components/StepList.vue":
    `<template><ol><li v-for="s in REMOTE_SUBMISSION_STEPS">{{ s }}</li></ol></template>\n` +
    `<script setup lang="ts">\nimport { REMOTE_SUBMISSION_STEPS } from "@/constants/remoteSubmission";\n</script>\n`,
  "src/constants/remoteSubmission.ts": `export const REMOTE_SUBMISSION_STEPS = ["a", "b"];\n`,
  "src/realtime/realtimeClient.ts": `export function connectRealtime() { return fetch("/realtime/stream"); }\n`,
  "src/realtime/useLiveRefresh.ts": `export function useLiveRefresh() { return 1; }\n`,
  "src/navigation/opsNav.ts": `export const OPS_SECTIONS = [];\n`,
  "src/config.ts": `export const API_URL = "x";\n`,
  "src/vite-env.d.ts": `/// <reference types="vite/client" />\n`,
  "src/router/index.ts": `import X from "@/components/StepList.vue";\nexport default [X];\n`,
  "src/constants/remoteSubmission.test.ts": `test("x", () => {});\n`,
};

test("plain .ts modules outside the default targets are indexed as a util fallback layer", async () => {
  const root = await workspace(VUE_APP);
  try {
    const scanner = new ComponentScanner(root, await loadConfig(root));
    const catalog = await scanner.scan();
    const byPath = new Map(catalog.components.map((c) => [c.relativePath.split(path.sep).join("/"), c]));

    for (const rel of [
      "src/constants/remoteSubmission.ts",
      "src/realtime/realtimeClient.ts",
      "src/navigation/opsNav.ts",
      "src/config.ts",
    ]) {
      assert.equal(byPath.get(rel)?.architectureLayer, "util", `${rel} should be indexed as util`);
    }
    assert.equal(byPath.get("src/realtime/useLiveRefresh.ts")?.architectureLayer, "hook");
    assert.ok(!byPath.has("src/vite-env.d.ts"), "declaration files are not modules");
    assert.ok(!byPath.has("src/router/index.ts"), "route files stay out of the catalog");
    assert.ok(!byPath.has("src/constants/remoteSubmission.test.ts"), "tests stay excluded");

    const unscanned = (catalog as any).unscannedDirs;
    assert.ok(Array.isArray(unscanned), "the catalog reports unscannedDirs");
    assert.deepEqual(unscanned, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a constant in src/constants resolves for find_component_usages", async () => {
  const root = await workspace(VUE_APP);
  try {
    const config = await loadConfig(root);
    const scanner = new ComponentScanner(root, config);
    const report = await findComponentUsages(
      { name: "REMOTE_SUBMISSION_STEPS" }, scanner, new CacheManager(), root, config
    );
    assert.equal(report.resolution.status, "indexed");
    assert.ok(report.usages.some((u) => u.file.endsWith("StepList.vue")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("with the fallback off, unscanned directories are reported, not silent", async () => {
  const root = await workspace({
    ...VUE_APP,
    ".atlas-ui.json": JSON.stringify({ fallbackScan: false }),
  });
  try {
    const scanner = new ComponentScanner(root, await loadConfig(root));
    const catalog = await scanner.scan();
    const dirs = ((catalog as any).unscannedDirs ?? []).map((d: { dir: string }) => d.dir);
    for (const d of ["src/constants", "src/realtime", "src/navigation", "src"]) {
      assert.ok(dirs.includes(d), `expected ${d} in unscannedDirs, got ${dirs.join(", ")}`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the coverage warning counts .ts files", async () => {
  const root = await workspace({
    "package.json": JSON.stringify({ dependencies: { vue: "^3.5.0" } }),
    "lib/a.ts": "export const a = 1;",
    "lib/b.ts": "export const b = 1;",
    "lib/c.ts": "export const c = 1;",
    "lib/d.ts": "export const d = 1;",
    "lib/e.ts": "export const e = 1;",
    "lib/types.d.ts": "export {}",
  });
  try {
    const warning = await computeCoverageWarning({
      workspaceRoot: root,
      scanTargets: [{ dir: "src/components", extensions: [".vue"], type: "component" }],
      excludePatterns: ["node_modules"],
      extraCoveredFiles: [],
      scannedUiFileCount: 0,
    });
    assert.ok(warning, ".ts files outside every target must be able to trigger the warning");
    assert.equal(warning.missedFileCount, 5, "declaration files are not counted");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
