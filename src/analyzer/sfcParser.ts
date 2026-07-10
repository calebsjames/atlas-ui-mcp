import { parse } from "@vue/compiler-sfc";
import type { SFCDescriptor } from "@vue/compiler-sfc";
import { NodeTypes, ElementTypes } from "@vue/compiler-dom";
import type {
  RootNode,
  TemplateChildNode,
  ElementNode,
  AttributeNode,
  DirectiveNode,
  ExpressionNode,
} from "@vue/compiler-dom";
import type { RenderConditions } from "../types.js";

/**
 * Shared entry point to @vue/compiler-sfc for the analyzer modules.
 *
 * The template extractors keep their raw-content signatures (callers pass the
 * full SFC source), so a one-slot memo makes "every helper parses the file"
 * cost one real parse per file in the sequential per-file analysis flow.
 */

export interface SfcParseError {
  message: string;
  line?: number;
}

export interface ParsedSfc {
  /** undefined only if parse() threw — it reports recoverable errors in-band. */
  descriptor: SFCDescriptor | undefined;
  /** undefined when there is no <template>, it isn't HTML (lang="pug"), or parse failed. */
  templateAst: RootNode | undefined;
  /** Recoverable syntax errors — the descriptor/AST reflect the parser's recovery. */
  errors: SfcParseError[];
}

let memoKey: string | undefined;
let memoValue: ParsedSfc | undefined;

export function parseSfc(content: string): ParsedSfc {
  if (content === memoKey && memoValue) return memoValue;
  let result: ParsedSfc;
  try {
    const { descriptor, errors } = parse(content, { filename: "anonymous.vue", sourceMap: false });
    result = {
      descriptor,
      templateAst: descriptor.template?.ast,
      errors: errors.map((e) => ({
        message: e.message,
        ...("loc" in e && e.loc ? { line: e.loc.start.line } : {}),
      })),
    };
  } catch (e) {
    result = { descriptor: undefined, templateAst: undefined, errors: [{ message: String(e) }] };
  }
  memoKey = content;
  memoValue = result;
  return result;
}

/**
 * <script> and <script setup> block contents in file order, each with the
 * 1-based file line its content starts on (the opening tag's line — content
 * begins right after the `>`).
 */
export function scriptBlocks(content: string): Array<{ content: string; startLine: number }> {
  const d = parseSfc(content).descriptor;
  if (!d) return [];
  return [d.script, d.scriptSetup]
    .filter((b): b is NonNullable<typeof b> => b != null)
    .sort((a, b) => a.loc.start.offset - b.loc.start.offset)
    .map((b) => ({ content: b.content, startLine: b.loc.start.line }));
}

/**
 * Map a 1-based line in the extracted script (blocks concatenated with "\n",
 * as extractVueScript returns them) back to its line in the .vue file.
 */
export function scriptAbsoluteLine(content: string, scriptLine: number): number {
  let consumed = 0;
  for (const b of scriptBlocks(content)) {
    const blockLines = b.content.split("\n").length;
    if (scriptLine <= consumed + blockLines) return b.startLine + (scriptLine - consumed - 1);
    consumed += blockLines;
  }
  return scriptLine;
}

/** Depth-first visit of every element node, with its ancestor element stack. */
export function walkElements(
  root: RootNode,
  visit: (el: ElementNode, ancestors: readonly ElementNode[]) => void
): void {
  const stack: ElementNode[] = [];
  const rec = (node: RootNode | TemplateChildNode): void => {
    const isElement = node.type === NodeTypes.ELEMENT;
    if (isElement) {
      visit(node as ElementNode, stack);
      stack.push(node as ElementNode);
    }
    const children = (node as { children?: TemplateChildNode[] }).children;
    if (children) for (const c of children) rec(c);
    if (isElement) stack.pop();
  };
  rec(root);
}

/** `<MyThing>`, `<my-thing>` → components; native tags, `<template>`, `<slot>` are not. */
export function isComponentElement(el: ElementNode): boolean {
  return el.tagType === ElementTypes.COMPONENT;
}

