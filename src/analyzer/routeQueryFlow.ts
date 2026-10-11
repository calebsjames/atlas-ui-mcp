import ts from "typescript";
import { parseSfc } from "./sfcParser.js";

/**
 * Which `route.query.<key>` flows INTO a view variable, if any.
 *
 * The old heuristic accepted any `route.query.X` read within 300 characters
 * before an assignment to the variable, so FitterProfile's
 * `fitterAccountId = route.query.id` next to `activeTab = ref(...)` produced
 * an invented `?id=projects` URL. Here the query read must actually reach the
 * assignment's right-hand side, through the shapes view shells use:
 *
 *   const v = ref(route.query.view || 'x')
 *   const v = ref(getInitial())            // fn returns (a const holding) route.query.view
 *   watch(() => route.query.view, (nv) => { v.value = nv })
 *   v.value = (route.query.view as string) ?? 'x'
 *
 * Transformations break the flow on purpose: `MAP[route.query.tab].tab` is
 * not the literal the URL carries, so a section keyed on it is not reachable
 * by putting the section id in the URL.
 */
export function findRouteQueryKeyFlowingInto(source: string, varName: string): string | undefined {
  for (const script of scriptSources(source)) {
    let sf: ts.SourceFile;
    try {
      sf = ts.createSourceFile("flow.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    } catch {
      continue;
    }
    const key = new FlowIndex(sf).keyFlowingInto(varName);
    if (key) return key;
  }
  return undefined;
}

/** The script block(s) of an SFC, or the whole source for a plain module. */
function scriptSources(source: string): string[] {
  if (!/<script[\s>]/.test(source)) return [source];
  const { descriptor } = parseSfc(source);
  const out: string[] = [];
  if (descriptor?.script?.content) out.push(descriptor.script.content);
  if (descriptor?.scriptSetup?.content) out.push(descriptor.scriptSetup.content);
  return out;
}

const MAX_DEPTH = 6;
const REF_FACTORIES = new Set(["ref", "shallowRef", "useState", "useRef", "reactive"]);
const PASS_THROUGH_CALLS = new Set(["String", "decodeURIComponent", "unref", "toValue"]);

class FlowIndex {
  /** Right-hand sides assigned to each variable (incl. `x.value =` and declarations). */
  private assigned = new Map<string, ts.Expression[]>();
  /** Watch-callback parameter → the watched source expression. */
  private watchParams = new Map<string, ts.Expression[]>();
  /** Local function name → its declaration(s), for return values and parameter passthrough. */
  private functions = new Map<string, ts.FunctionLikeDeclaration[]>();

  constructor(sf: ts.SourceFile) {
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const init = node.initializer;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          this.addFn(node.name.text, init);
        } else {
          this.add(this.assigned, node.name.text, init);
        }
      }
      if (ts.isFunctionDeclaration(node) && node.name) {
        this.addFn(node.name.text, node);
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const target = assignedVar(node.left);
        if (target) this.add(this.assigned, target, node.right);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "watch") {
        const [src, cb] = node.arguments;
        if (src && cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
          const p = cb.parameters[0];
          if (p && ts.isIdentifier(p.name)) {
            const watched =
              ts.isArrowFunction(src) || ts.isFunctionExpression(src) ? returnedExpressions(src) : [src];
            this.add(this.watchParams, p.name.text, ...watched);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  private addFn(name: string, fn: ts.FunctionLikeDeclaration): void {
    const list = this.functions.get(name);
    if (list) list.push(fn);
    else this.functions.set(name, [fn]);
  }

  private add(map: Map<string, ts.Expression[]>, key: string, ...values: ts.Expression[]): void {
    if (!values.length) return;
    const list = map.get(key);
    if (list) list.push(...values);
    else map.set(key, [...values]);
  }

  keyFlowingInto(varName: string): string | undefined {
    for (const rhs of this.assigned.get(varName) || []) {
      const key = this.carries(unwrapFactory(rhs), 0, new Set(), new Map());
      if (key) return key;
    }
    return undefined;
  }

  /** The route.query key `e` evaluates to (possibly with a fallback), if any. */
  /**
   * `env` maps the current function frame's parameter names to the argument
   * expressions they were called with, so a validating identity
   * (`resolveSection(v) { if (valid(v)) return v as Id; … }`) passes the
   * query value through — while `MAP[v]` (a transformation) does not.
   */
  private carries(
    e: ts.Expression,
    depth: number,
    seen: Set<string>,
    env: Map<string, ts.Expression>
  ): string | undefined {
    if (depth > MAX_DEPTH) return undefined;
    e = unwrap(e);

    const direct = routeQueryKey(e);
    if (direct) return direct;

    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        return this.carries(e.left, depth + 1, seen, env) ?? this.carries(e.right, depth + 1, seen, env);
      }
      return undefined;
    }
    if (ts.isConditionalExpression(e)) {
      return this.carries(e.whenTrue, depth + 1, seen, env) ?? this.carries(e.whenFalse, depth + 1, seen, env);
    }
    if (ts.isIdentifier(e)) {
      const name = e.text;
      const arg = env.get(name);
      if (arg) return this.carries(arg, depth + 1, seen, new Map());
      if (seen.has(name)) return undefined;
      const next = new Set(seen).add(name);
      for (const src of this.watchParams.get(name) || []) {
        const k = this.carries(src, depth + 1, next, new Map());
        if (k) return k;
      }
      for (const init of this.assigned.get(name) || []) {
        const k = this.carries(unwrapFactory(init), depth + 1, next, new Map());
        if (k) return k;
      }
      return undefined;
    }
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
      const callee = e.expression.text;
      if (PASS_THROUGH_CALLS.has(callee) && e.arguments[0]) {
        return this.carries(e.arguments[0], depth + 1, seen, env);
      }
      if (seen.has(`${callee}()`)) return undefined;
      const next = new Set(seen).add(`${callee}()`);
      for (const fn of this.functions.get(callee) || []) {
        // Bind parameters to this call's arguments (evaluated in the caller's frame).
        const frame = new Map<string, ts.Expression>();
        fn.parameters.forEach((p, i) => {
          const a = e.arguments[i];
          if (a && ts.isIdentifier(p.name)) frame.set(p.name.text, bindArg(a, env));
        });
        for (const ret of returnedExpressions(fn)) {
          const k = this.carries(ret, depth + 1, next, frame);
          if (k) return k;
        }
      }
    }
    return undefined;
  }
}

