import ts from "typescript";
import { extractVueScript } from "./vueTemplate.js";
import { scriptAbsoluteLine } from "./sfcParser.js";

/**
 * Sub-file symbol resolution + normalized tokenization — the front half of
 * compare_implementations. Given a file's raw source and a symbol reference,
 * locate the declaration's BODY and emit a canonical token stream the diff
 * engine (bodyDiff.ts) can compare.
 *
 * Framework-agnostic by construction: a Vue SFC's <script>/<script setup> is
 * extracted to plain TS before parsing (line numbers mapped back to the .vue
 * file), so the exact same resolver/tokenizer serves Vue composables/computeds
 * and React functions/hooks/memos alike.
 */

export type TokenKind = "ident" | "prop" | "literal" | "keyword" | "punct";

/**
 * One token of a normalized body. `text` is what the diff compares (formatting
 * gone, quotes/numbers canonicalized); `raw` + `start`/`end` recover the
 * original source for readable hunk snippets; `line` is the 1-based line in the
 * ORIGINAL file (already mapped through the SFC <script> offset for .vue).
 */
export interface NormToken {
  text: string;
  raw: string;
  kind: TokenKind;
  /** Identifier/property that is the callee of a call (next token is `(`). */
  isCallee: boolean;
  /** Offset into the parsed `content` (extracted script for .vue, else raw file). */
  start: number;
  end: number;
  line: number;
}

/** What we compared: the declaration form the symbol resolved to. */
export type DeclKind =
  | "function"
  | "arrow"
  | "method"
  | "get"
  | "computed"
  | "property"
  | "value";

export interface ResolvedSymbol {
  name: string;
  enclosingSymbol?: string;
  declKind: DeclKind;
  tokens: NormToken[];
  startLine: number;
  endLine: number;
  /** The parsed source the token offsets index into — used to slice snippets. */
  content: string;
}

export type SymbolResolution =
  | { ok: true; symbol: ResolvedSymbol }
  | { ok: false; reason: "not-found"; available: string[] }
  | { ok: false; reason: "ambiguous"; candidates: { line: number; declKind: DeclKind }[] };

/** Callee names whose FIRST function argument is the body worth comparing. */
const CALLBACK_WRAPPERS = new Set([
  "computed",
  "useMemo",
  "useCallback",
  "watchEffect",
]);

/** A matched declaration, before we decide between one / many / none. */
interface Candidate {
  body: ts.Node;
  declKind: DeclKind;
  line: number;
}

/**
 * Resolve a symbol (optionally scoped to an enclosing symbol) to its body and
 * return a normalized token stream. Pure over `rawContent` — no fs — so it is
 * unit-testable with inline source and reused by the tool over real files.
 */
export function resolveSymbol(
  rawContent: string,
  filePath: string,
  symbol: string,
  enclosingSymbol?: string
): SymbolResolution {
  const isVue = filePath.endsWith(".vue");
  const content = isVue ? extractVueScript(rawContent) : rawContent;
  const scriptKind = /\.(tsx|jsx)$/.test(filePath)
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );

  // Line in the parsed script → line in the original file (identity for TS).
  const toFileLine = (offset: number): number => {
    const scriptLine = sourceFile.getLineAndCharacterOfPosition(offset).line + 1;
    return isVue ? scriptAbsoluteLine(rawContent, scriptLine) : scriptLine;
  };

  // Narrow the search to the enclosing symbol's subtree when one is given, so a
  // getter like `getHeadInventoryId` inside a factory can be addressed
  // unambiguously even when the same name recurs elsewhere.
  let searchRoot: ts.Node = sourceFile;
  if (enclosingSymbol) {
    const enc = collectCandidates(sourceFile, enclosingSymbol);
    if (enc.length === 0) {
      return { ok: false, reason: "not-found", available: topLevelNames(sourceFile) };
    }
    if (enc.length > 1) {
      return {
        ok: false,
        reason: "ambiguous",
        candidates: enc.map((c) => ({ line: toFileLine(c.body.getStart(sourceFile)), declKind: c.declKind })),
      };
    }
    searchRoot = enc[0].body;
  }

  const matches = collectCandidates(searchRoot, symbol);
  if (matches.length === 0) {
    return {
      ok: false,
      reason: "not-found",
      available: enclosingSymbol
        ? memberNames(searchRoot)
        : topLevelNames(sourceFile),
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      candidates: matches.map((c) => ({
        line: toFileLine(c.body.getStart(sourceFile)),
        declKind: c.declKind,
      })),
    };
  }

  const match = matches[0];
  const tokens = stripFormattingNoise(tokenizeNode(match.body, sourceFile, toFileLine));
  markCallees(tokens);
  return {
    ok: true,
    symbol: {
      name: symbol,
      enclosingSymbol,
      declKind: match.declKind,
      tokens,
      startLine: toFileLine(match.body.getStart(sourceFile)),
      endLine: toFileLine(match.body.getEnd()),
      content,
    },
  };
}

