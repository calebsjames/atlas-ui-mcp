import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { CacheManager } from "../cache/cacheManager.js";
import {
  compareSymbols,
  compareImplementations,
  type CompareResult,
  type CompareError,
} from "./compareImplementations.js";
import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { ComponentCatalog } from "../types.js";

/**
 * compare_implementations: the sub-file diff that answers "are these two
 * implementations equivalent, and if not, where do they differ?" — for both
 * Vue and React. Fixtures are inline so the file is self-contained.
 */

function ok(r: CompareResult | CompareError): CompareResult {
  assert.ok(!("error" in r), `expected a result, got error: ${JSON.stringify(r)}`);
  return r as CompareResult;
}
function err(r: CompareResult | CompareError): CompareError {
  assert.ok("error" in r, `expected an error, got result: ${JSON.stringify(r)}`);
  return r as CompareError;
}
const kinds = (r: CompareResult) => r.divergences.map((d) => d.kind);

// ---------------------------------------------------------------------------
// Normalization: formatting / comments / quote-style / numeric form are noise.
// ---------------------------------------------------------------------------

test("equivalent: same logic differing only in formatting, comments, and quote style", () => {
  const a = `export function f(x) {
    // add one
    return x + 1;
  }`;
  const b = `export function f(x) {
    return x+1
  }`;
  const r = ok(compareSymbols(
    { content: a, ref: { file: "a.ts", symbol: "f" } },
    { content: b, ref: { file: "b.ts", symbol: "f" } }
  ));
  assert.equal(r.verdict, "equivalent");
  assert.equal(r.divergenceCount, 0);
});

test("equivalent: canonicalizes string quotes and numeric literals", () => {
  const a = `const g = () => { const s = 'hi'; return 0x10; }`;
  const b = `const g = () => { const s = "hi"; return 16; }`;
  const r = ok(compareSymbols(
    { content: a, ref: { file: "a.ts", symbol: "g" } },
    { content: b, ref: { file: "b.ts", symbol: "g" } }
  ));
  assert.equal(r.verdict, "equivalent");
});

// ---------------------------------------------------------------------------
// Divergence detection + classification.
// ---------------------------------------------------------------------------

test("literal: a differing string literal is reported with both snippets", () => {
  const a = `function f(x){ return x || "Unknown"; }`;
  const b = `function f(x){ return x || "Unknown Club"; }`;
  const r = ok(compareSymbols(
    { content: a, ref: { file: "a.ts", symbol: "f" } },
    { content: b, ref: { file: "b.ts", symbol: "f" } }
  ));
  assert.equal(r.verdict, "diverges");
  assert.deepEqual(kinds(r), ["literal"]);
  assert.equal(r.divergences[0].a, '"Unknown"');
  assert.equal(r.divergences[0].b, '"Unknown Club"');
  assert.match(r.divergences[0].locA!, /^L\d/);
});

test("added-block: an inserted statement is flagged as an added block, present only on B", () => {
  const a = `function build(items){
    const out = [];
    items.forEach(i => out.push(i));
    return out;
  }`;
  const b = `function build(items){
    const out = [];
    items.forEach(i => out.push(i));
    out.sort((x, y) => (x.n || 0) - (y.n || 0));
    return out;
  }`;
  const r = ok(compareSymbols(
    { content: a, ref: { file: "a.ts", symbol: "build" } },
    { content: b, ref: { file: "b.ts", symbol: "build" } }
  ));
  assert.equal(r.verdict, "diverges");
  const added = r.divergences.find((d) => d.kind === "added-block");
  assert.ok(added, `expected an added-block, got ${JSON.stringify(kinds(r))}`);
  assert.equal(added!.a, undefined);
  assert.match(added!.b!, /sort/);
});

test("guard-changed: a dropped `|| \"\"` fallback is surfaced", () => {
  const a = `function f(m, k){ m[k || ""] = 1; }`;
  const b = `function f(m, k){ m[k] = 1; }`;
  const r = ok(compareSymbols(
    { content: a, ref: { file: "a.ts", symbol: "f" } },
    { content: b, ref: { file: "b.ts", symbol: "f" } }
  ));
  assert.equal(r.verdict, "diverges");
  const d = r.divergences[0];
  assert.match(d.a!, /\|\| ""/);
  assert.equal(d.b, undefined); // present in A, absent in B
});

test("callee-changed: a swapped function call is classified as callee-changed", () => {
  const a = `function f(x){ return formatA(x); }`;
  const b = `function f(x){ return formatB(x); }`;
  const r = ok(compareSymbols(
    { content: a, ref: { file: "a.ts", symbol: "f" } },
    { content: b, ref: { file: "b.ts", symbol: "f" } }
  ));
  assert.deepEqual(kinds(r), ["callee-changed"]);
});

// ---------------------------------------------------------------------------
// Vue + React parity: the same engine handles both, and can compare across them.
// ---------------------------------------------------------------------------

const VUE_SFC = `<template><div>{{ total }}</div></template>
<script setup>
import { computed } from 'vue';
const props = defineProps(['items']);
const total = computed(() => {
  let sum = 0;
  props.items.forEach(i => { sum += i.value; });
  return sum;
});
</script>`;

