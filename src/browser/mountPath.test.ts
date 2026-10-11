import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { resolveRoute } from "./resolveRoute.js";
import { verifyDataFlow } from "../tools/verifyDataFlow.js";
import { ComponentScanner } from "../scanner/componentScanner.js";
import { CacheManager } from "../cache/cacheManager.js";
import { RouteAnalyzer } from "../analyzer/routeAnalyzer.js";
import { loadConfig } from "../config/configLoader.js";
import type { BrowserSession } from "./session.js";

/**
 * F3 regression: render_component / verify_data_flow checked only a route's
 * own component and that page's direct children, so 12 of 50 calls failed
 * with "No route renders a component matching X" — modals, tabs and
 * composables. A substring match on the route component also let a short
 * name grab the wrong page.
 */

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ dependencies: { vue: "^3.5.0", "vue-router": "^4" } }),
  "src/router/index.ts":
    `import { createRouter, createWebHistory } from "vue-router";\n` +
    `import HomePage from "@/views/HomePage.vue";\n` +
    `import StaffPage from "@/views/StaffPage.vue";\n` +
    `export default createRouter({ history: createWebHistory(), routes: [\n` +
    `  { path: "/home", component: HomePage },\n` +
    `  { path: "/staff/:id", component: StaffPage },\n` +
    `] });\n`,
  "src/views/HomePage.vue":
    `<template><main>\n` +
    `  <Employees v-if="currentView === 'Employees'" />\n` +
    `  <Customers v-if="currentView === 'Customers'" />\n` +
    `</main></template>\n` +
    `<script setup lang="ts">\nimport { ref } from "vue";\nimport { useRoute } from "vue-router";\n` +
    `import Employees from "@/components/Employees.vue";\nimport Customers from "@/components/Customers.vue";\n` +
    `const route = useRoute();\nconst currentView = ref((route.query.view as string) || "Customers");\n</script>\n`,
  "src/views/StaffPage.vue":
    `<template><AppointmentsPanel /></template>\n` +
    `<script setup lang="ts">\nimport AppointmentsPanel from "@/components/AppointmentsPanel.vue";\n</script>\n`,
  "src/components/Customers.vue": `<template><div>customers</div></template>\n`,
  "src/components/Employees.vue":
    `<template><div>\n` +
    `  <button data-testid="new-employee" @click="openNew">New employee</button>\n` +
    `  <EmployeeTable />\n` +
    `  <NewEmployee v-if="showNew" @close="showNew = false" />\n` +
    `</div></template>\n` +
    `<script setup lang="ts">\nimport { ref } from "vue";\n` +
    `import EmployeeTable from "@/components/EmployeeTable.vue";\nimport NewEmployee from "@/components/NewEmployee.vue";\n` +
    `const showNew = ref(false);\nfunction openNew() { showNew.value = true; }\n</script>\n`,
  "src/components/EmployeeTable.vue": `<template><table></table></template>\n`,
  "src/components/NewEmployee.vue": `<template><form></form></template>\n`,
  "src/components/AppointmentsPanel.vue":
    `<template><ul></ul></template>\n` +
    `<script setup lang="ts">\nimport { useAppointments } from "@/composables/useAppointments";\nconst a = useAppointments();\n</script>\n`,
  "src/composables/useAppointments.ts": `export function useAppointments() { return []; }\n`,
};

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-f3-"));
  for (const [rel, content] of Object.entries(FILES)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
  const config = await loadConfig(root);
  return {
    root,
    scanner: new ComponentScanner(root, config),
    cache: new CacheManager(),
    routeAnalyzer: new RouteAnalyzer(root, config),
  };
}

test("a state-gated modal resolves through its nearest routed ancestor, with a capture_flow skeleton", async () => {
  const h = await setup();
  try {
    const r = (await resolveRoute({ baseUrl: "http://x", component: "NewEmployee" }, h.routeAnalyzer, h.scanner, h.cache)) as any;
    assert.equal(r.url, "http://x/home?view=Employees");
    assert.deepEqual(r.mountPath.map((h: { component: string }) => h.component), ["HomePage", "Employees", "NewEmployee"]);
    assert.equal(r.stateGated, true);
    const modalHop = r.mountPath[2];
    assert.match(modalHop.gate, /showNew/);
    assert.equal(modalHop.activator?.selector, '[data-testid="new-employee"]');
    const steps = r.captureFlowSteps;
    assert.equal(steps[0].url, "http://x/home?view=Employees");
    assert.deepEqual(steps[1].actions, [{ type: "click", selector: '[data-testid="new-employee"]' }]);
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test("a child reachable by section reveal alone is not state-gated", async () => {
  const h = await setup();
  try {
    const r = (await resolveRoute({ baseUrl: "http://x", component: "EmployeeTable" }, h.routeAnalyzer, h.scanner, h.cache)) as any;
    assert.equal(r.url, "http://x/home?view=Employees");
    assert.equal(r.stateGated, false);
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test("a composable resolves through the components that consume it", async () => {
  const h = await setup();
  try {
    const r = (await resolveRoute({ baseUrl: "http://x", component: "useAppointments" }, h.routeAnalyzer, h.scanner, h.cache)) as any;
    assert.equal(r.routePath, "/staff/:id");
    assert.ok(r.mountPath.some((hop: { component: string }) => hop.component === "AppointmentsPanel"));
    assert.equal(r.stateGated, false);
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test("no substring route match: a short name does not grab a page", async () => {
  const h = await setup();
  try {
    await assert.rejects(
      resolveRoute({ baseUrl: "http://x", component: "Home" }, h.routeAnalyzer, h.scanner, h.cache),
      /HomePage/
    );
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test("verify_data_flow on a state-gated target returns the plan instead of a misleading capture", async () => {
  const h = await setup();
  try {
    let navigated = false;
    const session = {
      baseUrl: "http://x",
      capture: async () => {
        navigated = true;
        throw new Error("should not navigate");
      },
    } as unknown as BrowserSession;
    const res = await verifyDataFlow({ name: "NewEmployee" }, session, h.routeAnalyzer, h.scanner, h.cache, {});
    const body = JSON.parse((res.content[0] as { text: string }).text);
    assert.equal(navigated, false);
    assert.equal(body.verdict, "gated");
    assert.ok(Array.isArray(body.captureFlowSteps));
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});
