import { escapeRegex } from "../util.js";
import { parseEqualityGate, findVueRouteQueryKey } from "../analyzer/viewContainer.js";

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

  // Simple literal equality only (`X === 'lit'` / `'lit' == X`); a more complex
  // gate is still reported, condition-only, so callers know an interaction is needed.
  const gate = parseEqualityGate(condition);
  if (!gate) return { condition };

  const queryKey = findVueRouteQueryKey(pageSource, gate.var);
  return { condition, queryValue: gate.value, queryKey };
}
