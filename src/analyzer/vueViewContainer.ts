import { NodeTypes } from "@vue/compiler-dom";
import type { ElementNode } from "@vue/compiler-dom";
import {
  parseSfc,
  walkElements,
  isComponentElement,
  pascalize,
  staticAttr,
  staticTextOf,
  eventBindings,
  expressionSource,
} from "./sfcParser.js";
import { VUE_BUILTINS } from "./vueTemplate.js";
import { parseGateDisjuncts, type GateDisjunct } from "./gateExpression.js";
import {
  findVueRouteQueryKey,
  activatorSelector,
  type Section,
  type ViewContainer,
} from "./viewContainer.js";

/**
 * Detect a Vue view container: a component whose template gates sibling views on
 * a single reactive variable via `v-if`/`v-show`/`v-else-if` compared to string
 * literals — `<Prescriptions v-if="currentView === 'prescriptions'" />` — and
 * (usually) switches it with `@click="currentView = 'x'"`. Returns null when no
 * variable multiplexes ≥2 literal-keyed views.
 *
 * Keys off Vue directives and reactive-variable equality only — never off any
 * app-specific name — so it generalizes to any tab/section shell.
 */
export function extractVueViewContainer(source: string, componentName: string): ViewContainer | null {
  const { templateAst } = parseSfc(source);
  if (!templateAst) return null;

  // Every gated element, one entry per `||` disjunct, in source order.
  const gates: Array<{ disjunct: GateDisjunct; child?: string }> = [];
  // var -> distinct literal values, in first-seen order.
  const valuesByVar = new Map<string, Set<string>>();
  // "var\0value" -> the element whose @click assigns that literal to the var.
  const activators = new Map<string, ElementNode>();

  walkElements(templateAst, (el) => {
    for (const p of el.props) {
      if (p.type !== NodeTypes.DIRECTIVE) continue;
      if (p.name === "if" || p.name === "show" || p.name === "else-if") {
        if (!p.exp) continue;
        const child = namedChild(el) ?? firstComponentIn(el);
        for (const disjunct of parseGateDisjuncts(expressionSource(p.exp))) {
          gates.push({ disjunct, child });
          for (const t of disjunct.terms) {
            if (!valuesByVar.has(t.var)) valuesByVar.set(t.var, new Set());
            valuesByVar.get(t.var)!.add(t.value);
          }
        }
      }
    }
    // Click handlers that assign a literal to a variable are section switches.
    for (const ev of eventBindings(el)) {
      if (ev.event !== "click" || !ev.expression) continue;
      for (const asg of parseClickAssignments(ev.expression)) {
        const key = `${asg.var}\0${asg.value}`;
        if (!activators.has(key)) activators.set(key, el);
      }
    }
  });

  // The container variable is the one multiplexing the most literal-keyed
  // views. On a tie, prefer the one whose literal is unique per gated view
  // (the tab in `section && tab`), so section ids don't collide.
  const repeats = (v: string) =>
    gates.filter((g) => g.disjunct.terms.some((t) => t.var === v)).length - valuesByVar.get(v)!.size;
  let chosen: string | undefined;
  for (const [v, values] of valuesByVar) {
    if (values.size < 2) continue;
    if (!chosen) {
      chosen = v;
      continue;
    }
    const best = valuesByVar.get(chosen)!.size;
    if (values.size > best || (values.size === best && repeats(v) < repeats(chosen))) chosen = v;
  }
  if (!chosen) return null;

  // Variables that gate TOGETHER with the selector (`section && tab`) are part
  // of the same switch; a gate on an unrelated variable (a modal flag) is not.
  const related = new Set<string>([chosen]);
  for (const { disjunct } of gates) {
    const vars = disjunct.terms.map((t) => t.var);
    if (vars.includes(chosen)) vars.forEach((v) => related.add(v));
  }

  const queryKeys = new Map<string, string | undefined>();
  const queryKeyOf = (v: string) => {
    if (!queryKeys.has(v)) queryKeys.set(v, findVueRouteQueryKey(source, v));
    return queryKeys.get(v);
  };

  const sections: Section[] = [];
  const idSignature = new Map<string, string>();
  const byId = new Map<string, Section>();
  for (const { disjunct, child } of gates) {
    const terms = disjunct.terms;
    if (!terms.every((t) => related.has(t.var))) continue;
    const primary = terms.find((t) => t.var === chosen) ?? terms[0];
    const conditions = Object.fromEntries(terms.map((t) => [t.var, t.value]));
    const signature = JSON.stringify(conditions);

    // The id is the selector's literal; if two different gates would share it,
    // qualify the later one with its other values so every id stays unique.
    let id = primary.value;
    const prior = idSignature.get(id);
    if (prior === signature) {
      // Another element rendered by the same section (a header strip plus the
      // tab body). The one gated by the equality ALONE is the section's main
      // view; extra-conditioned ones (`&& fitterAccountId`) are secondary.
      const existing = byId.get(id)!;
      if (child && child !== existing.child) {
        if (existing.alsoRequires && !disjunct.extra) {
          if (existing.child) existing.alsoRenders = [...(existing.alsoRenders ?? []), existing.child];
          existing.child = child;
          delete existing.alsoRequires;
        } else if (!existing.alsoRenders?.includes(child)) {
          existing.alsoRenders = [...(existing.alsoRenders ?? []), child];
        }
      }
      continue;
    }
    if (prior !== undefined) id = terms.map((t) => t.value).join(" / ");
    if (idSignature.has(id)) continue;
    idSignature.set(id, signature);

    const section: Section = { id, reachedBy: "unknown" };
    if (child) section.child = child;
    if (terms.length > 1) section.conditions = conditions;
    if (disjunct.extra) section.alsoRequires = disjunct.extra;

    const activatorEl = activators.get(`${primary.var}\0${primary.value}`);
    if (activatorEl) {
      const label = activatorText(activatorEl);
      const selector = activatorSelector(staticAttr(activatorEl, "data-testid"), label);
      if (selector) section.activator = { selector, ...(label ? { label } : {}) };
    }

    const keys = terms.map((t) => ({ t, key: queryKeyOf(t.var) }));
    if (keys.every((k) => k.key)) {
      const primaryKey = keys.find((k) => k.t === primary)!;
      section.reachedBy = "query";
      section.queryParam = { key: primaryKey.key!, value: primary.value };
      const others = keys.filter((k) => k.t !== primary).map((k) => ({ key: k.key!, value: k.t.value }));
      if (others.length) section.alsoQuery = others;
    } else if (activatorEl && terms.length === 1) {
      section.reachedBy = "click";
    }
    sections.push(section);
    byId.set(id, section);
  }

  return { container: componentName, selector: chosen, framework: "vue", sections };
}

