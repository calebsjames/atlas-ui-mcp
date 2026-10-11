import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { findTemplateMountSites } from "./templateMountSites.js";
import { analyzeModuleExports } from "./exportAnalyzer.js";

/**
 * Pins the lookup-gap fixes reported from the foreward-ui corpus:
 *   - prop VALUES at a mount site were unreachable (only declared props were),
 *     so "which of the three mount sites passes scope=\"all\"" needed a grep;
 *   - a type-only re-export could win a module's primary catalog name, hiding
 *     a file full of real functions behind a type.
 */

const sfc = (template: string, script = "") =>
  `<template>\n${template}\n</template>\n<script setup lang="ts">\n${script}\n</script>\n`;

test("static props are values; bound props stay expression source", () => {
  const sites = findTemplateMountSites(
    sfc(`<BuilderPerformancePanel scope="all" :range="activeRange" />`),
    "BuilderPerformancePanel"
  );
  assert.equal(sites?.length, 1);
  assert.deepEqual(sites![0].staticProps, { scope: "all" });
  assert.deepEqual(sites![0].boundProps, { range: "activeRange" });
});

test("valueless attributes are flags, not an empty-string literal", () => {
  const sites = findTemplateMountSites(sfc(`<Panel embedded />`), "Panel");
  assert.deepEqual(sites![0].flagProps, ["embedded"]);
  assert.deepEqual(sites![0].staticProps, {});
});

test("v-model and v-bind spread are reported apart from real values", () => {
  const sites = findTemplateMountSites(
    sfc(`<SearchAndFilterBar v-model:search="search" v-bind="extra" />`),
    "SearchAndFilterBar"
  );
  assert.deepEqual(sites![0].vModelProps, { search: "search" });
  assert.deepEqual(sites![0].spreadProps, ["extra"]);
  assert.deepEqual(sites![0].staticProps, {});
});

// The line-regex it replaced counted kebab tags only by luck and split
// multi-line attribute lists across lines it could not read.
test("kebab-case and multi-line mounts resolve to one site with its props", () => {
  const sites = findTemplateMountSites(
    sfc(`<weight-inventory-panel\n  role="builder"\n  embedded\n/>`),
    "WeightInventoryPanel"
  );
  assert.equal(sites?.length, 1);
  assert.equal(sites![0].tag, "weight-inventory-panel");
  assert.deepEqual(sites![0].staticProps, { role: "builder" });
});

// The regex reported `<Tag>` inside a comment (and inside a `ref<Tag | null>`
// type annotation) as a live mount — 10 false positives on the real corpus.
test("commented-out markup is not a mount site", () => {
  const sites = findTemplateMountSites(
    sfc(`<!-- <Panel role="admin" /> -->\n<div />`),
    "Panel"
  );
  assert.deepEqual(sites, []);
});

test("the governing v-if rides along with each site", () => {
  const sites = findTemplateMountSites(
    sfc(`<div v-if="activeTab === 'performance'"><Panel scope="self" /></div>`),
    "Panel"
  );
  assert.equal(sites![0].renderedWhen?.vIf, "activeTab === 'performance'");
});

// undefined ("could not parse a template") must not read as [] ("parsed, none").
test("a file with no parseable template returns undefined, not empty", () => {
  assert.equal(findTemplateMountSites(`export const x = 1;`, "Panel"), undefined);
});

const exportsOf = (src: string, base: string, layer = "service") =>
  analyzeModuleExports(
    ts.createSourceFile(`${base}.ts`, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
    base,
    layer
  );

test("a type-only re-export never wins the primary name but stays indexed", () => {
  const { primary, names, typeOnlyNames } = exportsOf(
    `export type { ImpersonationUser } from "@/auth/state";\n` +
      `export function getImpersonationAccounts() {}\n` +
      `export function useImpersonation() {}\n`,
    "impersonationService"
  );
  assert.equal(primary, "getImpersonationAccounts");
  assert.ok(names.includes("ImpersonationUser"), "type exports stay resolvable by name");
  assert.deepEqual(typeOnlyNames, ["ImpersonationUser"]);
});

test("a module exporting only types is still named after one of them", () => {
  const { primary } = exportsOf(`export type { PartyEventView } from "./x";`, "types", "type");
  assert.equal(primary, "PartyEventView");
});

test("`export { type X, y }` marks only the type specifier", () => {
  const { primary, typeOnlyNames } = exportsOf(
    `const y = 1;\nexport { type X, y };`,
    "mixed"
  );
  assert.equal(primary, "y");
  assert.deepEqual(typeOnlyNames, ["X"]);
});
