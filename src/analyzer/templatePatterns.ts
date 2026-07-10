import type { ElementNode } from "@vue/compiler-dom";
import type {
  ProjectConfig,
  TemplatePatterns,
  OverlayPattern,
  ZIndexRef,
  HeadingInfo,
} from "../types.js";
import {
  parseSfc,
  walkElements,
  isComponentElement,
  pascalize,
  staticAttr,
  staticAttrs,
  staticAttrNode,
  boundAttrs,
  boundAttrNode,
  boundExpr,
  expressionSource,
  eventBindings,
  staticTextOf,
} from "./sfcParser.js";

/**
 * Template-layer design-signal extraction for overlay/modal drift audits, on
 * the @vue/compiler-sfc AST. Element structure, nesting (Teleport containment),
 * and line numbers come from the parse; light regex remains only where the
 * signal lives inside an expression or CSS string (`:class` literals,
 * `:style="{ zIndex: … }"`, z-index declarations in <style> blocks).
 */

/**
 * Surface the template-layer design signals an overlay/modal drift audit needs:
 * overlay/backdrop elements (and whether a backdrop click handler is bound with
 * the correct `.self` modifier), Teleport usage + target, z-index values (style
 * blocks, inline, and utility classes), and header/heading structure.
 * Returns undefined when nothing was found.
 */
export function analyzeVueTemplatePatterns(
  rawContent: string,
  cfg?: NonNullable<ProjectConfig["templatePatterns"]>
): TemplatePatterns | undefined {
  const { descriptor, templateAst } = parseSfc(rawContent);
  if (!descriptor || !templateAst) return undefined;

  const overlayClasses = ["overlay", "backdrop", "scrim", "modal-mask", ...(cfg?.overlayClasses ?? [])].map((s) => s.toLowerCase());
  const overlayComponents = ["*Overlay", "*Backdrop", ...(cfg?.overlayComponents ?? [])];
  const headerClasses = ["header", "modal-header", "dialog-header", "card-header", "drawer-header", ...(cfg?.headerClasses ?? [])].map((s) => s.toLowerCase());

  const overlays: OverlayPattern[] = [];
  const headerRegions = new Set<string>();
  const headings: HeadingInfo[] = [];
  const zIndexes: ZIndexRef[] = [];
  const teleportTargets = new Set<string>();
  let teleportCount = 0;
  let teleportDisabled = false;
  let hasHeaderElement = false;

  walkElements(templateAst, (el, ancestors) => {
    if (pascalize(el.tag) === "Teleport") {
      teleportCount++;
      const to = staticAttr(el, "to") ?? boundExpr(el, "to");
      if (to) teleportTargets.add(to);
      if (boundAttrNode(el, "disabled")) teleportDisabled = true;
    }

    if (el.tag === "header") hasHeaderElement = true;
    if (/^h[1-6]$/.test(el.tag)) {
      const text = staticTextOf(el).replace(/\s+/g, " ").trim();
      headings.push({ level: parseInt(el.tag.slice(1), 10), ...(text ? { text: text.slice(0, 120) } : {}) });
    }

    const tokens = classTokens(el).map((t) => t.toLowerCase());
    for (const t of tokens) if (headerClasses.some((h) => t.includes(h))) headerRegions.add(t);

    // Overlay detection: by class, utility stack, or component-name glob.
    let source: OverlayPattern["source"] | null = null;
    const matched: string[] = [];
    for (const t of tokens) if (overlayClasses.some((o) => t.includes(o))) { matched.push(t); source = "class"; }
    if (!source && isUtilityOverlay(tokens)) {
      source = "utility";
      matched.push(...tokens.filter((t) => /^(fixed|inset-0|bg-black|bg-opacity|backdrop-blur)/.test(t)));
    }
    if (!source && isComponentElement(el) && overlayComponents.some((g) => globMatch(g, pascalize(el.tag)))) source = "component";
    if (source) {
      const click = eventBindings(el).find((ev) => ev.event === "click");
      const viaTeleport = ancestors.some((a) => pascalize(a.tag) === "Teleport");
      overlays.push({
        tag: el.tag,
        classes: [...new Set(matched)].sort(),
        source,
        ...(click ? { clickHandler: { bound: true as const, modifiers: click.modifiers, expression: click.expression } } : {}),
        ...(viaTeleport ? { viaTeleport: true } : {}),
        line: el.loc.start.line,
      });
    }

    scanElementZIndexes(el, zIndexes);
  });

  // z-index declarations in <style> blocks, with file-absolute lines.
  for (const style of descriptor.styles) {
    const css = style.content;
    const zRe = /z-index\s*:\s*([^;}\n]+)/gi;
    let z: RegExpExecArray | null;
    while ((z = zRe.exec(css))) {
      const line = style.loc.start.line + newlinesBefore(css, z.index);
      zIndexes.push(zref(z[1], "style", line, selectorBefore(css, z.index)));
    }
  }

  const result: TemplatePatterns = {};
  if (overlays.length) result.overlays = overlays;
  if (teleportCount > 0) {
    result.teleport = {
      present: true,
      targets: [...teleportTargets].sort(),
      count: teleportCount,
      ...(teleportDisabled ? { disabledBinding: true } : {}),
    };
  }
  const dedupedZ = dedupeZIndexes(zIndexes);
  if (dedupedZ.length) result.zIndexes = dedupedZ;
  if (headings.length) result.headings = headings;
  if (hasHeaderElement) result.hasHeaderElement = true;
  if (headerRegions.size) result.headerRegions = [...headerRegions].sort();
  return Object.keys(result).length ? result : undefined;
}

