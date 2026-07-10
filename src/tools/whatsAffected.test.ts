import { test } from "node:test";
import assert from "node:assert/strict";
import { CacheManager } from "../cache/cacheManager.js";
import { whatsAffected, type WhatsAffectedResult } from "./whatsAffected.js";
import type { ArchitectureLayer, Component, ComponentCatalog } from "../types.js";
import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { RouteAnalyzer } from "../analyzer/routeAnalyzer.js";

/**
 * Fixture graph (arrows point UPSTREAM, i.e. "is consumed by"):
 *
 *   userAdapter → userService → useUsers → UsersPage (route /users, protected)
 *   UserCard    → UsersPage
 *   LoginPage   (route /login, public)
 *   OrphanWidget (no consumers, no route)
 */
function comp(
  partial: Partial<Component> & {
    name: string;
    relativePath: string;
    architectureLayer: ArchitectureLayer;
  }
): Component {
  return {
    path: `/fake/${partial.relativePath}`,
    category: "test",
    lastModified: 0,
    ...partial,
  } as Component;
}

const FIXTURE: Component[] = [
  comp({ name: "userAdapter", relativePath: "src/adapters/userAdapter.ts", architectureLayer: "adapter" }),
  comp({
    name: "userService",
    relativePath: "src/services/userService.ts",
    architectureLayer: "service",
    imports: [
      { type: "named", names: ["userAdapter"], source: "@/adapters/userAdapter", resolvedPath: "src/adapters/userAdapter.ts" },
    ],
  }),
  comp({
    name: "useUsers",
    relativePath: "src/hooks/useUsers.ts",
    architectureLayer: "hook",
    imports: [
      { type: "named", names: ["userService"], source: "@/services/userService", resolvedPath: "src/services/userService.ts" },
    ],
  }),
  comp({
    name: "UsersPage",
    relativePath: "src/pages/UsersPage.vue",
    architectureLayer: "page",
    hooks: ["useUsers"],
    childComponents: ["UserCard"],
    // UsersPage mounts UserCard only when a user is selected — the gatedBy case.
    childComponentRendering: { UserCard: { vIf: "selectedUser" } },
    imports: [
      { type: "named", names: ["useUsers"], source: "@/hooks/useUsers", resolvedPath: "src/hooks/useUsers.ts" },
      { type: "default", names: ["UserCard"], source: "@/components/UserCard", resolvedPath: "src/components/UserCard.vue" },
    ],
  }),
  comp({ name: "UserCard", relativePath: "src/components/UserCard.vue", architectureLayer: "component" }),
  comp({ name: "LoginPage", relativePath: "src/pages/LoginPage.vue", architectureLayer: "page" }),
  comp({ name: "OrphanWidget", relativePath: "src/components/OrphanWidget.vue", architectureLayer: "component" }),
];

const FIXTURE_ROUTES = [
  { path: "/users", component: "UsersPage", isProtected: true, isDynamic: false },
  { path: "/login", component: "LoginPage", isProtected: false, isDynamic: false },
];

function makeHarness() {
  const cache = new CacheManager();
  const catalog: ComponentCatalog = {
    components: FIXTURE,
    categories: {},
    totalCount: FIXTURE.length,
    lastScanned: 0,
  };
  cache.setCatalog(catalog);
  // Catalog is pre-seeded, so ensureCatalog never reaches the scanner.
  const scanner = { scan: async () => catalog } as unknown as ComponentScanner;
  const routeAnalyzer = {
    analyzeRoutes: async () => FIXTURE_ROUTES,
  } as unknown as RouteAnalyzer;
  return { cache, scanner, routeAnalyzer };
}

async function run(files: string[]): Promise<WhatsAffectedResult> {
  const { cache, scanner, routeAnalyzer } = makeHarness();
  const result = await whatsAffected(
    { files },
    scanner,
    cache,
    routeAnalyzer,
    "/fake",
    { devServerUrl: "http://localhost:5173" }
  );
  assert.ok(!("error" in result), `unexpected error: ${JSON.stringify(result)}`);
  return result as WhatsAffectedResult;
}