/** The PascalCase name of a real child component element (builtins/`<component>` excluded). */
function namedChild(el: ElementNode): string | undefined {
  if (!isComponentElement(el) || el.tag === "component") return undefined;
  const name = pascalize(el.tag);
  return VUE_BUILTINS.has(name) ? undefined : name;
}

/** First descendant component of a section wrapper (`<div v-if="…"><List/></div>`), depth-first. */
function firstComponentIn(el: ElementNode): string | undefined {
  for (const c of el.children) {
    if (c.type !== NodeTypes.ELEMENT) continue;
    const child = c as ElementNode;
    const found = namedChild(child) ?? firstComponentIn(child);
    if (found) return found;
  }
  return undefined;
}

/** Static, human-readable label for an activator: visible text or aria-label. */
function activatorText(el: ElementNode): string | undefined {
  const text = staticTextOf(el).replace(/\s+/g, " ").trim();
  return text || staticAttr(el, "aria-label") || undefined;
}

/**
 * Assignments of a string literal to a variable inside a handler expression:
 * `currentView = 'x'`, `view.value = 'x'`, `() => currentView = 'x'`. The
 * lookarounds keep `===`/`!==`/`<=`/`>=` comparisons from matching.
 */
function parseClickAssignments(expr: string): Array<{ var: string; value: string }> {
  const re = /([A-Za-z_$][\w$]*)(?:\.value)?\s*(?<![=!<>])=(?!=)\s*(['"])(.*?)\2/g;
  const out: Array<{ var: string; value: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr))) out.push({ var: m[1], value: m[3] });
  return out;
}
