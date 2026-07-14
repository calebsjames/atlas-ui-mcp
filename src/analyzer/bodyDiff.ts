import type { NormToken } from "./symbolBody.js";

/**
 * The back half of compare_implementations: diff two normalized token streams
 * and classify the differences into human-readable divergences. Pure over
 * NormToken[] — no AST, no fs — so it is trivially testable and reusable (a
 * future find_duplicate_logic / bodyHash can share the same engine).
 *
 * The strategy is deliberately syntactic, per the design note: alpha-free
 * normalization already happened upstream; here we LCS-align the token streams,
 * coalesce noisy micro-matches, and label each surviving hunk. Surfacing the
 * raw hunks is the goal — the `kind` label is a hint, the a/b snippets are the
 * ground truth.
 */

export type DivergenceKind =
  | "literal"
  | "callee-changed"
  | "guard-changed"
  | "operator-changed"
  | "added-block"
  | "removed-block"
  | "added"
  | "removed"
  | "changed";

export interface Divergence {
  kind: DivergenceKind;
  /** Original source on the A side (omitted for a pure insertion). */
  a?: string;
  /** Original source on the B side (omitted for a pure deletion). */
  b?: string;
  /** File line span on the A side, e.g. "L52" or "L52-55". */
  locA?: string;
  /** File line span on the B side. */
  locB?: string;
}

type OpType = "equal" | "del" | "ins";
interface Op {
  type: OpType;
  a?: NormToken; // present for equal + del
  b?: NormToken; // present for equal + ins
}

interface Hunk {
  aTokens: NormToken[]; // deleted (A-only)
  bTokens: NormToken[]; // inserted (B-only)
}

/** Above this token-product the LCS table is skipped (guards pathological input). */
const LCS_CELL_BUDGET = 4_000_000;
const SNIPPET_MAX = 240;

const COMPARISON_LOGICAL = new Set([
  "===", "!==", "==", "!=", "<", ">", "<=", ">=", "&&", "||", "??", "!", "?", ":",
]);
const ARITHMETIC = new Set(["+", "-", "*", "/", "%", "**"]);
const BLOCK_KEYWORDS = new Set([
  "if", "for", "while", "return", "switch", "const", "let", "var", "throw", "try", "do",
]);

/** Build the classified divergence list for two token streams + their sources. */
export function diffBodies(
  aTokens: NormToken[],
  bTokens: NormToken[],
  aContent: string,
  bContent: string
): { divergences: Divergence[]; truncated: boolean } {
  const { ops, truncated } = diffTokens(aTokens, bTokens);
  const cleaned = semanticCleanup(ops);
  const hunks = groupHunks(cleaned);
  const divergences = hunks.map((h) => classifyHunk(h, aContent, bContent));
  return { divergences, truncated };
}

/** LCS token alignment → ordered edit script. Falls back to whole-body replace
 * when the streams are too large to align cheaply. */
