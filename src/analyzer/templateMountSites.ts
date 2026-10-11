import type { ElementNode } from "@vue/compiler-dom";
import { NodeTypes } from "@vue/compiler-dom";
import type { RenderConditions } from "../types.js";
import {
  parseSfc,
  walkElements,
  isComponentElement,
  pascalize,
  expressionSource,
  governingConditions,
} from "./sfcParser.js";

/**
 * One place a Vue template mounts a component, with the props actually passed
 * there — the fact `get_component_props` (which reports the DECLARED interface)
 * structurally cannot answer: which literal each mount site passes.
 *
 * Static and bound props are kept apart on purpose. `scope="all"` is a VALUE;
 * `:scope="activeScope"` is a POINTER to a script binding whose value is not
 * statically known. Merging them would turn an expression into a claim about
 * what the component receives.
 */
export interface TemplateMountSite {
  /** 1-based line of the opening tag in the .vue file. */
  line: number;
  /** The tag exactly as written, e.g. "weight-inventory-panel". */
  tag: string;
  /** `name="literal"` — real values. Valueless attributes go to `flagProps`. */
  staticProps: Record<string, string>;
  /**
   * Valueless attributes (`<Panel embedded />`). Vue passes the empty string,
   * which a Boolean-declared prop casts to `true` — so the VALUE depends on the
   * child's declared prop type. Kept out of staticProps so `""` is never read
   * as a literal the site chose to pass.
   */
  flagProps: string[];
  /** `:name="expr"` / `v-bind:name` — the expression SOURCE, not a value. */
  boundProps: Record<string, string>;
  /** `v-model:name="expr"` (key "modelValue" when unnamed) — also expressions. */
  vModelProps: Record<string, string>;
  /** `v-bind="obj"` — an unknown set of props spread in from `obj`. */
  spreadProps: string[];
  /** v-if / v-show / v-for governing this site (self or nearest ancestor). */
  renderedWhen?: RenderConditions;
}

/** The expression source of a directive, or "" for a bare directive. */
function dirExpr(exp: { type: number } | undefined): string {
  if (!exp) return "";
  return expressionSource(exp as Parameters<typeof expressionSource>[0])
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Every site in a Vue SFC's template that mounts `componentName`, with the
 * props bound at each. Matching is on the AST, so kebab-case tags normalize to
 * PascalCase, attributes split across lines are read whole, and commented-out
 * markup is not counted as a mount.
 *
 * Returns `undefined` when the file has no parseable <template> (not a Vue SFC,
 * `lang="pug"`, or a parse failure) — distinct from `[]`, which means the
 * template parsed and mounts this component nowhere.
 */
export function findTemplateMountSites(
  fullContent: string,
  componentName: string
): TemplateMountSite[] | undefined {
  const { templateAst } = parseSfc(fullContent);
  if (!templateAst) return undefined;

  const target = pascalize(componentName);
  const sites: TemplateMountSite[] = [];

  walkElements(templateAst, (el: ElementNode, ancestors) => {
    if (!isComponentElement(el) || pascalize(el.tag) !== target) return;

    const staticProps: Record<string, string> = {};
    const flagProps: string[] = [];
    const boundProps: Record<string, string> = {};
    const vModelProps: Record<string, string> = {};
    const spreadProps: string[] = [];

    for (const p of el.props) {
      if (p.type === NodeTypes.ATTRIBUTE) {
        if (p.value === undefined) flagProps.push(p.name);
        else staticProps[p.name] = p.value.content;
        continue;
      }
      if (p.type !== NodeTypes.DIRECTIVE) continue;

      if (p.name === "bind") {
        if (!p.arg) {
          spreadProps.push(dirExpr(p.exp));
        } else if (p.arg.type === NodeTypes.SIMPLE_EXPRESSION && p.arg.isStatic) {
          boundProps[p.arg.content] = dirExpr(p.exp);
        } else {
          // `:[key]="v"` — the prop NAME is itself dynamic; nothing static to report.
          spreadProps.push(`[dynamic arg] ${dirExpr(p.exp)}`);
        }
      } else if (p.name === "model") {
        const key =
          p.arg?.type === NodeTypes.SIMPLE_EXPRESSION && p.arg.isStatic
            ? p.arg.content
            : "modelValue";
        vModelProps[key] = dirExpr(p.exp);
      }
    }

    const renderedWhen = governingConditions(el, ancestors);
    sites.push({
      line: el.loc.start.line,
      tag: el.tag,
      staticProps,
      flagProps,
      boundProps,
      vModelProps,
      spreadProps,
      ...(renderedWhen ? { renderedWhen } : {}),
    });
  });

  return sites;
}
