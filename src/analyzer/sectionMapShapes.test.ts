import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { extractVueViewContainer } from "./vueViewContainer.js";
import { planSectionReveal } from "../browser/sectionReveal.js";
import { resolveRoute } from "../browser/resolveRoute.js";
import { CacheManager } from "../cache/cacheManager.js";
import type { Component, ComponentCatalog } from "../types.js";
import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { RouteAnalyzer } from "./routeAnalyzer.js";

/**
 * F4 regression: get_section_map's condition parser was a `^…$` regex with a
 * lazy capture and no newline matching. On a HomePage-shaped shell it
 *  - fused `a === 'x' || a === 'y'` into one corrupt id ("x' || a === 'y"),
 *  - dropped every multi-line `||` gate entirely,
 *  - fused `&&` compounds into ids ("Dashboard' && activeTab === 'Overview"),
 *  - invented `?id=` for a tab var because `route.query.id` sat within 300
 *    chars of an assignment to it,
 * and an unknown/mis-cased section id was silently ignored.
 * These fixtures reproduce the three foreward shells' exact shapes.
 */

const HOME = `<template>
  <main>
    <div
      v-if="
        currentView === 'View Projects' || currentView === 'All Projects'
      "
      class="px-6"
    >
      <ProjectsAdminList />
    </div>
    <ClubFittingSessions v-if="currentView === 'Club Fittings'" />
    <Prescription v-if="currentView === 'Prescriptions'" />
    <PartyFitting
      v-if="currentView === 'Party Fitting' || currentView === 'Party Kits'"
      :view="partyFittingView"
    />
    <InventoryPage v-if="currentView === 'Inventory'" />
    <InventoryPage
      v-if="
        currentView === 'Weight Inventory' ||
        currentView === 'Counter Weight' ||
        currentView === 'Port Weight'
      "
      initial-category="weightInventory"
    />
    <NotificationSettings
      v-if="
        currentView === 'Admin Notifications' ||
        currentView === 'Customer Notifications' ||
        currentView === 'Build Facility Notifications'
      "
      :audience="notificationAudience"
    />
  </main>
</template>
<script setup lang="ts">
import { ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
const route = useRoute();
const router = useRouter();
const getInitialView = () => {
  const viewFromQuery = route.query.view as string;
  return viewFromQuery || "Club Fittings";
};
const currentView = ref(getInitialView());
watch(
  () => route.query.view,
  (newView) => {
    if (newView && typeof newView === "string") {
      currentView.value = newView;
    }
  },
);
const handleNavigation = (view: string) => {
  currentView.value = view;
  router.replace({ query: { view: currentView.value } });
};
</script>`;

const HOME_LITERALS = [
  "View Projects", "All Projects", "Club Fittings", "Prescriptions", "Party Fitting", "Party Kits",
  "Inventory", "Weight Inventory", "Counter Weight", "Port Weight",
  "Admin Notifications", "Customer Notifications", "Build Facility Notifications",
];

const FITTER = `<template>
  <div>
    <ProfileTabs v-model="activeTab" :tabs="profileTabs" />
    <section v-if="activeTab === 'projects'"><ProjectsTab /></section>
    <section v-else-if="activeTab === 'performance'"><PerformanceTab /></section>
    <section v-else-if="activeTab === 'info'"><CoachInfoTab /></section>
  </div>
</template>
<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute } from "vue-router";
const route = useRoute();
const fitterAccountId = computed(() => {
  return (route.query.id as string) || (route.params.id as string);
});
const activeTab = ref<"projects" | "performance" | "info">("projects");
</script>`;

const PRESCRIBER = `<template>
  <div>
    <PrescriberDashboardOverview v-if="activeSection === 'Dashboard' && activeTab === 'Overview'" />
    <ClubFittingSessions
      v-else-if="
        activeSection === 'Projects' && activeTab === 'Club Fittings'
      "
    />
    <PrescriptionTab v-else-if="activeSection === 'Projects' && activeTab === 'Prescriptions'" />
    <PrescriberInquiries v-else-if="activeSection === 'Remote' && activeTab === 'Remote Inquiries'" />
    <PrescriberAppointments v-else-if="activeSection === 'Appointments'" />
  </div>
</template>
<script setup lang="ts">
import { ref, watch } from "vue";
import { useRoute } from "vue-router";
const route = useRoute();
const activeSection = ref("Dashboard");
const activeTab = ref("Overview");
function applyTabQuery(tabParam?: string | null) {
  const mapped = STAGE_TAB_MAP[tabParam];
  if (mapped) {
    activeSection.value = mapped.section;
    activeTab.value = mapped.tab;
  }
}
watch(() => route.query.tab, (tabParam) => applyTabQuery(tabParam));
</script>`;