test("adapter change: full upstream chain, medium risk, route reached", async () => {
  const result = await run(["src/adapters/userAdapter.ts"]);

  const affectedNames = result.affectedItems.map((i) => i.name).sort();
  assert.deepEqual(affectedNames, ["UsersPage", "useUsers", "userAdapter", "userService"]);
  assert.deepEqual(result.affectedRoutes.map((r) => r.path), ["/users"]);

  const risk = result.changedFiles[0].risk;
  assert.ok(risk, "in-catalog changed file must carry a risk");
  // adapter 25 + blast radius 3 (+5) + 1 direct dependent (+3) + 1 route (+5)
  assert.equal(risk.score, 38);
  assert.equal(risk.level, "medium");
  assert.equal(risk.blastRadius, 3);
  assert.equal(risk.directDependents, 1);
  assert.equal(risk.routesAffected, 1);
  assert.ok(risk.factors[0].includes("adapter layer"));

  assert.equal(result.overallRisk?.level, "medium");
  assert.equal(result.overallRisk?.score, 38);
  assert.ok(result.overallRisk?.drivers[0].includes("src/adapters/userAdapter.ts"));
});

test("orphan component is low risk with empty blast radius", async () => {
  const result = await run(["src/components/OrphanWidget.vue"]);

  assert.equal(result.affectedRoutes.length, 0);
  const risk = result.changedFiles[0].risk;
  assert.equal(risk?.level, "low");
  assert.equal(risk?.blastRadius, 0);
  assert.equal(result.overallRisk?.level, "low");
});

test("public route exposure is scored", async () => {
  const result = await run(["src/pages/LoginPage.vue"]);

  const risk = result.changedFiles[0].risk;
  assert.equal(risk?.routesAffected, 1);
  assert.ok(risk?.factors.some((f) => f.includes("publicly reachable")));
  // page 5 + 1 route (+5) + public (+5)
  assert.equal(risk?.score, 15);
  assert.equal(risk?.level, "low");
});

test("multi-seed: per-seed risks, overall = max, riskiest routes first", async () => {
  // LoginPage (low, /login) listed BEFORE the adapter (medium, /users) —
  // affectedRoutes and suggestedChecks must still lead with /users.
  const result = await run(["src/pages/LoginPage.vue", "src/adapters/userAdapter.ts"]);

  assert.equal(result.changedFiles[0].risk?.level, "low");
  assert.equal(result.changedFiles[1].risk?.level, "medium");
  assert.equal(result.overallRisk?.level, "medium");
  assert.equal(result.overallRisk?.drivers.length, 1); // low seeds are not drivers

  assert.deepEqual(result.affectedRoutes.map((r) => r.path), ["/users", "/login"]);
  assert.ok(result.suggestedChecks[0].includes("/users"));
});

test("file outside the catalog gets a note and no risk", async () => {
  const result = await run(["src/pages/LoginPage.vue", "src/nowhere/Ghost.vue"]);

  const ghost = result.changedFiles.find((f) => f.file === "src/nowhere/Ghost.vue");
  assert.ok(ghost);
  assert.equal(ghost.inCatalog, false);
  assert.equal(ghost.risk, undefined);
  assert.ok(ghost.note);
  // overallRisk still computed from the in-catalog seed
  assert.equal(result.overallRisk?.level, "low");
});

test("narrowed maxDistance under-counts and says so", async () => {
  const { cache, scanner, routeAnalyzer } = makeHarness();
  const result = (await whatsAffected(
    { files: ["src/adapters/userAdapter.ts"], maxDistance: 1 },
    scanner,
    cache,
    routeAnalyzer,
    "/fake",
    { devServerUrl: "http://localhost:5173" }
  )) as WhatsAffectedResult;

  const risk = result.changedFiles[0].risk;
  assert.equal(risk?.blastRadius, 1); // only userService within distance 1
  assert.ok(result.notes.some((n) => n.includes("maxDistance=1")));
});

test("a gated mount surfaces as gatedBy, with a drive-the-guard note", async () => {
  // UsersPage mounts UserCard only under v-if="selectedUser" (fixture), and it
  // is UserCard's ONLY direct dependent — so the aggregate note must fire too.
  const result = await run(["src/components/UserCard.vue"]);

  const page = result.affectedItems.find((i) => i.name === "UsersPage");
  assert.ok(page, "UsersPage must be affected by a UserCard change");
  assert.equal(page.distance, 1);
  assert.equal(page.gatedBy, "v-if: selectedUser");

  assert.ok(
    result.notes.some((n) => n.includes("only reached behind template guards")),
    `expected a gating note, got ${JSON.stringify(result.notes)}`
  );
});

test("non-render edges carry no gatedBy", async () => {
  // userService imports the adapter (no template mount) — nothing is gated,
  // and the aggregate note must not fire.
  const result = await run(["src/adapters/userAdapter.ts"]);

  assert.ok(result.affectedItems.every((i) => i.gatedBy === undefined));
  assert.ok(!result.notes.some((n) => n.includes("template guards")));
});
