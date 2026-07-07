import type {
  ProjectConfig,
  TemplatePatterns,
  OverlayPattern,
  ZIndexRef,
  HeadingInfo,
} from "../types.js";
import { VUE_BUILTINS } from "./vueTemplate.js";

/**
 * Template-layer design-signal extraction for overlay/modal drift audits.
 * Regex, consistent with the other template analyzers — the rubric is flat
 * per-element / per-file checks, so no template AST is needed (see FUTURE
 * ticket to revisit with @vue/compiler-sfc).
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
  const tplOpen = rawContent.match(/<template\b[^>]*>/);
  if (!tplOpen || tplOpen.index === undefined) return undefined;
  const tplStart = tplOpen.index + tplOpen[0].length;
  const tplEnd = rawContent.indexOf("</template>", tplStart);
  // Blank out comments (preserving length/offsets) so commented-out markup
  // never produces a finding.
  const template = rawContent
    .slice(tplStart, tplEnd === -1 ? rawContent.length : tplEnd)
    .replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, " "));

  const overlayClasses = ["overlay", "backdrop", "scrim", "modal-mask", ...(cfg?.overlayClasses ?? [])].map((s) => s.toLowerCase());
  const overlayComponents = ["*Overlay", "*Backdrop", ...(cfg?.overlayComponents ?? [])];
  const headerClasses = ["header", "modal-header", "dialog-header", "card-header", "drawer-header", ...(cfg?.headerClasses ?? [])].map((s) => s.toLowerCase());

  const teleport = scanTeleports(template);
  const { overlays, headerRegions } = scanOverlaysAndHeaders(
    rawContent, template, tplStart,
    { overlayClasses, overlayComponents, headerClasses, teleportRanges: teleport.ranges }
  );
  const headings = scanHeadings(template);
  const zIndexes = scanZIndexes(rawContent, template, tplStart);

  const result: TemplatePatterns = {};
  if (overlays.length) result.overlays = overlays;
  if (teleport.count > 0) {
    result.teleport = {
      present: true,
      targets: [...teleport.targets].sort(),
      count: teleport.count,
      ...(teleport.disabled ? { disabledBinding: true } : {}),
    };
  }
  if (zIndexes.length) result.zIndexes = zIndexes;
  if (headings.length) result.headings = headings;
  if (/<header\b/i.test(template)) result.hasHeaderElement = true;
  if (headerRegions.size) result.headerRegions = [...headerRegions].sort();
  return Object.keys(result).length ? result : undefined;
}

/** Teleport targets/disabled from every open tag; inner ranges (paired) for containment. */
function scanTeleports(template: string): {
  targets: Set<string>;
  disabled: boolean;
  count: number;
  ranges: Array<[number, number]>;
} {
  const targets = new Set<string>();
  let disabled = false;
  let count = 0;
  const openRe = /<[Tt]eleport\b([^>]*?)\/?>/g;
  let open: RegExpExecArray | null;
  while ((open = openRe.exec(template))) {
    count++;
    const attrs = open[1] || "";
    const to = attrs.match(/(?::|v-bind:)?to\s*=\s*(["'])(.*?)\1/);
    if (to) targets.add(to[2]);
    if (/(?::|v-bind:)disabled\b/.test(attrs)) disabled = true;
  }

  const ranges: Array<[number, number]> = [];
  const pairRe = /<[Tt]eleport\b[^>]*>([\s\S]*?)<\/[Tt]eleport>/g;
  let pair: RegExpExecArray | null;
  while ((pair = pairRe.exec(template))) {
    const innerStart = pair.index + pair[0].indexOf(">") + 1;
    ranges.push([innerStart, innerStart + pair[1].length]);
  }

  return { targets, disabled, count, ranges };
}

/** Overlay elements (by class, utility stack, or component-name glob) + header regions. */
function scanOverlaysAndHeaders(
  rawContent: string,
  template: string,
  tplStart: number,
  opts: {
    overlayClasses: string[];
    overlayComponents: string[];
    headerClasses: string[];
    teleportRanges: Array<[number, number]>;
  }
): { overlays: OverlayPattern[]; headerRegions: Set<string> } {
  const overlays: OverlayPattern[] = [];
  const headerRegions = new Set<string>();
  const tagRe = /<([a-zA-Z][\w.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)\/?>/g;
  let el: RegExpExecArray | null;
  while ((el = tagRe.exec(template))) {
    const tag = el[1];
    const attrs = el[2] || "";
    const tokens = classTokens(attrs).map((t) => t.toLowerCase());
    for (const t of tokens) if (opts.headerClasses.some((h) => t.includes(h))) headerRegions.add(t);

    let source: OverlayPattern["source"] | null = null;
    const matched: string[] = [];
    for (const t of tokens) if (opts.overlayClasses.some((o) => t.includes(o))) { matched.push(t); source = "class"; }
    if (!source && isUtilityOverlay(tokens)) {
      source = "utility";
      matched.push(...tokens.filter((t) => /^(fixed|inset-0|bg-black|bg-opacity|backdrop-blur)/.test(t)));
    }
    if (!source && /^[A-Z]/.test(tag) && opts.overlayComponents.some((g) => globMatch(g, tag))) source = "component";
    if (!source) continue;

    const clickHandler = extractClickBinding(attrs);
    const viaTeleport = opts.teleportRanges.some(([a, b]) => el!.index >= a && el!.index <= b);
    overlays.push({
      tag,
      classes: [...new Set(matched)].sort(),
      source,
      ...(clickHandler ? { clickHandler } : {}),
      ...(viaTeleport ? { viaTeleport: true } : {}),
      line: lineAt(rawContent, tplStart + el.index),
    });
  }
  return { overlays, headerRegions };
}

/** <h1>–<h6> headings with their (tag- and mustache-stripped) text. */
function scanHeadings(template: string): HeadingInfo[] {
  const headings: HeadingInfo[] = [];
  const hRe = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let h: RegExpExecArray | null;
  while ((h = hRe.exec(template))) {
    const text = h[2].replace(/<[^>]*>/g, "").replace(/\{\{[\s\S]*?\}\}/g, "").replace(/\s+/g, " ").trim();
    headings.push({ level: parseInt(h[1], 10), ...(text ? { text: text.slice(0, 120) } : {}) });
  }
  return headings;
}

/** z-index references from style blocks, inline/bound styles, and utility classes. */
function scanZIndexes(rawContent: string, template: string, tplStart: number): ZIndexRef[] {
  const zIndexes: ZIndexRef[] = [];
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let st: RegExpExecArray | null;
  while ((st = styleRe.exec(rawContent))) {
    const css = st[1];
    const cssOffset = st.index + st[0].indexOf(">") + 1;
    const zRe = /z-index\s*:\s*([^;}\n]+)/gi;
    let z: RegExpExecArray | null;
    while ((z = zRe.exec(css))) {
      zIndexes.push(zref(z[1], "style", lineAt(rawContent, cssOffset + z.index), selectorBefore(css, z.index)));
    }
  }
  // Plain static style="..." — lookbehind excludes :style / v-bind:style.
  const inlineRe = /(?<![\w:-])style\s*=\s*(["'])([\s\S]*?)\1/gi;
  let inl: RegExpExecArray | null;
  while ((inl = inlineRe.exec(template))) {
    const zm = inl[2].match(/z-?index\s*:\s*([^;'"}]+)/i);
    if (zm) zIndexes.push(zref(zm[1], "inline", lineAt(rawContent, tplStart + inl.index)));
  }
  // Bound :style="{ zIndex: 999 }" — object-literal form.
  const bindStyleRe = /(?::|v-bind:)style\s*=\s*(["'])([\s\S]*?)\1/gi;
  while ((inl = bindStyleRe.exec(template))) {
    const zm = inl[2].match(/(?:z-?index|['"]z-index['"])\s*:\s*['"]?([\w.-]+)/i);
    if (zm) zIndexes.push(zref(zm[1], "inline", lineAt(rawContent, tplStart + inl.index)));
  }
  const utilRe = /\bz-(\[[^\]]+\]|\d+)\b/g;
  let u: RegExpExecArray | null;
  while ((u = utilRe.exec(template))) {
    const raw = u[1].startsWith("[") ? u[1].slice(1, -1) : u[1];
    zIndexes.push(zref(raw, "utility", lineAt(rawContent, tplStart + u.index)));
  }

  const seen = new Set<string>();
  return zIndexes.filter((z) => {
    const k = `${z.value}|${z.where}|${z.selector ?? ""}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

/** Class tokens from static `class="..."` and literal tokens/keys in `:class`. */
function classTokens(attrs: string): string[] {
  const tokens: string[] = [];
  let m: RegExpExecArray | null;
  const staticRe = /\bclass\s*=\s*(["'])([\s\S]*?)\1/g;
  while ((m = staticRe.exec(attrs))) tokens.push(...m[2].split(/\s+/));
  const bindRe = /(?::|v-bind:)class\s*=\s*(["'])([\s\S]*?)\1/g;
  while ((m = bindRe.exec(attrs))) {
    const expr = m[2];
    let s: RegExpExecArray | null;
    const strRe = /['"]([\w:-]+)['"]/g;
    while ((s = strRe.exec(expr))) tokens.push(s[1]);
    const keyRe = /([\w-]+)\s*:/g;
    while ((s = keyRe.exec(expr))) tokens.push(s[1]);
  }
  return tokens.filter(Boolean);
}

/** Tailwind-style positional overlay: full-viewport fixed element with a dim background. */
function isUtilityOverlay(tokens: string[]): boolean {
  const has = (re: RegExp) => tokens.some((t) => re.test(t));
  const fixedFull = has(/^fixed$/) && (has(/^inset-0$/) || (has(/^top-0$/) && has(/^left-0$/)));
  const dim = has(/^bg-black/) || has(/^bg-opacity/) || has(/^backdrop-blur/) || has(/^bg-gray-9\d\d\//);
  return fixedFull && dim;
}

/** Parse a click binding (@click / v-on:click) with its modifiers and handler expression. */
function extractClickBinding(attrs: string): { bound: true; modifiers: string[]; expression: string } | undefined {
  const withValue = attrs.match(/(?:@|v-on:)click((?:\.\w+)*)\s*=\s*(["'])([\s\S]*?)\2/);
  if (withValue) {
    return { bound: true, modifiers: withValue[1] ? withValue[1].slice(1).split(".").filter(Boolean) : [], expression: withValue[3].trim() };
  }
  const bare = attrs.match(/(?:@|v-on:)click((?:\.\w+)*)(?=[\s/>]|$)/);
  if (bare) return { bound: true, modifiers: bare[1] ? bare[1].slice(1).split(".").filter(Boolean) : [], expression: "" };
  return undefined;
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

/** 1-based line number of an absolute offset in the file. */
function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content[i] === "\n") line++;
  return line;
}
