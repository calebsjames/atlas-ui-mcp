import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { planSectionReveal } from "./sectionReveal.js";

/**
 * The reveal engine turns a section (named by child component or by id) into a
 * concrete way to reach it after navigation: append a URL query param, or click
 * an activator. It falls back to the single-child Vue query gate for pages below
 * the ≥2 multiplexer threshold, and reports "unknown" when nothing is resolvable.
 */

const VUE_CLICK = `<template>
  <div>
    <button data-testid="tab-rx" @click="currentView = 'prescriptions'">Prescriptions</button>
    <button data-testid="tab-bs" @click="currentView = 'build-sheets'">Build Sheets</button>
    <PrescriptionsList v-if="currentView === 'prescriptions'" />
    <BuildSheetsList v-if="currentView === 'build-sheets'" />
  </div>
</template>
<script setup>
import { ref } from 'vue';
const currentView = ref('prescriptions');
</script>`;

const VUE_QUERY = `<template>
  <div>
    <Rx v-if="currentView === 'rx'" />
    <Bs v-if="currentView === 'bs'" />
  </div>
</template>
<script setup>
import { ref } from 'vue';
import { useRoute } from 'vue-router';
const route = useRoute();
const currentView = ref(route.query.view || 'rx');
</script>`;

const VUE_SINGLE_GATE = `<template>
  <div>
    <Details v-if="currentView === 'details'" />
  </div>
</template>
<script setup>
import { ref } from 'vue';
import { useRoute } from 'vue-router';
const route = useRoute();
const currentView = ref(route.query.view || 'summary');
</script>`;

const VUE_UNKNOWN = `<template>
  <div>
    <A v-if="tab === 'a'" />
    <B v-if="tab === 'b'" />
  </div>
</template>
<script setup>
import { ref } from 'vue';
const tab = ref('a');
</script>`;

const REACT_CLICK = `import { useState } from 'react';
export function ReactShell() {
  const [tab, setTab] = useState('overview');
  return (<div>
    <button data-testid="tab-ov" onClick={() => setTab('overview')}>Overview</button>
    <button data-testid="tab-hist" onClick={() => setTab('history')}>History</button>
    {tab === 'overview' && <Overview />}
    {tab === 'history' && <History />}
  </div>);
}`;

async function withFile(name: string, content: string, fn: (p: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-reveal-"));
  const p = path.join(dir, name);
  try {
    await fs.writeFile(p, content);
    await fn(p);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("Vue click reveal — by child component and by section id", async () => {
  await withFile("HomeShell.vue", VUE_CLICK, async (p) => {
    const byChild = await planSectionReveal(p, "HomeShell", { child: "BuildSheetsList" });
    assert.equal(byChild?.via, "click");
    assert.equal(byChild?.applied, true);
    assert.deepEqual(byChild?.actions, [{ type: "click", selector: '[data-testid="tab-bs"]' }]);
    assert.equal(byChild?.section, "build-sheets");

    const byId = await planSectionReveal(p, "HomeShell", { sectionId: "prescriptions" });
    assert.equal(byId?.actions?.[0].selector, '[data-testid="tab-rx"]');
  });
});

test("Vue query reveal — appends the URL param, no click", async () => {
  await withFile("Dash.vue", VUE_QUERY, async (p) => {
    const plan = await planSectionReveal(p, "Dash", { child: "Bs" });
    assert.equal(plan?.via, "query");
    assert.deepEqual(plan?.queryParam, { key: "view", value: "bs" });
    assert.equal(plan?.actions, undefined);
    assert.equal(plan?.applied, true);
  });
});

test("React click reveal", async () => {
  await withFile("ReactShell.tsx", REACT_CLICK, async (p) => {
    const plan = await planSectionReveal(p, "ReactShell", { child: "History" });
    assert.equal(plan?.via, "click");
    assert.deepEqual(plan?.actions, [{ type: "click", selector: '[data-testid="tab-hist"]' }]);
  });
});

test("single-child (non-multiplexer) Vue query gate still reveals via fallback", async () => {
  await withFile("SinglePage.vue", VUE_SINGLE_GATE, async (p) => {
    const plan = await planSectionReveal(p, "SinglePage", { child: "Details" });
    assert.equal(plan?.via, "query");
    assert.deepEqual(plan?.queryParam, { key: "view", value: "details" });
  });
});

test("section with no activator and no query sync is reported as unknown", async () => {
  await withFile("Unknown.vue", VUE_UNKNOWN, async (p) => {
    const plan = await planSectionReveal(p, "Unknown", { child: "A" });
    assert.equal(plan?.via, "unknown");
    assert.equal(plan?.applied, false);
    assert.match(plan?.note ?? "", /drive the UI/i);
  });
});

test("a target that names no section returns null", async () => {
  await withFile("HomeShell.vue", VUE_CLICK, async (p) => {
    assert.equal(await planSectionReveal(p, "HomeShell", { child: "NoSuchThing" }), null);
    assert.equal(await planSectionReveal("/does/not/exist.vue", "X", { child: "A" }), null);
  });
});
