import ts from "typescript";
import { getJsxAttrStringValue } from "./formFields.js";
import {
  activatorSelector,
  type Section,
  type ViewContainer,
} from "./viewContainer.js";

/**
 * Detect a React view container: a component whose JSX gates sibling views on a
 * single `useState` variable compared to string literals — `{tab === 'rx' &&
 * <Prescriptions/>}` or `tab === 'rx' ? <A/> : <B/>` — and switches it with
 * `onClick={() => setTab('rx')}`. Returns null when no state variable
 * multiplexes ≥2 literal-keyed views.
 *
 * The React sibling of extractVueViewContainer: same output shape, keyed off
 * React constructs (useState + setter, JSX conditional render) rather than any
 * app-specific name.
 */
export function extractReactViewContainer(source: string, componentName: string): ViewContainer | null {
  const sf = ts.createSourceFile(`${componentName}.tsx`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  // Pass 1: useState pairs. state var -> setter, and setter -> state var.
  const setterToState = new Map<string, string>();
  const stateVars = new Set<string>();
  const collectState = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isUseStateCall(node.initializer) &&
      ts.isArrayBindingPattern(node.name)
    ) {
      const [s, set] = node.name.elements;
      if (
        s && ts.isBindingElement(s) && ts.isIdentifier(s.name) &&
        set && ts.isBindingElement(set) && ts.isIdentifier(set.name)
      ) {
        stateVars.add(s.name.text);
        setterToState.set(set.name.text, s.name.text);
      }
    }
    ts.forEachChild(node, collectState);
  };
  collectState(sf);
  if (stateVars.size === 0) return null;

  // Pass 2: gates (state === 'lit' guarding JSX) and activators (setState('lit')).
  const gatesByVar = new Map<string, Map<string, string | undefined>>();
  const varOrder: string[] = [];
  const activators = new Map<string, { testId?: string; label?: string }>();

  const recordGate = (v: string, value: string, child?: string) => {
    if (!gatesByVar.has(v)) {
      gatesByVar.set(v, new Map());
      varOrder.push(v);
    }
    const byValue = gatesByVar.get(v)!;
    if (!byValue.has(value)) byValue.set(value, child);
  };

  const visit = (node: ts.Node) => {
    // `cond && <JSX>` — the guarded-render form.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      containsJsx(node.right)
    ) {
      const eq = stateEqualityOf(node.left, stateVars);
      if (eq) recordGate(eq.var, eq.value, firstJsxComponent(node.right));
    }
    // `cond ? <A> : …` — the ternary form (each nested else is its own node).
    if (ts.isConditionalExpression(node)) {
      const eq = stateEqualityOf(node.condition, stateVars);
      if (eq && containsJsx(node.whenTrue)) {
        recordGate(eq.var, eq.value, firstJsxComponent(node.whenTrue));
      }
    }
    // `onClick={() => setTab('x')}` — a section switch.
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const onClick = attribute(node, "onClick");
      if (onClick) {
        const call = findSetterCall(onClick, setterToState);
        if (call) {
          const state = setterToState.get(call.setter)!;
          const key = `${state}\0${call.value}`;
          if (!activators.has(key)) {
            const testId = getTestId(node);
            const label = jsxLabel(node);
            activators.set(key, { ...(testId ? { testId } : {}), ...(label ? { label } : {}) });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  let chosen: string | undefined;
  for (const v of varOrder) {
    const count = gatesByVar.get(v)!.size;
    if (count >= 2 && (!chosen || count > gatesByVar.get(chosen)!.size)) chosen = v;
  }
  if (!chosen) return null;

  const sections: Section[] = [];
  for (const [value, child] of gatesByVar.get(chosen)!) {
    const section: Section = { id: value, reachedBy: "unknown" };
    if (child) section.child = child;

    const act = activators.get(`${chosen}\0${value}`);
    if (act) {
      section.reachedBy = "click";
      const selector = activatorSelector(act.testId, act.label);
      if (selector) section.activator = { selector, ...(act.label ? { label: act.label } : {}) };
    }
    sections.push(section);
  }

  return { container: componentName, selector: chosen, framework: "react", sections };
}

function isUseStateCall(node: ts.Expression): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const e = node.expression;
  return (
    (ts.isIdentifier(e) && e.text === "useState") ||
    (ts.isPropertyAccessExpression(e) && e.name.text === "useState")
  );
}

/** Unwrap parentheses to the inner expression. */
function unwrap(n: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(n)) n = n.expression;
  return n;
}