/** Name of a declaration name node (identifier or string literal key). */
function nameText(name: ts.Node | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name)) return name.text;
  return undefined;
}

/**
 * The body node worth comparing for an initializer expression: unwrap arrows,
 * function expressions, and callback-wrapper calls (computed/useMemo/…) down to
 * the executable body; otherwise the expression itself is the value.
 */
function bodyOfInitializer(init: ts.Expression): { body: ts.Node; declKind: DeclKind } {
  if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
    return { body: init.body, declKind: ts.isArrowFunction(init) ? "arrow" : "function" };
  }
  if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && CALLBACK_WRAPPERS.has(init.expression.text)) {
    const arg = init.arguments[0];
    if (arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) {
      return { body: arg.body, declKind: "computed" };
    }
  }
  return { body: init, declKind: "value" };
}

/**
 * Every declaration named `name` reachable under `root`. Covers function
 * declarations, `const x = …` (incl. arrow / computed / plain value), class &
 * object methods (incl. static), get accessors, and object property functions.
 */
function collectCandidates(root: ts.Node, name: string): Candidate[] {
  const out: Candidate[] = [];

  const consider = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.body && nameText(node.name) === name) {
      out.push({ body: node.body, declKind: "function", line: 0 });
    } else if (ts.isMethodDeclaration(node) && node.body && nameText(node.name) === name) {
      out.push({ body: node.body, declKind: "method", line: 0 });
    } else if (ts.isGetAccessorDeclaration(node) && node.body && nameText(node.name) === name) {
      out.push({ body: node.body, declKind: "get", line: 0 });
    } else if (ts.isVariableDeclaration(node) && node.initializer && nameText(node.name) === name) {
      out.push({ ...bodyOfInitializer(node.initializer), line: 0 });
    } else if (ts.isPropertyAssignment(node) && nameText(node.name) === name) {
      out.push({ ...bodyOfInitializer(node.initializer), line: 0 });
    }
  };

  const walk = (node: ts.Node): void => {
    consider(node);
    ts.forEachChild(node, walk);
  };
  // Don't match the search root itself against `name` (it's the enclosing body);
  // start the walk at its children.
  if (root.kind === ts.SyntaxKind.SourceFile) walk(root);
  else ts.forEachChild(root, walk);

  return out;
}

/** Top-level-ish declaration names, for a helpful "did you mean" on not-found. */
function topLevelNames(sourceFile: ts.SourceFile): string[] {
  const names = new Set<string>();
  const add = (n?: string) => {
    if (n) names.add(n);
  };
  const walk = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node)) add(nameText(node.name));
    else if (ts.isClassDeclaration(node)) {
      for (const m of node.members) {
        if (ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m)) add(nameText(m.name));
      }
    } else if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) add(nameText(d.name));
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  return [...names].sort().slice(0, 30);
}

/** Property/method/getter names directly under a node — for scoped not-found. */
function memberNames(root: ts.Node): string[] {
  const names = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isShorthandPropertyAssignment(node)
    ) {
      const n = nameText(node.name);
      if (n) names.add(n);
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(root, walk);
  return [...names].sort().slice(0, 30);
}

