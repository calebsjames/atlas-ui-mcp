import type { ChildEventBinding, FormFieldInfo } from "../types.js";
import { buildFormField } from "./formFields.js";

/**
 * Regex-based analysis of Vue SFC <template> blocks. The template isn't part
 * of the <script> AST, so these scanners work on the raw file content — an
 * accepted tradeoff for HTML-ish markup (see FUTURE ticket to revisit with
 * @vue/compiler-sfc).
 */

export const VUE_BUILTINS = new Set([
  "Teleport", "Transition", "TransitionGroup", "KeepAlive", "Suspense",
  "Component", "Slot",
]);

/** Extract <script> or <script setup> content from a .vue SFC. */
export function extractVueScript(content: string): string {
  const scriptMatch = content.match(/<script\b[^>]*>([\s\S]*?)<\/script>/);
  return scriptMatch ? scriptMatch[1] : "";
}

/** Extract the <template> block's inner content, or undefined if there is none. */
export function extractTemplateBlock(content: string): string | undefined {
  const match = content.match(/<template\b[^>]*>([\s\S]*?)<\/template>/);
  return match ? match[1] : undefined;
}

/** PascalCase child components and event handlers bound in the template. */
export function analyzeVueTemplate(fullContent: string): {
  childComponents: string[];
  eventHandlers: string[];
} {
  const template = extractTemplateBlock(fullContent);
  if (template === undefined) return { childComponents: [], eventHandlers: [] };

  // PascalCase component usages: <ComponentName or <ComponentName>
  const childComponents = new Set<string>();
  const componentRegex = /<([A-Z][A-Za-z0-9]+)[\s/>]/g;
  let match;
  while ((match = componentRegex.exec(template))) {
    if (!VUE_BUILTINS.has(match[1])) {
      childComponents.add(match[1]);
    }
  }

  // Event handlers: @eventName="..." or v-on:eventName="..."
  const eventHandlers = new Set<string>();
  const eventRegex = /(?:@|v-on:)([\w:.]+)/g;
  while ((match = eventRegex.exec(template))) {
    eventHandlers.add(match[1]);
  }

  return {
    childComponents: Array.from(childComponents).sort(),
    eventHandlers: Array.from(eventHandlers).sort(),
  };
}

/**
 * For each child component the template renders, collect the events the parent
 * listens for on it (`@event` / `v-on:event`, modifiers stripped). Attribute-
 * level regex, in the same spirit as analyzeVueTemplate — precise enough to
 * cross-check against the child's real emits without a full template parser.
 */
export function extractChildEventBindings(fullContent: string): ChildEventBinding[] {
  const template = extractTemplateBlock(fullContent);
  if (template === undefined) return [];

  // Opening tags of PascalCase components, capturing the attribute blob.
  const tagRegex = /<([A-Z][A-Za-z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/g;
  const byComponent = new Map<string, Set<string>>();
  let tag: RegExpExecArray | null;
  while ((tag = tagRegex.exec(template))) {
    const name = tag[1];
    if (VUE_BUILTINS.has(name)) continue;
    const attrs = tag[2] || "";
    // @event="..." or v-on:event="..." — event name only, up to a modifier dot.
    const evRegex = /(?:@|v-on:)([A-Za-z][\w-]*)/g;
    let ev: RegExpExecArray | null;
    while ((ev = evRegex.exec(attrs))) {
      const set = byComponent.get(name) ?? new Set<string>();
      set.add(ev[1]);
      byComponent.set(name, set);
    }
  }

  return [...byComponent.entries()]
    .map(([component, events]) => ({ component, events: [...events].sort() }))
    .sort((a, b) => a.component.localeCompare(b.component));
}

/** Read a single static attribute value out of a raw HTML/Vue tag's attribute string.
 * The `(?<![:\w-])` guard rejects dynamic bindings (`:name`, `v-bind:name`) and
 * hyphenated look-alikes (`data-type` when matching `type`). */
export function matchTemplateAttr(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`(?<![:\\w-])${name}=["']([^"']+)["']`));
  return m ? m[1] : undefined;
}

/**
 * Vue selectors come from the <template>, which isn't in the <script> AST, so
 * we scan it with regex (HTML-ish content — the same tradeoff as accessibility).
 * Only lowercase intrinsic tags are treated as form controls; PascalCase Vue
 * components are ignored. Dynamic-bound attributes (`:id`, `v-bind:*`) are skipped.
 */
export function extractVueTemplateSelectors(fullContent: string): {
  testIds: string[];
  formFields: FormFieldInfo[];
} {
  const template = extractTemplateBlock(fullContent);
  if (template === undefined) return { testIds: [], formFields: [] };

  const testIds = Array.from(
    new Set(
      Array.from(template.matchAll(/(?<![:\w-])data-testid=["']([^"']+)["']/g)).map((m) => m[1])
    )
  ).sort();

  const formFields: FormFieldInfo[] = [];
  const controlRegex = /<(input|select|textarea|button)\b([^>]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = controlRegex.exec(template))) {
    const element = match[1];
    const attrs = match[2];
    const label =
      matchTemplateAttr(attrs, "aria-label") ??
      matchTemplateAttr(attrs, "placeholder");
    formFields.push(
      buildFormField({
        element,
        inputType: matchTemplateAttr(attrs, "type"),
        name: matchTemplateAttr(attrs, "name"),
        id: matchTemplateAttr(attrs, "id"),
        testId: matchTemplateAttr(attrs, "data-testid"),
        label,
      })
    );
  }

  return { testIds, formFields };
}