/** `my-component` / `myComponent` → `MyComponent`; PascalCase passes through. */
export function pascalize(tag: string): string {
  const camel = tag.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

/** All static attributes of an element. */
export function staticAttrs(el: ElementNode): AttributeNode[] {
  return el.props.filter((p): p is AttributeNode => p.type === NodeTypes.ATTRIBUTE);
}

/** All `:name="expr"` / `v-bind:name` directives with a static arg, with that name. */
export function boundAttrs(el: ElementNode): Array<{ name: string; dir: DirectiveNode }> {
  const out: Array<{ name: string; dir: DirectiveNode }> = [];
  for (const p of el.props) {
    if (
      p.type === NodeTypes.DIRECTIVE &&
      p.name === "bind" &&
      p.arg?.type === NodeTypes.SIMPLE_EXPRESSION &&
      p.arg.isStatic
    ) {
      out.push({ name: p.arg.content, dir: p });
    }
  }
  return out;
}

/** The full static attribute node for `name="..."`, when present with a value. */
export function staticAttrNode(el: ElementNode, name: string): AttributeNode | undefined {
  for (const p of el.props) {
    if (p.type === NodeTypes.ATTRIBUTE && p.name === name) return p;
  }
  return undefined;
}

/** Static attribute value of `name="..."`; undefined for bound or absent attributes. */
export function staticAttr(el: ElementNode, name: string): string | undefined {
  return staticAttrNode(el, name)?.value?.content;
}

/** The v-bind directive node for `:name="..."` / `v-bind:name="..."`. */
export function boundAttrNode(el: ElementNode, name: string): DirectiveNode | undefined {
  return boundAttrs(el).find((b) => b.name === name)?.dir;
}

/** Raw expression source bound as `:name="expr"`, or undefined when not bound. */
export function boundExpr(el: ElementNode, name: string): string | undefined {
  const dir = boundAttrNode(el, name);
  return dir?.exp ? expressionSource(dir.exp) : dir ? "" : undefined;
}

export function expressionSource(exp: ExpressionNode): string {
  return exp.type === NodeTypes.SIMPLE_EXPRESSION ? exp.content : exp.loc.source;
}

export interface TemplateEventBinding {
  /** Event name as written: "close", "update:model-value". */
  event: string;
  /** Modifiers, without dots: ["self", "prevent"]. */
  modifiers: string[];
  /** Handler expression source; "" for a bare `@event` with no value. */
  expression: string;
  /** 1-based file line of the `@event` directive itself. */
  line: number;
}

/**
 * The `@event` / `v-on:event` bindings on one element. Dynamic-arg listeners
 * (`@[name]`) are skipped — no static event name exists to report.
 */
export function eventBindings(el: ElementNode): TemplateEventBinding[] {
  const out: TemplateEventBinding[] = [];
  for (const p of el.props) {
    if (p.type !== NodeTypes.DIRECTIVE || p.name !== "on") continue;
    if (p.arg?.type !== NodeTypes.SIMPLE_EXPRESSION || !p.arg.isStatic) continue;
    out.push({
      event: p.arg.content,
      // Vue 3.4+ models modifiers as expression nodes; older versions as strings.
      modifiers: p.modifiers.map((m) => (typeof m === "string" ? m : m.content)),
      expression: p.exp ? expressionSource(p.exp).trim() : "",
      line: p.loc.start.line,
    });
  }
  return out;
}

/**
 * The nearest v-if (or v-else-if / v-else), v-show, and v-for governing an
 * element — on itself or any ancestor, each kind resolved independently to the
 * closest occurrence. A bare v-else records "(else)". Returns undefined when
 * the element renders unconditionally.
 */
export function governingConditions(
  el: ElementNode,
  ancestors: readonly ElementNode[]
): RenderConditions | undefined {
  const clip = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 80);
  const found: RenderConditions = {};
  // Self first, then ancestors nearest-to-outermost.
  for (let i = ancestors.length; i >= 0; i--) {
    const node = i === ancestors.length ? el : ancestors[i];
    for (const p of node.props) {
      if (p.type !== NodeTypes.DIRECTIVE) continue;
      const exp = p.exp ? clip(expressionSource(p.exp)) : "";
      if ((p.name === "if" || p.name === "else-if") && found.vIf === undefined) found.vIf = exp;
      else if (p.name === "else" && found.vIf === undefined) found.vIf = "(else)";
      else if (p.name === "show" && found.vShow === undefined) found.vShow = exp;
      else if (p.name === "for" && found.vFor === undefined) found.vFor = exp;
    }
  }
  return Object.keys(found).length ? found : undefined;
}

/** Static text content of a subtree — nested tags descended into, {{ mustaches }} skipped. */
export function staticTextOf(node: ElementNode): string {
  let text = "";
  const rec = (n: TemplateChildNode): void => {
    if (n.type === NodeTypes.TEXT) text += n.content;
    else if (n.type === NodeTypes.ELEMENT) for (const c of n.children) rec(c);
  };
  for (const c of node.children) rec(c);
  return text;
}
