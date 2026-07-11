import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { loadConfig } from "./configLoader.js";
import type { ProjectConfig } from "../types.js";

/**
 * Next.js/Nuxt projects keep shared code inside the framework's app dir or at
 * the repo root — layouts the plain src/* defaults never scanned, so those
 * apps produced a near-empty catalog with no error. The defaults must widen
 * when the framework dependency is present, and only then.
 */

async function workspace(pkg: object, config?: object): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-config-"));
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg));
  if (config) {
    await fs.writeFile(path.join(dir, ".atlas-ui.json"), JSON.stringify(config));
  }
  return dir;
}

function target(config: ProjectConfig, dir: string) {
  return config.scanTargets?.find((t) => t.dir === dir);
}

test("next dependency widens React defaults to app-dir and root layouts", async () => {
  const dir = await workspace({ dependencies: { react: "^19", next: "^15" } });
  const config = await loadConfig(dir);

  assert.equal(target(config, "src/app/components")?.type, "component");
  assert.equal(target(config, "app/hooks")?.type, "hook");
  assert.equal(target(config, "src/app/providers")?.type, "context");
  assert.equal(target(config, "src/lib")?.type, "service");
  assert.equal(target(config, "components")?.type, "component");
  assert.equal(target(config, "pages")?.type, "page");
  // Base defaults are still present
  assert.equal(target(config, "src/components")?.type, "component");
});

test("plain React project gets no Next extras", async () => {
  const dir = await workspace({ dependencies: { react: "^19" } });
  const config = await loadConfig(dir);

  assert.equal(target(config, "src/app/components"), undefined);
  assert.equal(target(config, "components"), undefined);
  assert.equal(target(config, "src/components")?.type, "component");
});

test("nuxt dependency widens Vue defaults to root-level and app/ layouts", async () => {
  const dir = await workspace({ dependencies: { vue: "^3", nuxt: "^3" } });
  const config = await loadConfig(dir);

  assert.deepEqual(target(config, "components")?.extensions, [".vue"]);
  assert.equal(target(config, "composables")?.type, "hook");
  assert.equal(target(config, "app/pages")?.type, "page");
  assert.equal(target(config, "layouts")?.type, "component");
});

test("mixed workspace with next and nuxt unions extensions per dir", async () => {
  const dir = await workspace({
    dependencies: { react: "^19", vue: "^3", next: "^15", nuxt: "^3" },
  });
  const config = await loadConfig(dir);

  const components = target(config, "components");
  assert.deepEqual(new Set(components?.extensions), new Set([".tsx", ".vue"]));
  // One merged entry, not one per framework
  assert.equal(
    config.scanTargets?.filter((t) => t.dir === "components").length,
    1
  );
});

test("explicit user scanTargets replace defaults entirely — no extras appended", async () => {
  const dir = await workspace(
    { dependencies: { react: "^19", next: "^15" } },
    { scanTargets: [{ dir: "src/widgets", extensions: [".tsx"], type: "component" }] }
  );
  const config = await loadConfig(dir);

  assert.equal(config.scanTargets?.length, 1);
  assert.equal(config.scanTargets?.[0].dir, "src/widgets");
});
