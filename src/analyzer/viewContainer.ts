import { escapeRegex } from "../util.js";

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
 * compared against — `X === 'lit'` or `'lit' == X`, either side, 2 or 3 `=`,
 * with an optional Vue `.value` unwrap. Returns null for anything that isn't a
 * plain literal equality (comparisons to constants/enums, `!==`, `&&` chains).
 * Shared by the Vue view-gate detector and both view-container extractors so
 * "what counts as a section gate" is defined once.
 */
export function parseEqualityGate(expr: string): { var: string; value: string } | null {
  const m =
    /^\s*(?:([A-Za-z_$][\w$]*)(?:\.value)?\s*===?\s*(['"])(.*?)\2|(['"])(.*?)\4\s*===?\s*([A-Za-z_$][\w$]*)(?:\.value)?)\s*$/.exec(
      expr
    );
  if (!m) return null;
  const varName = m[1] ?? m[6];
  const value = m[3] ?? m[5];
  return { var: varName, value };
}

/**
 * Trace a Vue gate variable to the `route.query` key that drives it, so a
 * section can be revealed by URL instead of a click. Three wiring shapes cover
 * the common view containers:
 *  1. reverse sync:  router.replace({ query: { view: currentView.value } })
 *  2. watch/assign:  a `route.query.<key>` read followed shortly by an
 *                    assignment INTO the var
 *  3. direct init:   currentView = <expr involving> route.query.view
 * Returns undefined when no query wiring is found (the section is click-only).
 */
export function findVueRouteQueryKey(source: string, varName: string): string | undefined {
  const v = escapeRegex(varName);

  let m = new RegExp(`query:\\s*\\{\\s*(\\w+):\\s*${v}\\b`).exec(source);
  if (m) return m[1];

  m = new RegExp(`route\\.query\\.(\\w+)[\\s\\S]{0,300}?\\b${v}(?:\\.value)?\\s*=[^=]`).exec(source);
  if (m) return m[1];

  m = new RegExp(`\\b${v}(?:\\.value)?\\s*=[^=][^;\\n]*route\\.query\\.(\\w+)`).exec(source);
  if (m) return m[1];

  return undefined;
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