const STRING_LIKE = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
]);
const LITERAL_KEYWORD = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
]);
const TEMPLATE_PART = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

/**
 * Flatten a node's subtree into leaf tokens in source order, normalizing as we
 * go. Uses the parsed AST (not a raw re-scan) so template literals, regexes and
 * JSX are already tokenized correctly, and comments — being trivia — are
 * dropped for free.
 */
function tokenizeNode(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  toFileLine: (offset: number) => number
): NormToken[] {
  const out: NormToken[] = [];

  const emitLeaf = (leaf: ts.Node): void => {
    const kind = leaf.kind;
    if (kind === ts.SyntaxKind.EndOfFileToken) return;

    const raw = leaf.getText(sourceFile);
    const start = leaf.getStart(sourceFile);
    const end = leaf.getEnd();

    let tokKind: TokenKind;
    let text: string;

    if (STRING_LIKE.has(kind)) {
      tokKind = "literal";
      text = JSON.stringify((leaf as ts.LiteralLikeNode).text); // canonical double-quoted
    } else if (kind === ts.SyntaxKind.NumericLiteral) {
      tokKind = "literal";
      text = normalizeNumeric(raw);
    } else if (TEMPLATE_PART.has(kind) || LITERAL_KEYWORD.has(kind) ||
      kind === ts.SyntaxKind.RegularExpressionLiteral || kind === ts.SyntaxKind.BigIntLiteral) {
      tokKind = "literal";
      text = raw;
    } else if (kind === ts.SyntaxKind.JsxText) {
      const collapsed = raw.replace(/\s+/g, " ").trim();
      if (!collapsed) return; // whitespace between JSX tags carries no meaning
      tokKind = "literal";
      text = collapsed;
    } else if (kind === ts.SyntaxKind.Identifier || kind === ts.SyntaxKind.PrivateIdentifier) {
      tokKind = isPropertyName(leaf) ? "prop" : "ident";
      text = raw;
    } else if (isKeyword(kind)) {
      tokKind = "keyword";
      text = raw;
    } else {
      tokKind = "punct";
      text = raw;
    }

    out.push({ text, raw, kind: tokKind, isCallee: false, start, end, line: toFileLine(start) });
  };

  const walk = (n: ts.Node): void => {
    const children = n.getChildren(sourceFile);
    if (children.length === 0) {
      emitLeaf(n);
      return;
    }
    for (const child of children) walk(child);
  };
  walk(node);

  return out;
}

/** An identifier that is the `.name` side of a property access (kept verbatim). */
function isPropertyName(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === node) return true;
  if (ts.isQualifiedName(p) && p.right === node) return true;
  return false;
}

function isKeyword(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstKeyword && kind <= ts.SyntaxKind.LastKeyword;
}

/** Canonicalize a numeric literal so `1_000`, `0x10`, `1e3` compare by value. */
function normalizeNumeric(raw: string): string {
  const n = Number(raw.replace(/_/g, ""));
  return Number.isFinite(n) ? String(n) : raw;
}

/**
 * Drop tokens that only reflect formatting style, never behavior: statement
 * terminators (`;` / ASI) and trailing commas before a closer. Both sides are
 * stripped identically, so this can only remove spurious divergences (e.g. a
 * semicolon-free file vs a Prettier'd one), never invent a false equivalence
 * between genuinely different code.
 */
function stripFormattingNoise(tokens: NormToken[]): NormToken[] {
  const out: NormToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.text === ";") continue;
    if (t.text === ",") {
      const next = tokens[i + 1];
      if (next && (next.text === ")" || next.text === "}" || next.text === "]")) continue;
    }
    out.push(t);
  }
  return out;
}

/** Flag identifiers/props immediately followed by `(` as call callees. */
function markCallees(tokens: NormToken[]): void {
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    if ((t.kind === "ident" || t.kind === "prop") && tokens[i + 1].text === "(") {
      t.isCallee = true;
    }
  }
}
