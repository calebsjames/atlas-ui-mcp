import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ComponentScanner } from "../scanner/componentScanner.js";
import { CacheManager } from "../cache/cacheManager.js";
import { loadConfig } from "../config/configLoader.js";
import { findComponentUsages } from "./findComponentUsages.js";
import { findDeadCode } from "./findDeadCode.js";

/**
 * F9: the catalog is per file plus exported names; class static members and
 * object-literal adapter methods are not exports, so `createProject`
 * returned not-in-catalog and agents fell back to grep (3 sessions; gap log
 * 18 asked for exactly this index).
 */

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ dependencies: { vue: "^3.5.0" } }),
  "src/services/projectService.ts":
    `import { ProjectAdapter } from "@/adapters/projectAdapter";\n` +
    `export class ProjectService {\n` +
    `  static async createProject(d: unknown) {\n    return ProjectAdapter.createProject(d);\n  }\n` +
    `  static async archive() {\n    return 1;\n  }\n` +
    `  static async unusedThing() {\n    return 2;\n  }\n` +
    `}\n`,
  "src/adapters/projectAdapter.ts":
    `export const ProjectAdapter = {\n` +
    `  createProject: async (d: unknown) => fetch("/projects", { method: "POST" }),\n` +
    `  listProjects: async () => fetch("/projects"),\n` +
    `};\n`,
  "src/components/NewProject.vue":
    `<template><button @click="save">Save</button></template>\n` +
    `<script setup lang="ts">\n` +
    `import { ProjectService } from "@/services/projectService";\n` +
    `const onArchive = ProjectService.archive;\n` +
    `async function save() {\n  await ProjectService.createProject({});\n}\n` +
    `</script>\n`,
};

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-f9-"));
  for (const [rel, content] of Object.entries(FILES)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
  const config = await loadConfig(root);
  return { root, config, scanner: new ComponentScanner(root, config), cache: new CacheManager() };
}

test("Class.method resolves and finds its call sites", async () => {
  const h = await setup();
  try {
    const r = await findComponentUsages({ name: "ProjectService.createProject" }, h.scanner, h.cache, h.root, h.config);
    assert.equal(r.resolution.status as string, "indexed-as-member");
    const external = r.usages.filter((u) => u.scope !== "self-module");
    assert.deepEqual(external.map((u) => `${u.file}:${u.line}:${u.usageType}`), ["src/components/NewProject.vue:6:call"]);
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test("a bare method name resolves across classes and tags each usage", async () => {
  const h = await setup();
  try {
    const r = await findComponentUsages({ name: "createProject" }, h.scanner, h.cache, h.root, h.config);
    assert.equal(r.resolution.status as string, "indexed-as-member");
    const tagged = r.usages.map((u) => `${u.file}→${(u as any).resolvesTo}`);
    assert.ok(tagged.includes("src/components/NewProject.vue→ProjectService.createProject"), tagged.join(" "));
    assert.ok(tagged.includes("src/services/projectService.ts→ProjectAdapter.createProject"), tagged.join(" "));
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test("find_dead_code reports methods nothing calls or references", async () => {
  const h = await setup();
  try {
    const report = (await findDeadCode(h.scanner, h.cache, h.root, {}, undefined, h.config)) as any;
    const dead = (report.unusedMethods ?? []).map((m: { name: string }) => m.name).sort();
    assert.deepEqual(dead, ["ProjectAdapter.listProjects", "ProjectService.unusedThing"]);
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test("instance methods of a class instantiated elsewhere are not judged dead", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-f9i-"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ dependencies: { vue: "^3.5.0" } }),
    "src/utils/storage.ts": `export default class Storage {\n  get() { return 1; }\n  set(v: number) { return v; }\n}\n`,
    "src/store/user.ts": `import Storage from "@/utils/storage";\nexport const userStorage = new Storage();\n`,
    "src/plugins/token.ts": `import { userStorage } from "@/store/user";\nexport const token = () => userStorage.get();\n`,
  };
  try {
    for (const [rel, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fs.writeFile(path.join(root, rel), content);
    }
    const config = await loadConfig(root);
    const report = (await findDeadCode(new ComponentScanner(root, config), new CacheManager(), root, {}, undefined, config)) as any;
    const dead = (report.unusedMethods ?? []).map((m: { name: string }) => m.name);
    assert.ok(!dead.includes("Storage.get") && !dead.includes("Storage.set"), `instance methods judged dead: ${dead}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