const CORRUPT = /['"]|\|\||&&/;

test("HomePage shape: one section per || disjunct, multi-line gates included, ids clean", () => {
  const vc = extractVueViewContainer(HOME, "HomePage")!;
  assert.ok(vc, "a container must be detected");
  assert.equal(vc.selector, "currentView");
  const ids = vc.sections.map((s) => s.id);
  assert.deepEqual(ids.filter((id) => CORRUPT.test(id)), [], "no fused/corrupt ids");
  assert.deepEqual([...ids].sort(), [...HOME_LITERALS].sort());
  const byId = (id: string) => vc.sections.find((s) => s.id === id)!;
  assert.equal(byId("All Projects").child, "ProjectsAdminList");
  assert.equal(byId("Counter Weight").child, "InventoryPage");
  assert.equal(byId("Build Facility Notifications").child, "NotificationSettings");
});

test("HomePage shape: the ?view= key is found because the query value flows into currentView", () => {
  const vc = extractVueViewContainer(HOME, "HomePage")!;
  for (const s of vc.sections) {
    assert.deepEqual(s.queryParam, { key: "view", value: s.id }, `section ${s.id}`);
    assert.equal(s.reachedBy, "query");
  }
});

test("FitterProfile shape: route.query.id near the tab var is NOT the tab's query key", () => {
  const vc = extractVueViewContainer(FITTER, "FitterProfile")!;
  assert.deepEqual(vc.sections.map((s) => s.id), ["projects", "performance", "info"]);
  for (const s of vc.sections) {
    assert.equal(s.queryParam, undefined, `section ${s.id} must not claim a query key`);
    assert.notEqual(s.reachedBy, "query");
  }
});

test("PrescriberDashboard shape: && compounds become {var: value} conditions with clean ids", () => {
  const vc = extractVueViewContainer(PRESCRIBER, "PrescriberDashboard")!;
  const ids = vc.sections.map((s) => s.id);
  assert.deepEqual(ids.filter((id) => CORRUPT.test(id)), [], `corrupt ids: ${ids.join(" | ")}`);
  const clubFittings = vc.sections.find((s) => s.id === "Club Fittings") as any;
  assert.ok(clubFittings, `Club Fittings section missing from ${ids.join(", ")}`);
  assert.deepEqual(clubFittings.conditions, { activeSection: "Projects", activeTab: "Club Fittings" });
  assert.equal(clubFittings.child, "ClubFittingSessions");
  assert.ok(ids.includes("Appointments"), "a section gated by the co-variable alone is kept");
  // ?tab= is mapped through STAGE_TAB_MAP — the literal is not what the URL carries.
  assert.equal(clubFittings.queryParam, undefined);
});

async function withFile(name: string, content: string, fn: (p: string, dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-f4-"));
  const p = path.join(dir, name);
  try {
    await fs.writeFile(p, content);
    await fn(p, dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("section ids match case- and whitespace-insensitively", async () => {
  await withFile("HomePage.vue", HOME, async (p) => {
    const plan = await planSectionReveal(p, "HomePage", { sectionId: "clubfittings" });
    assert.equal(plan?.section, "Club Fittings");
    assert.deepEqual(plan?.queryParam, { key: "view", value: "Club Fittings" });
    const plan2 = await planSectionReveal(p, "HomePage", { sectionId: "  counter   WEIGHT " });
    assert.equal(plan2?.section, "Counter Weight");
  });
});

test("an unknown section id is an error that lists the valid ids", async () => {
  await withFile("HomePage.vue", HOME, async (p) => {
    const page: Component = {
      name: "HomePage", path: p, relativePath: "src/views/HomePage.vue",
      category: "test", architectureLayer: "page", lastModified: 0,
    };
    const catalog: ComponentCatalog = { components: [page], categories: {}, totalCount: 1, lastScanned: 0 };
    const cache = new CacheManager();
    cache.setCatalog(catalog);
    const scanner = { scan: async () => catalog } as unknown as ComponentScanner;
    const routeAnalyzer = {
      analyzeRoutes: async () => [{ path: "/home", component: "HomePage", isProtected: true, isDynamic: false }],
    } as unknown as RouteAnalyzer;

    await assert.rejects(
      resolveRoute({ baseUrl: "http://x", route: "/home", section: "Club Fitings" }, routeAnalyzer, scanner, cache),
      (err: Error) => /Club Fitings/.test(err.message) && /Club Fittings/.test(err.message)
    );
    const ok = await resolveRoute(
      { baseUrl: "http://x", route: "/home", section: "club fittings" }, routeAnalyzer, scanner, cache
    );
    assert.equal(ok.url, "http://x/home?view=Club%20Fittings");
  });
});

const BUILDER = `<template>
  <div>
    <InProgressFittings v-if="activeSection === 'projects' && fitterAccountId" />
    <BuilderProjectsTab v-if="activeSection === 'projects'" />
    <BuilderPipelineTab v-else-if="activeSection === 'pipeline'" />
    <BuilderOrdersTab v-else-if="activeSection === 'orders' && fitterAccount" />
  </div>
</template>
<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { useRoute } from "vue-router";
const route = useRoute();
function resolveSection(value: unknown): SectionId | null {
  if (typeof value !== "string") return null;
  if (SECTIONS.some((s) => s.id === value)) return value as SectionId;
  return LEGACY_TAB_ALIASES[value] ?? null;
}
const activeSection = ref<SectionId>("projects");
watch(() => route.query.tab, (tab) => {
  const section = resolveSection(tab);
  if (section && section !== activeSection.value) activeSection.value = section;
});
</script>`;

test("a validating identity function passes the query value through; extra-conditioned gates are secondary", () => {
  const vc = extractVueViewContainer(BUILDER, "FitterBuilderDashboard")!;
  assert.deepEqual(vc.sections.map((s) => s.id), ["projects", "pipeline", "orders"]);
  const projects = vc.sections.find((s) => s.id === "projects") as any;
  assert.equal(projects.child, "BuilderProjectsTab");
  assert.deepEqual(projects.alsoRenders, ["InProgressFittings"]);
  assert.deepEqual(projects.queryParam, { key: "tab", value: "projects" });
  const orders = vc.sections.find((s) => s.id === "orders") as any;
  assert.deepEqual(orders.alsoRequires, ["fitterAccount"]);
});
