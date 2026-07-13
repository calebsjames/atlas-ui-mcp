import { test } from "node:test";
import assert from "node:assert/strict";
import { extractVueViewContainer } from "./vueViewContainer.js";

/**
 * The Vue extractor must recognise a one-route section shell from Vue
 * constructs alone (v-if === literal + @click assignment / route.query sync),
 * never from app-specific names, and degrade to null when nothing multiplexes.
 */

const byId = <T extends { id: string }>(sections: T[], id: string): T => sections.find((s) => s.id === id)!;

test("click-driven shell: sections, children, and testid activators", () => {
  const vc = extractVueViewContainer(
    `<template>
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
    </script>`,
    "HomeShell"
  )!;

  assert.equal(vc.container, "HomeShell");
  assert.equal(vc.framework, "vue");
  assert.equal(vc.selector, "currentView");
  assert.equal(vc.sections.length, 2);

  const rx = byId(vc.sections, "prescriptions");
  assert.equal(rx.child, "PrescriptionsList");
  assert.equal(rx.reachedBy, "click");
  assert.deepEqual(rx.activator, { selector: '[data-testid="tab-rx"]', label: "Prescriptions" });

  const bs = byId(vc.sections, "build-sheets");
  assert.equal(bs.child, "BuildSheetsList");
  assert.equal(bs.activator?.selector, '[data-testid="tab-bs"]');
});

test("query-synced shell reports reachedBy=query with the URL param", () => {
  const vc = extractVueViewContainer(
    `<template>
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
    </script>`,
    "Dashboard"
  )!;

  const rx = byId(vc.sections, "rx");
  assert.equal(rx.reachedBy, "query");
  assert.deepEqual(rx.queryParam, { key: "view", value: "rx" });
});

test("section wrapper: child resolved from inside the gated element", () => {
  const vc = extractVueViewContainer(
    `<template>
      <section v-if="tab === 'a'"><AList /></section>
      <section v-show="tab === 'b'"><div><BList /></div></section>
    </template>`,
    "Wrapped"
  )!;
  assert.equal(byId(vc.sections, "a").child, "AList");
  assert.equal(byId(vc.sections, "b").child, "BList");
  // No @click and no route sync → we can't reveal it statically.
  assert.equal(byId(vc.sections, "a").reachedBy, "unknown");
});

test("the variable multiplexing the most views wins", () => {
  const vc = extractVueViewContainer(
    `<template>
      <A v-if="tab === 'a'" />
      <B v-if="tab === 'b'" />
      <M v-if="modal === 'open'" />
    </template>`,
    "MultiVar"
  )!;
  assert.equal(vc.selector, "tab");
  assert.equal(vc.sections.length, 2);
});

test("returns null when nothing multiplexes ≥2 literal-keyed views", () => {
  // Single literal — not a multiplex.
  assert.equal(
    extractVueViewContainer(`<template><Foo v-if="view === 'only'" /></template>`, "One"),
    null
  );
  // Boolean gates, not literal equality.
  assert.equal(
    extractVueViewContainer(
      `<template><Foo v-if="isOpen" /><Bar v-if="isClosed" /></template>`,
      "Bools"
    ),
    null
  );
});