const REACT_MEMO = `import { useMemo } from 'react';
export function Widget({ items }) {
  const total = useMemo(() => {
    let sum = 0;
    props.items.forEach(i => { sum += i.value; });
    return sum;
  }, [items]);
  return <div>{total}</div>;
}`;

test("vue computed vs react useMemo: identical callback bodies compare equivalent", () => {
  const r = ok(compareSymbols(
    { content: VUE_SFC, ref: { file: "Widget.vue", symbol: "total" } },
    { content: REACT_MEMO, ref: { file: "Widget.tsx", symbol: "total" } }
  ));
  assert.equal(r.verdict, "equivalent");
  assert.equal(r.a.declKind, "computed");
  assert.equal(r.b.declKind, "computed");
});

test("vue: divergences report real .vue file line numbers (script offset mapped)", () => {
  const vueA = VUE_SFC;
  const vueB = VUE_SFC.replace("sum += i.value", "sum += i.value * 2");
  const r = ok(compareSymbols(
    { content: vueA, ref: { file: "A.vue", symbol: "total" } },
    { content: vueB, ref: { file: "B.vue", symbol: "total" } }
  ));
  assert.equal(r.verdict, "diverges");
  // `total` starts on line 5 of the SFC; the divergence sits on line 7.
  assert.equal(r.a.startLine, 5);
  assert.ok(r.divergences.some((d) => /L7/.test(d.locB || "")), JSON.stringify(r.divergences));
});

// ---------------------------------------------------------------------------
// Symbol resolution: class/static methods, enclosingSymbol scoping, errors.
// ---------------------------------------------------------------------------

test("resolves a static class method and an arrow const by name", () => {
  const cls = `export class T {
    static toClub(o) { return { id: o.id, name: o.name }; }
  }`;
  const arrow = `const toClub = (o) => { return { id: o.id, name: o.name }; };`;
  const r = ok(compareSymbols(
    { content: cls, ref: { file: "a.ts", symbol: "toClub" } },
    { content: arrow, ref: { file: "b.ts", symbol: "toClub" } }
  ));
  assert.equal(r.a.declKind, "method");
  assert.equal(r.b.declKind, "arrow");
  assert.equal(r.verdict, "equivalent");
});

test("enclosingSymbol scopes resolution to one factory's getter", () => {
  const src = `
    function makeA(club){
      return { get: () => club.a || "x" };
    }
    function makeB(club){
      return { get: () => club.a || "y" };
    }`;
  const r = ok(compareSymbols(
    { content: src, ref: { file: "s.ts", symbol: "get", enclosingSymbol: "makeA" } },
    { content: src, ref: { file: "s.ts", symbol: "get", enclosingSymbol: "makeB" } }
  ));
  assert.equal(r.verdict, "diverges");
  assert.deepEqual(kinds(r), ["literal"]);
});

test("ambiguous symbol without enclosingSymbol returns an actionable error", () => {
  const src = `
    function makeA(){ return { get: () => 1 }; }
    function makeB(){ return { get: () => 2 }; }`;
  const e = err(compareSymbols(
    { content: src, ref: { file: "s.ts", symbol: "get" } },
    { content: src, ref: { file: "s.ts", symbol: "get", enclosingSymbol: "makeB" } }
  ));
  assert.equal(e.side, "a");
  assert.match(e.error, /matches 2 declarations|enclosingSymbol/);
  assert.equal(e.candidates?.length, 2);
});

test("unknown symbol returns not-found with available suggestions", () => {
  const src = `function alpha(){} function beta(){}`;
  const e = err(compareSymbols(
    { content: src, ref: { file: "s.ts", symbol: "gamma" } },
    { content: src, ref: { file: "s.ts", symbol: "alpha" } }
  ));
  assert.equal(e.side, "a");
  assert.ok(e.available?.includes("alpha"));
});

// ---------------------------------------------------------------------------
// End-to-end through the tool handler: real files on disk, b.file defaulted.
// ---------------------------------------------------------------------------

test("handler: reads files from disk and defaults b.file to a.file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-compare-"));
  const rel = "helpers.ts";
  await fs.writeFile(
    path.join(dir, rel),
    `export function first(x){ return x.a || "A"; }
     export function second(x){ return x.a || "B"; }`
  );

  const catalog: ComponentCatalog = { components: [], categories: {}, totalCount: 0, lastScanned: 0 };
  const cache = new CacheManager();
  cache.setCatalog(catalog);
  const scanner = { scan: async () => catalog } as unknown as ComponentScanner;

  const r = ok(await compareImplementations(
    { a: { file: rel, symbol: "first" }, b: { file: "", symbol: "second" } },
    scanner, cache, dir
  ));
  assert.equal(r.verdict, "diverges");
  assert.deepEqual(kinds(r), ["literal"]);
  assert.equal(r.b.file, rel); // defaulted to a.file
  await fs.rm(dir, { recursive: true, force: true });
});

test("handler: missing symbol arg is rejected before file work", async () => {
  const cache = new CacheManager();
  cache.setCatalog({ components: [], categories: {}, totalCount: 0, lastScanned: 0 });
  const scanner = { scan: async () => cache.getCatalog()! } as unknown as ComponentScanner;
  const e = err(await compareImplementations(
    { a: { file: "x.ts", symbol: "" }, b: { file: "x.ts", symbol: "y" } } as any,
    scanner, cache, "/tmp"
  ));
  assert.equal(e.side, "a");
});