/** An argument that is itself a parameter of the calling frame resolves through that frame. */
function bindArg(a: ts.Expression, env: Map<string, ts.Expression>): ts.Expression {
  const u = unwrap(a);
  return ts.isIdentifier(u) && env.has(u.text) ? env.get(u.text)! : a;
}

function unwrap(e: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    (ts.isSatisfiesExpression && ts.isSatisfiesExpression(e))
  ) {
    e = (e as ts.ParenthesizedExpression).expression;
  }
  return e;
}

/** `ref(x)` / `useState(x)` → x; `computed(() => x)` → x; anything else unchanged. */
function unwrapFactory(e: ts.Expression): ts.Expression {
  const u = unwrap(e);
  if (ts.isCallExpression(u) && ts.isIdentifier(u.expression)) {
    const name = u.expression.text;
    if (REF_FACTORIES.has(name) && u.arguments[0]) return u.arguments[0];
    if (name === "computed" && u.arguments[0]) {
      const fn = u.arguments[0];
      if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
        const rets = returnedExpressions(fn);
        if (rets.length === 1) return rets[0];
      }
    }
  }
  return e;
}

/** `v` / `v.value` / `this.v` as an assignment target → "v". */
function assignedVar(left: ts.Expression): string | undefined {
  const l = unwrap(left);
  if (ts.isIdentifier(l)) return l.text;
  if (ts.isPropertyAccessExpression(l)) {
    if (l.name.text === "value" && ts.isIdentifier(l.expression)) return l.expression.text;
    if (l.expression.kind === ts.SyntaxKind.ThisKeyword) return l.name.text;
  }
  return undefined;
}

/** `<something route-ish>.query.<key>` or `.query['key']` → key. */
function routeQueryKey(e: ts.Expression): string | undefined {
  let key: string | undefined;
  let owner: ts.Expression | undefined;
  if (ts.isPropertyAccessExpression(e)) {
    key = e.name.text;
    owner = e.expression;
  } else if (ts.isElementAccessExpression(e) && ts.isStringLiteral(e.argumentExpression)) {
    key = e.argumentExpression.text;
    owner = e.expression;
  }
  if (!key || !owner) return undefined;
  owner = unwrap(owner);
  if (!ts.isPropertyAccessExpression(owner) || owner.name.text !== "query") return undefined;
  return /route/i.test(owner.expression.getText()) ? key : undefined;
}

/** Expressions a function returns (expression body, or `return x` not inside a nested function). */
function returnedExpressions(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const out: ts.Expression[] = [];
  const visit = (n: ts.Node): void => {
    if (n !== fn.body && ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
    ts.forEachChild(n, visit);
  };
  visit(fn.body);
  return out;
}
