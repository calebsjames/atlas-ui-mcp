import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import ts from "typescript";
import { extractVueEmits, extractEmitLiveness } from "./vueEmits.js";
import { ComponentAnalyzer } from "./componentAnalyzer.js";

/**
 * defineModel (Vue 3.4+) declares an implicit `update:<name>` emit and fires
 * it whenever the model ref is written — there is no defineEmits entry and no
 * emit() call site. Components using it were invisible to emit analysis, and
 * a parent's v-model listener on them risked a false "dangling" report.
 */

const parse = (code: string) =>
  ts.createSourceFile("Test.vue.ts", code, ts.ScriptTarget.Latest, true);

test("defineModel declares its implicit update emit", () => {
  assert.deepEqual(
    extractVueEmits(parse(`const model = defineModel<string>();`)),
    ["update:modelValue"]
  );
  assert.deepEqual(
    extractVueEmits(parse(`const title = defineModel("title", { required: true });`)),
    ["update:title"]
  );
});

test("defineModel emits count as fired, never dead", () => {
  const code = `
    const model = defineModel<string>();
    const emit = defineEmits(["close"]);
  `;
  const sf = parse(code);
  const declared = extractVueEmits(sf);
  assert.deepEqual(declared, ["close", "update:modelValue"]);
  const liveness = extractEmitLiveness(sf, `<template><div /></template>`, declared);
  assert.deepEqual(liveness.fired, ["update:modelValue"]);
  assert.deepEqual(liveness.dead, ["close"]); // explicit emits still audited
});

test("ComponentAnalysis: defineModel yields emits, fired, and vModelBindings", async () => {
  const source = `
<template>
  <input :value="model" @input="model = ($event.target as HTMLInputElement).value" />
</template>
<script setup lang="ts">
const model = defineModel<string>();
</script>
`;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-model-"));
  const file = path.join(dir, "ModelInput.vue");
  await fs.writeFile(file, source, "utf-8");
  try {
    const a = await new ComponentAnalyzer().analyzeComponent(file, "ModelInput", "component");
    assert.deepEqual(a.emits, ["update:modelValue"]);
    assert.deepEqual(a.emitsFired, ["update:modelValue"]);
    assert.equal(a.emitsDead, undefined);
    assert.deepEqual(a.vModelBindings, ["modelValue"]);
    assert.equal(a.sfcParseErrors, undefined); // clean file — no health noise
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
