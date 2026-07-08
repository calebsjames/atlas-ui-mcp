import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessSeedRisk,
  levelForScore,
  maxRiskLevel,
  type SeedRiskInput,
} from "./riskAssessment.js";

function input(overrides: Partial<SeedRiskInput> = {}): SeedRiskInput {
  return {
    layer: "component",
    blastRadius: 0,
    directDependents: 0,
    routesAffected: 0,
    reachesRoot: false,
    affectsPublicRoute: false,
    ...overrides,
  };
}

test("leaf component with no consumers is low", () => {
  const risk = assessSeedRisk(input());
  assert.equal(risk.level, "low");
  assert.equal(risk.score, 8); // component layer weight only
  assert.equal(risk.factors.length, 1);
});

test("page that only surfaces on its own route is low", () => {
  const risk = assessSeedRisk(input({ layer: "page", routesAffected: 1 }));
  assert.equal(risk.level, "low");
  assert.equal(risk.score, 10); // page 5 + 1 route 5
});

test("component rendered on a live route is medium", () => {
  const risk = assessSeedRisk(
    input({ blastRadius: 1, directDependents: 1, routesAffected: 1 })
  );
  assert.equal(risk.level, "medium");
  assert.equal(risk.score, 21); // component 8 + radius 5 + route 5 + dependent 3
});

test("adapter with moderate fan-out is high", () => {
  const risk = assessSeedRisk(
    input({ layer: "adapter", blastRadius: 12, directDependents: 4, routesAffected: 3 })
  );
  assert.equal(risk.level, "high");
  assert.equal(risk.score, 61); // adapter 25 + radius 20 + routes 10 + dependents 6
});

test("service with wide blast radius is critical", () => {
  const risk = assessSeedRisk(
    input({ layer: "service", blastRadius: 30, directDependents: 10, routesAffected: 6 })
  );
  assert.equal(risk.level, "critical");
  assert.equal(risk.score, 82); // service 25 + radius 30 + dependents 12 + routes 15
});

test("hook with a handful of consumers stays medium", () => {
  const risk = assessSeedRisk(
    input({ layer: "hook", blastRadius: 5, directDependents: 3, routesAffected: 2 })
  );
  assert.equal(risk.level, "medium");
  assert.equal(risk.score, 41); // hook 15 + radius 10 + routes 10 + dependents 6
});

test("reaching the app root forces critical for any layer", () => {
  const risk = assessSeedRisk(
    input({ blastRadius: 3, directDependents: 2, reachesRoot: true, routesAffected: 4 })
  );
  // component 8 + radius 5 + dependents 3 + routes 15 + root 40 = 71
  assert.equal(risk.level, "critical");
  assert.ok(risk.factors.some((f) => f.includes("app root")));
});

test("app-root seed itself is critical", () => {
  const risk = assessSeedRisk(input({ layer: "root", reachesRoot: true }));
  assert.equal(risk.level, "critical");
});

test("public route exposure adds a named factor", () => {
  const risk = assessSeedRisk(input({ routesAffected: 1, affectsPublicRoute: true }));
  assert.ok(risk.factors.some((f) => f.includes("publicly reachable")));
  assert.equal(risk.score, 18); // component 8 + route 5 + public 5
});

test("factors are ordered largest contributor first", () => {
  const risk = assessSeedRisk(input({ layer: "page", blastRadius: 60 }));
  // radius (+40) outranks page layer (+5)
  assert.ok(risk.factors[0].includes("blast radius"));
});

test("more blast radius never lowers the level", () => {
  const radii = [0, 1, 4, 10, 25, 50, 200];
  const order = { low: 0, medium: 1, high: 2, critical: 3 };
  let prev = -1;
  for (const blastRadius of radii) {
    const { level } = assessSeedRisk(input({ layer: "service", blastRadius }));
    assert.ok(order[level] >= prev, `level dropped at radius ${blastRadius}`);
    prev = order[level];
  }
});

test("levelForScore thresholds", () => {
  assert.equal(levelForScore(0), "low");
  assert.equal(levelForScore(19), "low");
  assert.equal(levelForScore(20), "medium");
  assert.equal(levelForScore(44), "medium");
  assert.equal(levelForScore(45), "high");
  assert.equal(levelForScore(69), "high");
  assert.equal(levelForScore(70), "critical");
});

test("maxRiskLevel picks the most severe", () => {
  assert.equal(maxRiskLevel([]), "low");
  assert.equal(maxRiskLevel(["low", "medium", "low"]), "medium");
  assert.equal(maxRiskLevel(["high", "critical", "medium"]), "critical");
});
