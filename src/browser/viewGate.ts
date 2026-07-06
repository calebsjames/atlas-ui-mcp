import { escapeRegex } from "../tools/shared.js";

/**
 * A conditional render gate on a child component inside a routed page — the
 * "view container" pattern (HomePage, PrescriberDashboard): the page renders
 * `<Child v-if="currentView === 'Some View'" />` and keeps `currentView` in
 * sync with a `route.query.<key>` param. Resolving the child to the parent's
 * route alone lands on the container's DEFAULT view; appending the query param
 * is what actually reveals the child.
 */
export interface ViewGate {
  /** The raw v-if / v-show expression gating the child's render. */
  condition: string;
  /** The string literal the gate compares against, when the condition is a simple equality. */
  queryValue?: string;
  /** The route.query key wired to the gate variable, when detectable. */
  queryKey?: string;
}

/**
 * Detect a query-param-driven render gate for `childName` inside a page
 * component's source. Returns null when the child's tag has no v-if / v-show.
 * When a gate exists but its variable can't be traced to a route.query key,
 * the gate is still returned (condition only) so callers can report it.
 */
export function detectViewGate(pageSource: string, childName: string): ViewGate | null {
  const escaped = escapeRegex(childName);
  // The child's opening tag, multiline-tolerant: `<Child` up to the first `>`.
  const tagMatch = new RegExp(`<${escaped}(?![\\w-])([\\s\\S]*?)>`).exec(pageSource);
  if (!tagMatch) return null;

  const attrs = tagMatch[1];
  const condMatch = /v-(?:if|show)\s*=\s*(?:"([^"]+)"|'([^']+)')/.exec(attrs);
  if (!condMatch) return null;
  const condition = (condMatch[1] ?? condMatch[2]).trim();

  // Simple equality only: `X === 'lit'` / `'lit' == X` (either side, 2 or 3 =).
  const eq =
    /^(?:([A-Za-z_$][\w$]*)(?:\.value)?\s*===?\s*(['"])(.*?)\2|(['"])(.*?)\4\s*===?\s*([A-Za-z_$][\w$]*)(?:\.value)?)$/.exec(
      condition
    );
  if (!eq) return { condition };

  const varName = (eq[1] ?? eq[6]) as string;
  const literal = (eq[3] ?? eq[5]) as string;
  const queryKey = findQueryKeyFor(pageSource, varName);
  return { condition, queryValue: literal, queryKey };
}

/**
 * Trace a gate variable to the route.query key that drives it. Three wiring
 * shapes cover the app's view containers:
 *  1. reverse sync:  router.replace({ query: { view: currentView.value } })
 *  2. watch/assign:  watch(() => route.query.view, ...) { currentView.value = ... }
 *     (any `route.query.<key>` followed shortly by an assignment INTO the var)
 *  3. direct init:   currentView = <something involving> route.query.view
 */
function findQueryKeyFor(source: string, varName: string): string | undefined {
  const v = escapeRegex(varName);

  let m = new RegExp(`query:\\s*\\{\\s*(\\w+):\\s*${v}\\b`).exec(source);
  if (m) return m[1];

  m = new RegExp(`route\\.query\\.(\\w+)[\\s\\S]{0,300}?\\b${v}(?:\\.value)?\\s*=[^=]`).exec(source);
  if (m) return m[1];

  m = new RegExp(`\\b${v}(?:\\.value)?\\s*=[^=][^;\\n]*route\\.query\\.(\\w+)`).exec(source);
  if (m) return m[1];

  return undefined;
}