function diffTokens(a: NormToken[], b: NormToken[]): { ops: Op[]; truncated: boolean } {
  if (a.length * b.length > LCS_CELL_BUDGET) {
    const ops: Op[] = [
      ...a.map((t) => ({ type: "del" as const, a: t })),
      ...b.map((t) => ({ type: "ins" as const, b: t })),
    ];
    return { ops, truncated: true };
  }

  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i].text === b[j].text
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].text === b[j].text) {
      ops.push({ type: "equal", a: a[i], b: b[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", a: a[i] });
      i++;
    } else {
      ops.push({ type: "ins", b: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", a: a[i++] });
  while (j < m) ops.push({ type: "ins", b: b[j++] });
  return { ops, truncated: false };
}

/**
 * Dissolve trivial `equal` runs wedged between changes back into edits. Token
 * LCS loves to "match" a stray `)` `,` `}` across two unrelated regions, which
 * shatters one real change into several tiny hunks; re-absorbing those short
 * punctuation-only anchors keeps each divergence whole and readable.
 */
function semanticCleanup(ops: Op[]): Op[] {
  const isChange = (op: Op | undefined) => op != null && op.type !== "equal";

  // Index equal-run boundaries.
  const out: Op[] = [];
  let idx = 0;
  while (idx < ops.length) {
    if (ops[idx].type !== "equal") {
      out.push(ops[idx++]);
      continue;
    }
    // Gather a maximal equal run.
    const runStart = idx;
    while (idx < ops.length && ops[idx].type === "equal") idx++;
    const run = ops.slice(runStart, idx);
    const flankedBefore = isChange(out[out.length - 1]);
    const flankedAfter = isChange(ops[idx]);
    const trivial = run.length <= 2 && run.every((op) => op.a!.kind === "punct");
    if (trivial && flankedBefore && flankedAfter) {
      // Split each equal into a del + ins so it merges into surrounding hunk.
      for (const op of run) {
        out.push({ type: "del", a: op.a });
        out.push({ type: "ins", b: op.b });
      }
    } else {
      out.push(...run);
    }
  }
  return out;
}

/** Collapse the edit script into hunks (contiguous del/ins runs). */
function groupHunks(ops: Op[]): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  const flush = () => {
    if (current && (current.aTokens.length || current.bTokens.length)) hunks.push(current);
    current = null;
  };
  for (const op of ops) {
    if (op.type === "equal") {
      flush();
      continue;
    }
    if (!current) current = { aTokens: [], bTokens: [] };
    if (op.type === "del") current.aTokens.push(op.a!);
    else current.bTokens.push(op.b!);
  }
  flush();
  return hunks;
}

function classifyHunk(hunk: Hunk, aContent: string, bContent: string): Divergence {
  const { aTokens, bTokens } = hunk;
  const a = aTokens.length ? snippet(aContent, aTokens) : undefined;
  const b = bTokens.length ? snippet(bContent, bTokens) : undefined;
  const locA = aTokens.length ? loc(aTokens) : undefined;
  const locB = bTokens.length ? loc(bTokens) : undefined;

  let kind: DivergenceKind;
  if (aTokens.length === 0) {
    kind = looksLikeBlock(bTokens) ? "added-block" : "added";
  } else if (bTokens.length === 0) {
    kind = looksLikeBlock(aTokens) ? "removed-block" : "removed";
  } else {
    kind = classifyChange(aTokens, bTokens);
  }

  const out: Divergence = { kind };
  if (a !== undefined) {
    out.a = a;
    out.locA = locA;
  }
  if (b !== undefined) {
    out.b = b;
    out.locB = locB;
  }
  return out;
}

/** Sub-classify a two-sided change by what kind of token actually differs. */
function classifyChange(aTokens: NormToken[], bTokens: NormToken[]): DivergenceKind {
  const all = [...aTokens, ...bTokens];
  if (all.every((t) => t.kind === "literal")) return "literal";
  if (all.some((t) => t.isCallee)) return "callee-changed";
  if (all.some((t) => t.kind === "punct" && COMPARISON_LOGICAL.has(t.text))) return "guard-changed";
  if (all.some((t) => t.kind === "punct" && ARITHMETIC.has(t.text))) return "operator-changed";
  return "changed";
}

/** A one-sided hunk reads as a "block" when it's a statement-sized chunk. */
function looksLikeBlock(tokens: NormToken[]): boolean {
  if (tokens.some((t) => t.kind === "keyword" && BLOCK_KEYWORDS.has(t.text))) return true;
  if (tokens.length >= 6) return true;
  return loc(tokens).includes("-"); // spans more than one line
}

/** Original source for a contiguous token run, whitespace-collapsed + capped. */
function snippet(content: string, tokens: NormToken[]): string {
  const from = tokens[0].start;
  const to = tokens[tokens.length - 1].end;
  const text = content.slice(from, to).replace(/\s+/g, " ").trim();
  return text.length > SNIPPET_MAX ? text.slice(0, SNIPPET_MAX - 1) + "…" : text;
}

/** File line span of a token run: "L52" or "L52-55". */
function loc(tokens: NormToken[]): string {
  let lo = tokens[0].line;
  let hi = tokens[0].line;
  for (const t of tokens) {
    if (t.line < lo) lo = t.line;
    if (t.line > hi) hi = t.line;
  }
  return lo === hi ? `L${lo}` : `L${lo}-${hi}`;
}
