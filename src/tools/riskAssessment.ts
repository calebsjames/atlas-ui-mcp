import type { ArchitectureLayer } from "../types.js";

/**
 * Risk classification for whats_affected: how much verification does a change
 * to this file deserve? Deliberately an explainable additive score — every
 * point traces to a named factor the agent can quote back to the user —
 * rather than an opaque weight blend. Levels:
 *
 *   low      — leaf change; check the one route it surfaces on (if any).
 *   medium   — shared code with real upstream reach; verify the listed routes.
 *   high     — API-contract/shared-state layer or a wide blast radius; verify
 *              every listed route and the data flows through it.
 *   critical — app-global reach (root affected, or very wide radius); impact
 *              can surface beyond affectedRoutes — verify broadly.
 */

export type RiskLevel = "low" | "medium" | "high" | "critical";

/** Signals for one changed file (seed), derived from its OWN upstream walk. */
export interface SeedRiskInput {
  layer: ArchitectureLayer;
  /** Items the seed's upstream walk reaches, excluding the seed itself. */
  blastRadius: number;
  /** Distance-1 users — files that import/render/hook-consume the seed directly. */
  directDependents: number;
  /** Routes reachable from the seed's affected set. */
  routesAffected: number;
  /** An app-root item (src/App.*, src/main.*) is in the seed's affected set. */
  reachesRoot: boolean;
  /** At least one affected route is unprotected (publicly reachable). */
  affectsPublicRoute: boolean;
}

export interface SeedRisk {
  level: RiskLevel;
  /** Additive factor total. Comparable within one response, not across projects. */
  score: number;
  /** Scoring breakdown, largest contributor first. */
  factors: string[];
  blastRadius: number;
  directDependents: number;
  routesAffected: number;
}

/**
 * Base weight per layer: how structurally dangerous is a change HERE, before
 * counting who consumes it. Contract and shared-state layers outrank UI leaves.
 */
const LAYER_WEIGHTS: Record<ArchitectureLayer, number> = {
  root: 40,
  adapter: 25,
  service: 25,
  store: 20,
  context: 20,
  hook: 15,
  util: 10,
  dto: 10,
  type: 10,
  component: 8,
  page: 5,
};

const LAYER_RATIONALE: Partial<Record<ArchitectureLayer, string>> = {
  root: "app root hosts app-global UI",
  adapter: "the API-contract surface",
  service: "shared business logic on the API path",
  store: "shared mutable state",
  context: "shared state visible to whole subtrees",
  hook: "shared logic consumed across components",
  dto: "a data shape other layers depend on",
  type: "a type contract other layers depend on",
};

/** [threshold, points] bands, checked highest-first; below the last band = 0. */
type Bands = readonly (readonly [number, number])[];
const RADIUS_BANDS: Bands = [
  [50, 40],
  [25, 30],
  [10, 20],
  [4, 10],
  [1, 5],
];
const ROUTE_BANDS: Bands = [
  [10, 25],
  [4, 15],
  [2, 10],
  [1, 5],
];
const DEPENDENT_BANDS: Bands = [
  [10, 12],
  [3, 6],
  [1, 3],
];

const ROOT_REACH_POINTS = 40;
const PUBLIC_ROUTE_POINTS = 5;

/** Score thresholds for levels, checked highest-first; below all = "low". */
const LEVEL_THRESHOLDS: readonly (readonly [number, RiskLevel])[] = [
  [70, "critical"],
  [45, "high"],
  [20, "medium"],
];

const LEVEL_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function bandPoints(value: number, bands: Bands): number {
  for (const [threshold, points] of bands) {
    if (value >= threshold) return points;
  }
  return 0;
}

export function assessSeedRisk(input: SeedRiskInput): SeedRisk {
  const contributions: { text: string; points: number }[] = [];

  const layerPoints = LAYER_WEIGHTS[input.layer] ?? LAYER_WEIGHTS.component;
  const rationale = LAYER_RATIONALE[input.layer];
  contributions.push({
    text: `${input.layer} layer${rationale ? ` — ${rationale}` : ""} (+${layerPoints})`,
    points: layerPoints,
  });

  const radiusPoints = bandPoints(input.blastRadius, RADIUS_BANDS);
  if (radiusPoints > 0) {
    contributions.push({
      text: `blast radius ${input.blastRadius} — upstream items affected (+${radiusPoints})`,
      points: radiusPoints,
    });
  }

  const routePoints = bandPoints(input.routesAffected, ROUTE_BANDS);
  if (routePoints > 0) {
    contributions.push({
      text: `${input.routesAffected} route(s) reachable from this change (+${routePoints})`,
      points: routePoints,
    });
  }

  const dependentPoints = bandPoints(input.directDependents, DEPENDENT_BANDS);
  if (dependentPoints > 0) {
    contributions.push({
      text: `${input.directDependents} direct dependent(s) (+${dependentPoints})`,
      points: dependentPoints,
    });
  }

  if (input.reachesRoot) {
    contributions.push({
      text: `reaches the app root — impact can surface on ANY route (+${ROOT_REACH_POINTS})`,
      points: ROOT_REACH_POINTS,
    });
  }

  if (input.affectsPublicRoute) {
    contributions.push({
      text: `affects a publicly reachable (unprotected) route (+${PUBLIC_ROUTE_POINTS})`,
      points: PUBLIC_ROUTE_POINTS,
    });
  }

  const score = contributions.reduce((sum, c) => sum + c.points, 0);
  contributions.sort((a, b) => b.points - a.points);

  return {
    level: levelForScore(score),
    score,
    factors: contributions.map((c) => c.text),
    blastRadius: input.blastRadius,
    directDependents: input.directDependents,
    routesAffected: input.routesAffected,
  };
}

export function levelForScore(score: number): RiskLevel {
  for (const [threshold, level] of LEVEL_THRESHOLDS) {
    if (score >= threshold) return level;
  }
  return "low";
}

/** The most severe level among the given ones ("low" for an empty list). */
export function maxRiskLevel(levels: RiskLevel[]): RiskLevel {
  let max: RiskLevel = "low";
  for (const level of levels) {
    if (LEVEL_ORDER[level] > LEVEL_ORDER[max]) max = level;
  }
  return max;
}
