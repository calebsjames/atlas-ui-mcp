import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { captureFlow } from "./captureFlow.js";
import { CacheManager } from "../cache/cacheManager.js";
import type { Component, ComponentCatalog } from "../types.js";
import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { RouteAnalyzer } from "../analyzer/routeAnalyzer.js";
import type { BrowserSession } from "../browser/session.js";

/**
 * F12 regression: capture_flow rejected `[{route:"/home"}, {section:"clubfittings"}]`
 * with "Step 2 does nothing" — `section` was documented as a step field but
 * only honoured alongside a navigation target — and a settle/screenshot-only
 * step was rejected outright.
 */

const HOME = `<template>
  <main>
    <ClubFittingSessions v-if="currentView === 'Club Fittings'" />
    <Customers v-if="currentView === 'Customers'" />
  </main>
</template>
<script setup lang="ts">
import { ref } from "vue";
import { useRoute } from "vue-router";
const route = useRoute();
const currentView = ref((route.query.view as string) || "Club Fittings");
</script>`;

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-f12-"));
  const homePath = path.join(dir, "HomePage.vue");
  await fs.writeFile(homePath, HOME);
  const page: Component = {
    name: "HomePage", path: homePath, relativePath: "src/views/HomePage.vue",
    category: "test", architectureLayer: "page", lastModified: 0,
    childComponents: ["ClubFittingSessions", "Customers"],
  };
  const catalog: ComponentCatalog = { components: [page], categories: {}, totalCount: 1, lastScanned: 0 };
  const cache = new CacheManager();
  cache.setCatalog(catalog);
  const scanner = { scan: async () => catalog } as unknown as ComponentScanner;
  const routeAnalyzer = {
    analyzeRoutes: async () => [{ path: "/home", component: "HomePage", isProtected: true, isDynamic: false }],
  } as unknown as RouteAnalyzer;

  const seen: any[] = [];
  const runFlow = async (steps: any[]) => {
    seen.push(...steps);
    return steps.map((s) => ({
      label: s.label, url: s.url, title: "", performed: [], consoleErrors: [], pageErrors: [],
      failedRequests: [], requestCount: 0, apiCalls: [], clean: true,
    }));
  };
  const session = {
    baseUrl: "http://x",
    runFlow,
    runFlowDetailed: async (steps: any[]) => ({ steps: await runFlow(steps), signedInAs: { profile: "default", summary: "" } }),
  } as unknown as BrowserSession;

  const run = (steps: any[]) => captureFlow({ steps }, session, routeAnalyzer, scanner, cache, {});
  return { dir, seen, run };
}

test("a section-only step navigates within the previous step's page", async () => {
  const h = await harness();
  try {
    await h.run([{ route: "/home" }, { section: "clubfittings" }]);
    assert.equal(h.seen.length, 2);
    assert.equal(h.seen[1].url, "http://x/home?view=Club%20Fittings");
  } finally {
    await fs.rm(h.dir, { recursive: true, force: true });
  }
});

test("a section-only step after a raw url step resolves the page from the url", async () => {
  const h = await harness();
  try {
    await h.run([{ url: "/home?view=Customers" }, { section: "Club Fittings" }]);
    assert.equal(h.seen[1].url, "http://x/home?view=Club%20Fittings");
  } finally {
    await fs.rm(h.dir, { recursive: true, force: true });
  }
});

test("a settle/screenshot-only step is allowed and acts on the current page", async () => {
  const h = await harness();
  try {
    await h.run([{ route: "/home" }, { label: "after animation", settleMs: 300 }]);
    assert.equal(h.seen.length, 2);
    assert.equal(h.seen[1].url, undefined);
    assert.equal(h.seen[1].settleMs, 300);
  } finally {
    await fs.rm(h.dir, { recursive: true, force: true });
  }
});

test("a section-only first step says it needs a page", async () => {
  const h = await harness();
  try {
    await assert.rejects(h.run([{ section: "Customers" }]), /section.*(page|navigation)/i);
  } finally {
    await fs.rm(h.dir, { recursive: true, force: true });
  }
});
