import { test } from "node:test";
import assert from "node:assert/strict";
import { CacheManager } from "../cache/cacheManager.js";
import { getHookDetail } from "./getHookDetail.js";
import { nameNotFound, isNameNotFound } from "./shared.js";
import type { ArchitectureLayer, Component, ComponentCatalog } from "../types.js";
import type { ComponentScanner } from "../scanner/componentScanner.js";

/**
 * A composable can live anywhere. The catalog is per-FILE with ONE primary
 * name, so `useImpersonation` — a secondary export of a module in
 * src/services/ — used to resolve to nothing at all, and the miss came back
 * with no suggestions. These pin both halves of that fix.
 */
function comp(
  partial: Partial<Component> & {
    name: string;
    relativePath: string;
    architectureLayer: ArchitectureLayer;
  }
): Component {
  return { path: `/fake/${partial.relativePath}`, category: "test", lastModified: 0, ...partial } as Component;
}

const FIXTURE: Component[] = [
  comp({
    name: "getImpersonationAccounts",
    relativePath: "src/services/impersonationService.ts",
    architectureLayer: "service",
    exportedNames: ["getImpersonationAccounts", "startImpersonation", "useImpersonation"],
  }),
  comp({
    name: "ImpersonationBanner",
    relativePath: "src/components/ImpersonationBanner.vue",
    architectureLayer: "component",
    hooks: ["useImpersonation"],
    imports: [
      {
        type: "named",
        names: ["useImpersonation"],
        source: "@/services/impersonationService",
        resolvedPath: "src/services/impersonationService.ts",
      },
    ],
  }),
  comp({ name: "useAuth", relativePath: "src/composables/useAuth.ts", architectureLayer: "hook" }),
];

const CATALOG: ComponentCatalog = {
  components: FIXTURE,
  categories: {},
  totalCount: FIXTURE.length,
  lastScanned: Date.now(),
};

/** A scanner stub: the cache is pre-seeded, so ensureCatalog never calls it. */
const scanner = {
  scan: async () => CATALOG,
} as unknown as ComponentScanner;

function seeded(): CacheManager {
  const cache = new CacheManager();
  cache.setCatalog(CATALOG);
  return cache;
}

test("a use*-named export resolves even from a service-layer file", async () => {
  const result = await getHookDetail({ name: "useImpersonation" }, scanner, seeded());
  assert.ok(!isNameNotFound(result) && !("ambiguous" in result));
  assert.equal(result.name, "useImpersonation");
  assert.equal(result.relativePath, "src/services/impersonationService.ts");
});

// The layer is where the FILE lives. Relabelling it "hook" would make the
// catalog disagree with search_components about the same file.
test("the layer stays honest and the caveat says the metadata is file-level", async () => {
  const result = await getHookDetail({ name: "useImpersonation" }, scanner, seeded());
  assert.ok(!isNameNotFound(result) && !("ambiguous" in result));
  assert.equal(result.architectureLayer, "service");
  assert.equal(result.isPrimaryExport, false);
  assert.equal(result.modulePrimaryName, "getImpersonationAccounts");
  assert.match(result.caveat, /secondary export/);
  assert.match(result.caveat, /FILE-level/);
});

// usedBy must follow the symbol asked for, not the module's primary name.
test("usedBy is scoped to the queried symbol, not the module name", async () => {
  const result = await getHookDetail({ name: "useImpersonation" }, scanner, seeded());
  assert.ok(!isNameNotFound(result) && !("ambiguous" in result));
  assert.deepEqual(
    result.usedBy.map((u) => u.name),
    ["ImpersonationBanner"]
  );
});

test("a primary-export composable still reports isPrimaryExport", async () => {
  const result = await getHookDetail({ name: "useAuth" }, scanner, seeded());
  assert.ok(!isNameNotFound(result) && !("ambiguous" in result));
  assert.equal(result.isPrimaryExport, true);
  assert.equal(result.architectureLayer, "hook");
});

// The silent miss cost the most time: found:false with an empty suggestions list.
test("a miss suggests the module that exports the name, flagged as matchedExport", () => {
  const result = nameNotFound("useImpersonationn", seeded());
  const hit = result.suggestions.find((s) => s.matchedExport === "useImpersonation");
  assert.ok(hit, "expected the secondary export to surface as a suggestion");
  assert.equal(hit!.relativePath, "src/services/impersonationService.ts");
  assert.equal(hit!.architectureLayer, "service");
});

test("an unresolvable name still returns found:false with a usable next step", async () => {
  const result = await getHookDetail({ name: "useZzzzQqqq" }, scanner, seeded());
  assert.ok(isNameNotFound(result));
  assert.match(result.message, /search_components|suggestions/);
});
