import type { ElementNode } from "@vue/compiler-dom";
import type { ChildEventBinding, FormFieldInfo, RenderConditions, StyleBlockInfo } from "../types.js";
import { buildFormField, FORM_CONTROL_TAGS } from "./formFields.js";
import {
  parseSfc,
  scriptBlocks,
  walkElements,
  isComponentElement,
  pascalize,
  staticAttr,
  boundExpr,
  eventBindings,
  governingConditions,
} from "./sfcParser.js";

/**
 * Vue SFC <template> analysis on the @vue/compiler-sfc AST (via sfcParser).
 * These were regex scanners over raw file content; the compiler parse fixes
 * the failure modes regex could not see past: commented-out markup counted as
 * live, kebab-case event names truncated at the hyphen, closing tags split
 * across lines by prettier, and single-letter components (`<X />`) missed.
 */

export const VUE_BUILTINS = new Set([
  "Teleport", "Transition", "TransitionGroup", "KeepAlive", "Suspense",
  "Component", "Slot",
]);

/**
 * The PascalCase name of a component element that names a real child — the
 * dynamic `<component>` mount and Vue builtins don't. Kebab-case usages
 * (`<my-thing>`) normalize to the name they were registered/imported under.
 */
function namedChildComponent(el: ElementNode): string | undefined {
  if (!isComponentElement(el) || el.tag === "component") return undefined;
  const name = pascalize(el.tag);
  return VUE_BUILTINS.has(name) ? undefined : name;
}

/**
 * Extract the script content of a .vue SFC for TS AST analysis. When both
 * <script> and <script setup> exist, both are included in file order (the
 * old regex silently dropped the second block).
 */
export function extractVueScript(content: string): string {
  if (!parseSfc(content).descriptor) {
    // parse() threw (it reports recoverable errors in-band, so this should
    // not happen) — degrade to the old first-block regex.
    const m = content.match(/<script\b[^>]*>([\s\S]*?)<\/script>/);
    return m ? m[1] : "";
  }
  return scriptBlocks(content)
    .map((b) => b.content)
    .join("\n");
}

/** Inner content of the top-level <template> block, or undefined if none. */
export function extractTemplateBlock(content: string): string | undefined {
  return parseSfc(content).descriptor?.template?.content;
}

/**
 * The expressions bound to `<component :is="...">`, in source order. Such a
 * mount leaves no literal `<Tag>` for the template scan, so callers must resolve
 * the target from script. Returns the raw expression — `activeTabComponent`,
 * `item.icon`, `icons[icon]` — and leaves interpretation to the caller.
 */
export function extractDynamicComponentBindings(fullContent: string): string[] {
  const { templateAst } = parseSfc(fullContent);
  if (!templateAst) return [];

  const bindings: string[] = [];
  walkElements(templateAst, (el) => {
    if (pascalize(el.tag) !== "Component") return;
    const expr = boundExpr(el, "is");
    if (expr !== undefined) bindings.push(expr.replace(/\s+/g, " ").trim());
  });
  return bindings;
}

/** Child components rendered by the template, and the event names it binds. */
export function analyzeVueTemplate(fullContent: string): {
  childComponents: string[];
  childComponentLines: Record<string, number>;
  /** Only children NEVER rendered unconditionally — one unguarded usage clears the entry. */
  childComponentRendering: Record<string, RenderConditions>;
  eventHandlers: string[];
} {
  const { templateAst } = parseSfc(fullContent);
  if (!templateAst) {
    return { childComponents: [], childComponentLines: {}, childComponentRendering: {}, eventHandlers: [] };
  }

  const childComponentLines: Record<string, number> = {};
  // null = an unconditional usage was seen; "always mounted" beats any guard.
  const rendering = new Map<string, RenderConditions | null>();
  const eventHandlers = new Set<string>();
  walkElements(templateAst, (el, ancestors) => {
    const name = namedChildComponent(el);
    if (name) {
      if (!(name in childComponentLines)) childComponentLines[name] = el.loc.start.line;
      const cond = governingConditions(el, ancestors);
      if (!cond) rendering.set(name, null);
      else if (!rendering.has(name)) rendering.set(name, cond);
    }
    // Same shape the regex produced: "click.self", "update:model-value".
    for (const ev of eventBindings(el)) {
      eventHandlers.add([ev.event, ...ev.modifiers].join("."));
    }
  });

  const childComponentRendering: Record<string, RenderConditions> = {};
  for (const [name, cond] of rendering) if (cond) childComponentRendering[name] = cond;

  return {
    childComponents: Object.keys(childComponentLines).sort(),
    childComponentLines,
    childComponentRendering,
    eventHandlers: Array.from(eventHandlers).sort(),
  };
}

