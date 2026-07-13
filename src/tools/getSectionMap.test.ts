import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { CacheManager } from "../cache/cacheManager.js";
import { getSectionMap } from "./getSectionMap.js";
import type { Component, ComponentCatalog } from "../types.js";
import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { RouteAnalyzer } from "../analyzer/routeAnalyzer.js";

/**
 * End-to-end wiring for get_section_map: real fixture files on disk, routed via
 * a fake route analyzer, read through the actual catalog → file-read → framework
 * dispatch path. Proves a Vue shell and a React shell both surface with their
 * route attached, a plain page does not, and the source is read from disk (not
 * from any in-memory catalog field).
 */

const VUE_SHELL = `<template>
  <div>
    <nav>
      <button data-testid="tab-rx" @click="currentView = 'prescriptions'">Prescriptions</button>
      <button data-testid="tab-bs" @click="currentView = 'build-sheets'">Build Sheets</button>
    </nav>
    <PrescriptionsList v-if="currentView === 'prescriptions'" />
    <BuildSheetsList v-if="currentView === 'build-sheets'" />
  </div>
</template>
<script setup>
import { ref } from 'vue';
const currentView = ref('prescriptions');
</script>`;

const REACT_SHELL = `import { useState } from 'react';
export function ReactShell() {
  const [tab, setTab] = useState('overview');
  return (
    <div>
      <button data-testid="tab-ov" onClick={() => setTab('overview')}>Overview</button>
      <button data-testid="tab-hist" onClick={() => setTab('history')}>History</button>
      {tab === 'overview' && <Overview />}
      {tab === 'history' && <History />}
    </div>
  );
}`;

const PLAIN_PAGE = `<template><div><h1>About</h1></div></template>`;

function comp(partial: Partial<Component> & { name: string; path: string; relativePath: string }): Component {
  return { category: "test", lastModified: 0, architectureLayer: "page", ...partial } as Component;
}

async function setupWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-sectionmap-"));
  await fs.writeFile(path.join(dir, "HomeShell.vue"), VUE_SHELL);
  await fs.writeFile(path.join(dir, "ReactShell.tsx"), REACT_SHELL);
  await fs.writeFile(path.join(dir, "AboutPage.vue"), PLAIN_PAGE);

  const components: Component[] = [
    comp({ name: "HomeShell", path: path.join(dir, "HomeShell.vue"), relativePath: "src/pages/HomeShell.vue" }),
    comp({ name: "ReactShell", path: path.join(dir, "ReactShell.tsx"), relativePath: "src/pages/ReactShell.tsx" }),
    comp({ name: "AboutPage", path: path.join(dir, "AboutPage.vue"), relativePath: "src/pages/AboutPage.vue" }),
  ];
  const catalog: ComponentCatalog = { components, categories: {}, totalCount: components.length, lastScanned: 0 };
  const cache = new CacheManager();
  cache.setCatalog(catalog);

  const scanner = { scan: async () => catalog } as unknown as ComponentScanner;
  const routeAnalyzer = {
    analyzeRoutes: async () => [
      { path: "/home", component: "HomeShell", isProtected: true, isDynamic: false },
      { path: "/react", component: "ReactShell", isProtected: false, isDynamic: false },
    ],
  } as unknown as RouteAnalyzer;

  return { dir, cache, scanner, routeAnalyzer };
}

test("get_section_map surfaces Vue and React shells with routes; skips plain pages", async () => {
  const { dir, cache, scanner, routeAnalyzer } = await setupWorkspace();
  try {
    const map = await getSectionMap(routeAnalyzer, scanner, cache);
    const byContainer = Object.fromEntries(map.containers.map((c) => [c.container, c]));

    // Vue shell — read from the real .vue file, route attached, click-driven.
    const vue = byContainer["HomeShell"];
    assert.ok(vue, "Vue shell should be detected");
    assert.equal(vue.framework, "vue");
    assert.equal(vue.route, "/home");
    assert.equal(vue.selector, "currentView");
    assert.deepEqual(vue.sections.map((s) => s.id), ["prescriptions", "build-sheets"]);
    const rx = vue.sections.find((s) => s.id === "prescriptions")!;
    assert.equal(rx.child, "PrescriptionsList");
    assert.equal(rx.reachedBy, "click");
    assert.equal(rx.activator?.selector, '[data-testid="tab-rx"]');

    // React shell — read from the real .tsx file, route attached.
    const react = byContainer["ReactShell"];
    assert.ok(react, "React shell should be detected");
    assert.equal(react.framework, "react");
    assert.equal(react.route, "/react");
    assert.equal(react.selector, "tab");
    assert.deepEqual(react.sections.map((s) => s.id), ["overview", "history"]);

    // Plain page has no multiplexer — must not appear.
    assert.equal(byContainer["AboutPage"], undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("get_section_map returns an explanatory note when nothing multiplexes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-sectionmap-empty-"));
  try {
    await fs.writeFile(path.join(dir, "AboutPage.vue"), PLAIN_PAGE);
    const components: Component[] = [
      comp({ name: "AboutPage", path: path.join(dir, "AboutPage.vue"), relativePath: "src/pages/AboutPage.vue" }),
    ];
    const catalog: ComponentCatalog = { components, categories: {}, totalCount: 1, lastScanned: 0 };
    const cache = new CacheManager();
    cache.setCatalog(catalog);
    const scanner = { scan: async () => catalog } as unknown as ComponentScanner;
    const routeAnalyzer = { analyzeRoutes: async () => [] } as unknown as RouteAnalyzer;

    const map = await getSectionMap(routeAnalyzer, scanner, cache);
    assert.equal(map.containers.length, 0);
    assert.match(map.note ?? "", /route-based|multiplex/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
