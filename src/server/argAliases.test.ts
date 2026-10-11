import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchToolCall, type ToolContext } from "./dispatch.js";
import { CacheManager } from "../cache/cacheManager.js";
import { CATALOG_TOOLS } from "./toolDefs.catalog.js";
import { BROWSER_TOOLS } from "./toolDefs.browser.js";
import type { Component, ComponentCatalog } from "../types.js";
import type { ComponentScanner } from "../scanner/componentScanner.js";

/**
 * F17: argument names are inconsistent across tools (`name` vs `component`),
 * so `get_data_flow({component: …})` failed with "Missing required argument:
 * name". Tool descriptions also still carried component-intelligence's
 * medical/React examples (PatientDetail, useHandoffState, src/hooks/useUsers.ts).
 */

const node: Component = {
  name: "OrderList", path: "/fake/src/components/OrderList.vue", relativePath: "src/components/OrderList.vue",
  category: "t", architectureLayer: "component", lastModified: 0,
};
const catalog: ComponentCatalog = { components: [node], categories: {}, totalCount: 1, lastScanned: 0 };

function ctx(): ToolContext {
  const cache = new CacheManager();
  cache.setCatalog(catalog);
  return {
    workspaceRoot: "/fake", config: {}, browserConfig: {},
    scanner: { scan: async () => catalog } as unknown as ComponentScanner,
    cache,
  } as unknown as ToolContext;
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

test("`component` is accepted where a tool expects `name`", async () => {
  for (const tool of ["get_data_flow", "get_dependency_chain", "get_component_detail"]) {
    const r = (await dispatchToolCall(tool, { component: "OrderList" }, ctx())) as { isError?: boolean };
    assert.ok(!r.isError, `${tool}: ${text(r)}`);
  }
});

test("other common aliases map to the canonical argument", async () => {
  const sim = (await dispatchToolCall("find_similar_components", { query: "order list" }, ctx())) as { isError?: boolean };
  assert.ok(!sim.isError, text(sim));
  const search = (await dispatchToolCall("search_components", { name: "OrderList" }, ctx())) as { isError?: boolean };
  assert.ok(!search.isError, text(search));
});

test("tool descriptions carry no medical/React leftovers", () => {
  const all = JSON.stringify([...CATALOG_TOOLS, ...BROWSER_TOOLS]);
  for (const word of ["PatientDetail", "useHandoffState", "patientAdapter", "usePatientData", "CompleteHandoffButton", "useUsers.ts", "/patients/"]) {
    assert.ok(!all.includes(word), `still mentions ${word}`);
  }
});