/**
 * For each child component the template renders, the events the parent listens
 * for on it (`@event` / `v-on:event`, modifiers stripped). Names are recorded
 * as written (`update:model-value`); consumers cross-checking against a child's
 * declared emits normalize case/hyphens the way Vue's runtime does.
 */
export function extractChildEventBindings(fullContent: string): ChildEventBinding[] {
  const { templateAst } = parseSfc(fullContent);
  if (!templateAst) return [];

  const byComponent = new Map<string, Record<string, number>>();
  walkElements(templateAst, (el) => {
    const name = namedChildComponent(el);
    if (!name) return;
    for (const ev of eventBindings(el)) {
      const lines = byComponent.get(name) ?? {};
      if (!(ev.event in lines)) lines[ev.event] = ev.line;
      byComponent.set(name, lines);
    }
  });

  return [...byComponent.entries()]
    .map(([component, lines]) => ({ component, events: Object.keys(lines).sort(), lines }))
    .sort((a, b) => a.component.localeCompare(b.component));
}

/**
 * Drivable selectors from the <template>: data-testid values anywhere, and
 * intrinsic form controls with their static attributes. Dynamic bindings
 * (`:id`, `v-bind:*`) are skipped — a selector we can't type into the browser
 * is worse than none.
 */
export function extractVueTemplateSelectors(fullContent: string): {
  testIds: string[];
  testIdLines: Record<string, number>;
  formFields: FormFieldInfo[];
} {
  const { templateAst } = parseSfc(fullContent);
  if (!templateAst) return { testIds: [], testIdLines: {}, formFields: [] };

  const testIdLines: Record<string, number> = {};
  const formFields: FormFieldInfo[] = [];
  walkElements(templateAst, (el) => {
    const tid = staticAttr(el, "data-testid");
    if (tid && !(tid in testIdLines)) testIdLines[tid] = el.loc.start.line;

    if (isComponentElement(el) || !FORM_CONTROL_TAGS.has(el.tag)) return;
    formFields.push(
      buildFormField({
        element: el.tag,
        inputType: staticAttr(el, "type"),
        name: staticAttr(el, "name"),
        id: staticAttr(el, "id"),
        testId: tid,
        label: staticAttr(el, "aria-label") ?? staticAttr(el, "placeholder"),
      })
    );
  });

  return { testIds: Object.keys(testIdLines).sort(), testIdLines, formFields };
}

/** Per-<style>-block metadata. An unscoped, non-module block leaks selectors globally. */
export function extractStyleBlocks(content: string): StyleBlockInfo[] {
  const d = parseSfc(content).descriptor;
  if (!d) return [];
  return d.styles.map((s) => ({
    line: s.loc.start.line,
    ...(s.scoped ? { scoped: true } : {}),
    ...(s.module ? { module: true } : {}),
    ...(s.lang ? { lang: s.lang } : {}),
    ...(/\bv-bind\(/.test(s.content) ? { hasVBind: true } : {}),
  }));
}

/** Content of a <docs> custom block — the SFC's own documentation surface. */
export function extractDocsBlock(content: string): string | undefined {
  const docs = parseSfc(content).descriptor?.customBlocks.find((b) => b.type === "docs");
  const text = docs?.content.trim();
  return text ? text.slice(0, 500) : undefined;
}
