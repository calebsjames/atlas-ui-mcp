import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ComponentAnalyzer } from "./componentAnalyzer.js";

/**
 * Regression: a component bound via `defineAsyncComponent(() => import(...))`
 * AND mounted only by string through `<component :is="nameFromMap">` produced
 * NO graph edge at all — neither a static import nor a literal <Tag> exists.
 *
 * Observed in foreward-ui: BuildStationModal -> ProjectInfoTab was invisible to
 * find_component_usages, get_dependency_chain, and whats_affected.
 */

const STRING_MOUNTED_SFC = `
<template>
  <main>
    <component :is="activeTabComponent" v-bind="activeTabProps" />
  </main>
</template>

<script lang="ts">
import { defineAsyncComponent, computed } from "vue";
import NotesTab from "@/components/modalTabs/NotesTab.vue";

const ProjectInfoTab = defineAsyncComponent(
  () => import("@/components/projects/ProjectInfoTab.vue"),
);

export default {
  name: "StationModal",
  components: { NotesTab, ProjectInfoTab },
  setup() {
    const activeTab = "customer-info";
    const activeTabComponent = computed((): string => {
      const componentMap: Record<string, string> = {
        notes: "NotesTab",
        "customer-info": "ProjectInfoTab",
      };
      return componentMap[activeTab] || "NotesTab";
    });
    return { activeTabComponent };
  },
};
</script>
`;

/** Object-loader form, and no dynamic mount in the template. */
const OBJECT_LOADER_SFC = `
<template>
  <div><LazyPanel /></div>
</template>

<script setup lang="ts">
import { defineAsyncComponent } from "vue";
const LazyPanel = defineAsyncComponent({
  loader: () => import("@/components/panels/LazyPanel.vue"),
  delay: 200,
});
</script>
`;

/** A dynamic mount whose strings name nothing registered — must stay empty. */
const NO_FALSE_POSITIVE_SFC = `
<template>
  <component :is="icon" />
</template>

<script setup lang="ts">
const label = "ProjectInfoTab";
const other = "SomethingElse";
</script>
`;

/**
 * Real false positive from foreward-ui/FitterBuilderSidebar.vue: a nav label
 * string collides with an imported icon component, and `:is` binds a property
 * access, not a local symbol.
 */
const PROPERTY_ACCESS_BINDING_SFC = `
<template>
  <component :is="item.icon" />
</template>

<script setup lang="ts">
import { markRaw } from "vue";
import { Settings } from "lucide-vue-next";
const items = [{ id: "settings", label: "Settings", icon: markRaw(Settings) }];
</script>
`;

/**
 * Real false positive from foreward-ui/SidebarItem.vue: the quoted names live in
 * a TypeScript union TYPE, and `:is` binds an element access.
 */
const ELEMENT_ACCESS_BINDING_SFC = `
<template>
  <component :is="icons[icon]" />
</template>

<script setup lang="ts">
import { Home, Settings } from "lucide-vue-next";
const icons = { Home, Settings };
type IconName = "Home" | "Settings";
defineProps<{ icon: IconName }>();
</script>
`;

/**
 * Options-API form (foreward-ui PickupStationModal/ShipStationModal): the `:is`
 * target is a `computed: { ... }` member, not a `const`.
 */
const OPTIONS_API_COMPUTED_SFC = `
<template>
  <component :is="activeTabComponent" />
</template>

<script lang="ts">
import CustomerInfo from "@/components/modalTabs/CustomerInfo.vue";
import ClubsTab from "@/components/modalTabs/ClubsTab.vue";
export default {
  components: { CustomerInfo, ClubsTab },
  data() { return { activeTab: "clubs" }; },
  computed: {
    activeTabComponent(): string {
      const componentMap: Record<string, string> = {
        clubs: "ClubsTab",
        "customer-info": "CustomerInfo",
      };
      return componentMap[this.activeTab] || "ClubsTab";
    },
  },
};
</script>
`;

async function analyzeSfc(source: string, name: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-async-"));
  const file = path.join(dir, `${name}.vue`);
  await fs.writeFile(file, source, "utf-8");
  try {
    return await new ComponentAnalyzer().analyzeComponent(file, name, "component");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("defineAsyncComponent arrow form produces an import edge", async () => {
  const a = await analyzeSfc(STRING_MOUNTED_SFC, "StationModal");
  const names = (a.imports ?? []).flatMap((i) => i.names);
  assert.ok(
    names.includes("ProjectInfoTab"),
    `expected ProjectInfoTab in imports, got ${JSON.stringify(names)}`
  );
  const imp = (a.imports ?? []).find((i) => i.names.includes("ProjectInfoTab"));
  assert.equal(imp?.source, "@/components/projects/ProjectInfoTab.vue");
});

test("string-mounted component is recorded as a rendered child", async () => {
  const a = await analyzeSfc(STRING_MOUNTED_SFC, "StationModal");
  assert.ok(
    a.childComponents?.includes("ProjectInfoTab"),
    `expected ProjectInfoTab in childComponents, got ${JSON.stringify(a.childComponents)}`
  );
  // The statically imported tab is string-mounted too and must survive.
  assert.ok(a.childComponents?.includes("NotesTab"));
});

test("defineAsyncComponent object-loader form produces an import edge", async () => {
  const a = await analyzeSfc(OBJECT_LOADER_SFC, "Host");
  const imp = (a.imports ?? []).find((i) => i.names.includes("LazyPanel"));
  assert.ok(imp, "expected LazyPanel import edge from { loader: () => import(...) }");
  assert.equal(imp?.source, "@/components/panels/LazyPanel.vue");
});

test("dynamic mount does not invent children from unregistered strings", async () => {
  const a = await analyzeSfc(NO_FALSE_POSITIVE_SFC, "IconHost");
  assert.ok(
    !a.childComponents?.includes("ProjectInfoTab"),
    `string literal must not become a child when nothing registers it, got ${JSON.stringify(a.childComponents)}`
  );
});

test("`:is=\"item.icon\"` does not turn a nav label into a child edge", async () => {
  const a = await analyzeSfc(PROPERTY_ACCESS_BINDING_SFC, "FitterBuilderSidebar");
  assert.ok(
    !a.childComponents?.includes("Settings"),
    `label:"Settings" must not become a child of a property-access mount, got ${JSON.stringify(a.childComponents)}`
  );
});

test("Options-API `computed:` member resolves its string-mounted children", async () => {
  const a = await analyzeSfc(OPTIONS_API_COMPUTED_SFC, "PickupStationModal");
  for (const child of ["ClubsTab", "CustomerInfo"]) {
    assert.ok(
      a.childComponents?.includes(child),
      `expected ${child} as a child of an Options-API computed mount, got ${JSON.stringify(a.childComponents)}`
    );
  }
});

test("`:is=\"icons[icon]\"` does not turn union-type strings into child edges", async () => {
  const a = await analyzeSfc(ELEMENT_ACCESS_BINDING_SFC, "SidebarItem");
  for (const phantom of ["Home", "Settings"]) {
    assert.ok(
      !a.childComponents?.includes(phantom),
      `type-union string ${phantom} must not become a child, got ${JSON.stringify(a.childComponents)}`
    );
  }
});
