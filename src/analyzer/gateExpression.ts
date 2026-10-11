import ts from "typescript";

/**
 * Parse a render-gate expression (`v-if` / `v-show` / a JSX `&&` guard) with
 * the TypeScript parser instead of a regex. A regex anchored at `^…$` with a
 * lazy capture fused `a === 'x' || a === 'y'` into one corrupt literal, never
 * matched across newlines (so multi-line `||` gates vanished), and swallowed
 * `&&` compounds into ids. The AST makes the boolean structure explicit:
 *
 *   gate        := disjunct ( "||" disjunct )*
 *   disjunct    := term ( "&&" term )*
 *   term        := VAR(.value)? ===|== 'literal'   (either side)
 *
 * Each disjunct is one way the element renders; a disjunct with several terms
 * is a compound condition (`activeSection === 'Projects' && activeTab === 'X'`).
 */

/** `var === 'value'` (the `.value` unwrap of a Vue ref is dropped). */
export interface GateTerm {
  var: string;
  value: string;
}

/** One way the gate is satisfied: every term must hold. */
export interface GateDisjunct {
  terms: GateTerm[];
  /** Source of conjuncts that are not literal equalities (`isAdmin`, `x > 2`). */
  extra?: string[];
}

/**
 * Parse `expr` into disjuncts. Disjuncts with no literal-equality term are
 * dropped (`a === 'x' || isOpen` keeps only `a === 'x'`). Returns [] for
 * anything unparseable or gate-free.
 */
export function parseGateDisjuncts(expr: string): GateDisjunct[] {
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile("gate.ts", `(${expr});`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  } catch {
    return [];
  }
  const stmt = sf.statements[0];
  if (!stmt || !ts.isExpressionStatement(stmt)) return [];
  // A syntax error still yields a tree; refuse to read meaning into it.
  if ((sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics?.length) return [];

  const out: GateDisjunct[] = [];
  for (const d of disjuncts(stmt.expression)) {
    const terms: GateTerm[] = [];
    const extra: string[] = [];
    for (const c of conjuncts(d)) {
      const t = equalityTerm(c);
      if (t) terms.push(t);
      else extra.push(c.getText(sf));
    }
    if (terms.length) out.push({ terms, ...(extra.length ? { extra } : {}) });
  }
  return out;
}

/**
 * The single `var === 'literal'` a gate reduces to, or null when it is
 * anything else (a disjunction, a compound, a non-literal comparison).
 */
export function parseSingleEquality(expr: string): GateTerm | null {
  const ds = parseGateDisjuncts(expr);
  if (ds.length !== 1 || ds[0].terms.length !== 1 || ds[0].extra) return null;
  return ds[0].terms[0];
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

function isBinary(e: ts.Expression, kind: ts.SyntaxKind): e is ts.BinaryExpression {
  return ts.isBinaryExpression(e) && e.operatorToken.kind === kind;
}

function disjuncts(e: ts.Expression): ts.Expression[] {
  e = unwrap(e);
  if (isBinary(e, ts.SyntaxKind.BarBarToken)) return [...disjuncts(e.left), ...disjuncts(e.right)];
  return [e];
}

function conjuncts(e: ts.Expression): ts.Expression[] {
  e = unwrap(e);
  if (isBinary(e, ts.SyntaxKind.AmpersandAmpersandToken)) {
    return [...conjuncts(e.left), ...conjuncts(e.right)];
  }
  return [e];
}

function stringLiteral(e: ts.Expression): string | undefined {
  e = unwrap(e);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  return undefined;
}

/** `x` or `x.value` → "x". Anything else (calls, deeper paths) is not a gate variable. */
function gateVar(e: ts.Expression): string | undefined {
  e = unwrap(e);
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e) && e.name.text === "value" && ts.isIdentifier(e.expression)) {
    return e.expression.text;
  }
  return undefined;
}

function equalityTerm(e: ts.Expression): GateTerm | null {
  e = unwrap(e);
  if (
    !isBinary(e, ts.SyntaxKind.EqualsEqualsEqualsToken) &&
    !isBinary(e, ts.SyntaxKind.EqualsEqualsToken)
  ) {
    return null;
  }
  const leftLit = stringLiteral(e.left);
  const rightLit = stringLiteral(e.right);
  if (rightLit !== undefined) {
    const v = gateVar(e.left);
    if (v) return { var: v, value: rightLit };
  }
  if (leftLit !== undefined) {
    const v = gateVar(e.right);
    if (v) return { var: v, value: leftLit };
  }
  return null;
}
