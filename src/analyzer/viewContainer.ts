import { parseSingleEquality } from "./gateExpression.js";
import { findRouteQueryKeyFlowingInto } from "./routeQueryFlow.js";

/**
 * The "section map" model — a framework-blind description of a component that
 * multiplexes several mutually-exclusive sub-views off a SINGLE state variable.
 * This is the "one route, many sections" shell (a role shell / tabbed page /
 * sidebar switch) that a route-centric map can't see: everything lives under
 * one URL and the lists are section switches, not routes.
 *
 * Vue and React express the pattern differently — `v-if="view === 'x'"` +
 * `@click="view = 'x'"` vs. `{tab === 'x' && <X/>}` + `onClick={() =>
 * setTab('x')}` — but the shape they reduce to is identical, so per-framework
 * extractors (vueViewContainer / reactViewContainer) feed this one model and
 * every consumer stays framework-agnostic.
 */

/** How a section is revealed at runtime. */
export type SectionReachedBy = "query" | "click" | "unknown";

/** The control that switches to a section, for driving the page (Phase 3). */
export interface SectionActivator {
  /** Drivable selector: `[data-testid="…"]` preferred, else a `text=…` selector. */
  selector: string;
  /** Human label (visible text / aria-label), when available. */
  label?: string;
}

/** One sub-view multiplexed by the container's selector variable. */
export interface Section {
  /** The literal the selector variable takes for this section (e.g. "prescriptions"). */
  id: string;
  /** Component rendered for this section, when the gated element is (or wraps) one. */
  child?: string;
  /** How to reveal it: a URL query param, a click, or (best-effort) unknown. */
  reachedBy: SectionReachedBy;
  /** When the selector syncs to a URL query key: the key + this section's value. */
  queryParam?: { key: string; value: string };
  /**
   * Compound gate (`activeSection === 'Projects' && activeTab === 'X'`): every
   * variable the section needs, with its value. Absent for a one-variable gate.
   */
  conditions?: Record<string, string>;
  /** Query params for the compound gate's OTHER variables, when all are URL-synced. */
  alsoQuery?: Array<{ key: string; value: string }>;
  /** Non-equality conjuncts the gate also requires (`isAdmin`), as source. */
  alsoRequires?: string[];
  /** Other components the same section renders (a header strip beside the tab body). */
  alsoRenders?: string[];
  /** The control that switches to this section, when statically identifiable. */
  activator?: SectionActivator;
}

/** A component that multiplexes sub-views off one state variable. */
export interface ViewContainer {
  /** The component hosting the switch. */
  container: string;
  /** The state variable the switch keys on (e.g. "currentView", "activeTab"). */
  selector: string;
  /** Which framework the container was parsed as. */
  framework: "vue" | "react";
  /** The multiplexed sections, in source order. */
  sections: Section[];
}

/**
 * Parse a simple equality gate into the variable and the string literal it's
 * compared against — `X === 'lit'` or `'lit' == X`, either side, with an
 * optional Vue `.value` unwrap. Returns null for anything that isn't ONE plain
 * literal equality (disjunctions, `&&` compounds, comparisons to constants).
 * Parsed with the TypeScript AST (see gateExpression.ts); callers that need
 * the full `||` / `&&` structure use parseGateDisjuncts directly.
 */
export function parseEqualityGate(expr: string): { var: string; value: string } | null {
  return parseSingleEquality(expr);
}

/**
 * Trace a Vue gate variable to the `route.query` key whose value flows into
 * it, so a section can be revealed by URL instead of a click. Only a real
 * data flow counts (see routeQueryFlow.ts) — a query read that merely sits
 * near an assignment, or reaches it through a lookup table, does not.
 * Returns undefined when no query wiring is found (the section is click-only).
 */
export function findVueRouteQueryKey(source: string, varName: string): string | undefined {
  return findRouteQueryKeyFlowingInto(source, varName);
}

/** Normalize a section id for matching: case-, whitespace-, `-` and `_`-insensitive. */
export function normalizeSectionId(id: string): string {
  return id.toLowerCase().replace(/[\s_-]+/g, "");
}

/** Best drivable selector for an activator element, given what we could read off it. */
export function activatorSelector(
  testId: string | undefined,
  label: string | undefined
): string | undefined {
  if (testId) return `[data-testid="${testId}"]`;
  const text = label?.replace(/\s+/g, " ").trim();
  if (text) return `text=${text.slice(0, 40)}`;
  return undefined;
}
