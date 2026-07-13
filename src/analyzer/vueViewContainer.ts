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
import {
  parseEqualityGate,
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

  // var -> (section literal -> child component), in first-seen order.
  const gatesByVar = new Map<string, Map<string, string | undefined>>();
  const varOrder: string[] = [];
  // "var\0value" -> the element whose @click assigns that literal to the var.
  const activators = new Map<string, ElementNode>();

  walkElements(templateAst, (el) => {
    for (const p of el.props) {
      if (p.type !== NodeTypes.DIRECTIVE) continue;
      if (p.name === "if" || p.name === "show" || p.name === "else-if") {
        if (!p.exp) continue;
        const gate = parseEqualityGate(expressionSource(p.exp));
        if (!gate) continue;
        if (!gatesByVar.has(gate.var)) {
          gatesByVar.set(gate.var, new Map());
          varOrder.push(gate.var);
        }
        const byValue = gatesByVar.get(gate.var)!;
        if (!byValue.has(gate.value)) byValue.set(gate.value, namedChild(el) ?? firstComponentIn(el));
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

  // The container variable is the one multiplexing the most literal-keyed views.
  let chosen: string | undefined;
  for (const v of varOrder) {
    const count = gatesByVar.get(v)!.size;
    if (count >= 2 && (!chosen || count > gatesByVar.get(chosen)!.size)) chosen = v;
  }
  if (!chosen) return null;

  const queryKey = findVueRouteQueryKey(source, chosen);
  const sections: Section[] = [];
  for (const [value, child] of gatesByVar.get(chosen)!) {
    const section: Section = { id: value, reachedBy: "unknown" };
    if (child) section.child = child;

    const activatorEl = activators.get(`${chosen}\0${value}`);
    if (activatorEl) {
      const label = activatorText(activatorEl);
      const selector = activatorSelector(staticAttr(activatorEl, "data-testid"), label);
      if (selector) section.activator = { selector, ...(label ? { label } : {}) };
    }

    if (queryKey) {
      section.reachedBy = "query";
      section.queryParam = { key: queryKey, value };
    } else if (activatorEl) {
      section.reachedBy = "click";
    }
    sections.push(section);
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