/** z-index signals carried by one element: inline style, bound :style, utility classes. */
function scanElementZIndexes(el: ElementNode, zIndexes: ZIndexRef[]): void {
  const styleAttr = staticAttrNode(el, "style");
  const zm = styleAttr?.value?.content.match(/z-?index\s*:\s*([^;'"}]+)/i);
  if (styleAttr && zm) zIndexes.push(zref(zm[1], "inline", styleAttr.loc.start.line));

  // Bound :style="{ zIndex: 999 }" — object-literal form.
  const bound = boundAttrNode(el, "style");
  if (bound?.exp) {
    const bzm = expressionSource(bound.exp).match(/(?:z-?index|['"]z-index['"])\s*:\s*['"]?([\w.-]+)/i);
    if (bzm) zIndexes.push(zref(bzm[1], "inline", bound.loc.start.line));
  }

  // Tailwind-style utility tokens: z-50, z-[9999].
  for (const t of classTokens(el)) {
    const m = t.match(/^z-(\[[^\]]+\]|\d+)$/);
    if (m) {
      const raw = m[1].startsWith("[") ? m[1].slice(1, -1) : m[1];
      zIndexes.push(zref(raw, "utility", el.loc.start.line));
    }
  }
}

/** `class` and `*-class` (overlay-class, body-class, …) attributes carry class lists. */
const isClassCarrier = (name: string) => name === "class" || name.endsWith("-class");

/** Class tokens from static class attributes plus literals/keys/identifiers in bound ones. */
function classTokens(el: ElementNode): string[] {
  const tokens: string[] = [];
  for (const attr of staticAttrs(el)) {
    if (isClassCarrier(attr.name) && attr.value) tokens.push(...attr.value.content.split(/\s+/));
  }
  for (const { name, dir } of boundAttrs(el)) {
    if (isClassCarrier(name) && dir.exp) tokens.push(...expressionClassTokens(expressionSource(dir.exp)));
  }
  return tokens.filter(Boolean);
}

/**
 * Class-ish tokens inside a `:class` expression: string literals split into
 * tokens (multi-class strings in arrays/ternaries are the norm), object keys,
 * and bare identifiers — a variable named `overlayClasses` is a real design
 * signal. JS comments are stripped first so prose can't fabricate tokens.
 */
function expressionClassTokens(expr: string): string[] {
  const strRe = /'([^']*)'|"([^"]*)"|`([^`]*)`/g;
  const noComments = expr.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const tokens: string[] = [];
  let s: RegExpExecArray | null;
  while ((s = strRe.exec(noComments))) tokens.push(...(s[1] ?? s[2] ?? s[3]).split(/\s+/));
  const outsideStrings = noComments.replace(strRe, " ");
  const identRe = /[A-Za-z_$][\w$-]*/g;
  while ((s = identRe.exec(outsideStrings))) tokens.push(s[0]);
  return tokens;
}

/** Tailwind-style positional overlay: full-viewport fixed element with a dim background. */
function isUtilityOverlay(tokens: string[]): boolean {
  const has = (re: RegExp) => tokens.some((t) => re.test(t));
  const fixedFull = has(/^fixed$/) && (has(/^inset-0$/) || (has(/^top-0$/) && has(/^left-0$/)));
  const dim = has(/^bg-black/) || has(/^bg-opacity/) || has(/^backdrop-blur/) || has(/^bg-gray-9\d\d\//);
  return fixedFull && dim;
}

/** Simple `*` glob match, anchored. */
function globMatch(glob: string, name: string): boolean {
  const re = new RegExp("^" + glob.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(name);
}

/** Best-effort CSS selector for a declaration at `pos` — the text before its `{`. */
function selectorBefore(css: string, pos: number): string | undefined {
  const openIdx = css.lastIndexOf("{", pos);
  if (openIdx === -1) return undefined;
  const prev = Math.max(css.lastIndexOf("}", openIdx), css.lastIndexOf("{", openIdx - 1));
  const sel = css.slice(prev + 1, openIdx).trim().replace(/\s+/g, " ");
  return sel ? sel.slice(0, 80) : undefined;
}

function zref(raw: string, where: ZIndexRef["where"], line: number, selector?: string): ZIndexRef {
  const value = raw.trim();
  const ref: ZIndexRef = { value, where, line };
  if (/^-?\d+$/.test(value)) ref.numeric = parseInt(value, 10);
  if (selector) ref.selector = selector;
  return ref;
}

function dedupeZIndexes(zIndexes: ZIndexRef[]): ZIndexRef[] {
  const seen = new Set<string>();
  return zIndexes.filter((z) => {
    const k = `${z.value}|${z.where}|${z.selector ?? ""}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

/** Newlines in `text` before `index` — offsets a block-relative position to lines. */
function newlinesBefore(text: string, index: number): number {
  let n = 0;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") n++;
  return n;
}