/** A `state === 'lit'` / `'lit' == state` equality where `state` is a known state var. */
function stateEqualityOf(
  node: ts.Expression,
  stateVars: Set<string>
): { var: string; value: string } | null {
  const n = unwrap(node);
  if (!ts.isBinaryExpression(n)) return null;
  const op = n.operatorToken.kind;
  if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) {
    const l = unwrap(n.left);
    const r = unwrap(n.right);
    if (ts.isIdentifier(l) && isStringLiteral(r) && stateVars.has(l.text)) return { var: l.text, value: r.text };
    if (ts.isIdentifier(r) && isStringLiteral(l) && stateVars.has(r.text)) return { var: r.text, value: l.text };
    return null;
  }
  // Descend `&&` chains: `a && state === 'x'` still carries the gate.
  if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
    return stateEqualityOf(n.left, stateVars) ?? stateEqualityOf(n.right, stateVars);
  }
  return null;
}

function isStringLiteral(n: ts.Node): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
}

/** Does this subtree contain any JSX element/fragment? */
function containsJsx(node: ts.Node): boolean {
  let found = false;
  const scan = (n: ts.Node) => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, scan);
  };
  scan(node);
  return found;
}

/** First rendered component name in a JSX subtree (PascalCase tag), or undefined. */
function firstJsxComponent(node: ts.Node): string | undefined {
  let name: string | undefined;
  const scan = (n: ts.Node) => {
    if (name) return;
    if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) {
      const tag = jsxTagName(n.tagName);
      if (tag && /^[A-Z]/.test(tag) && tag !== "Fragment") {
        name = tag;
        return;
      }
    }
    ts.forEachChild(n, scan);
  };
  scan(node);
  return name;
}

function jsxTagName(tag: ts.JsxTagNameExpression): string | undefined {
  if (ts.isIdentifier(tag)) return tag.text;
  if (ts.isPropertyAccessExpression(tag)) return tag.getText();
  return undefined;
}

/** The named JSX attribute on an opening/self-closing element, when present. */
function attribute(
  el: ts.JsxSelfClosingElement | ts.JsxOpeningElement,
  name: string
): ts.JsxAttribute | undefined {
  for (const p of el.attributes.properties) {
    if (ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === name) return p;
  }
  return undefined;
}

function getTestId(el: ts.JsxSelfClosingElement | ts.JsxOpeningElement): string | undefined {
  const attr = attribute(el, "data-testid");
  return attr ? getJsxAttrStringValue(attr) : undefined;
}

/** Static text of a JSX element's direct children — the button/tab label. */
function jsxLabel(el: ts.JsxSelfClosingElement | ts.JsxOpeningElement): string | undefined {
  const parent = el.parent;
  if (!ts.isJsxElement(parent)) return undefined;
  const text = parent.children
    .filter(ts.isJsxText)
    .map((t) => t.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

/** A `setter('lit')` call anywhere inside a handler attribute, with setter ∈ known setters. */
function findSetterCall(
  attr: ts.JsxAttribute,
  setters: Map<string, string>
): { setter: string; value: string } | null {
  const init = attr.initializer;
  if (!init || !ts.isJsxExpression(init) || !init.expression) return null;
  let result: { setter: string; value: string } | null = null;
  const scan = (n: ts.Node) => {
    if (result) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && setters.has(n.expression.text)) {
      const arg = n.arguments[0];
      if (arg && isStringLiteral(arg)) {
        result = { setter: n.expression.text, value: arg.text };
        return;
      }
    }
    ts.forEachChild(n, scan);
  };
  scan(init.expression);
  return result;
}
