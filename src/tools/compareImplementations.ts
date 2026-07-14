import fs from "fs/promises";
import path from "path";
import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import { resolveSymbol, type DeclKind } from "../analyzer/symbolBody.js";
import { diffBodies, type Divergence } from "../analyzer/bodyDiff.js";
import { ensureCatalog } from "./shared.js";

/**
 * compare_implementations — answer the question the reuse workflow keeps asking
 * and the structural tools cannot: "are these two implementations equivalent,
 * and if not, exactly where do they differ?"
 *
 * Given two symbol references ({ file, symbol, enclosingSymbol? }) it resolves
 * each declaration's body, normalizes away formatting/comments/quote-style, and
 * reports the surviving syntactic divergences — literals, callees, guards, and
 * added/removed branches — with source snippets and line spans. `equivalent`
 * means byte-equal after normalization, the signal that unification is safe.
 *
 * Works identically for Vue and React: a .vue <script> is extracted to TS
 * before parsing, so composables/computeds and hooks/memos flow through the
 * same resolver + diff engine.
 */

export interface SymbolRef {
  file: string;
  symbol: string;
  enclosingSymbol?: string;
}

export interface CompareArgs {
  a: SymbolRef;
  /** `file` may be omitted to reuse A's file (comparing two symbols in one file). */
  b: SymbolRef;
  maxDivergences?: number;
}

interface SideInfo {
  file: string;
  symbol: string;
  enclosingSymbol?: string;
  declKind: DeclKind;
  startLine: number;
  endLine: number;
}

export interface CompareResult {
  a: SideInfo;
  b: SideInfo;
  verdict: "equivalent" | "diverges";
  normalization: string;
  divergenceCount: number;
  divergences: Divergence[];
  note?: string;
}

export interface CompareError {
  error: string;
  side?: "a" | "b";
  candidates?: { line: number; declKind: DeclKind }[];
  available?: string[];
}

const NORMALIZATION =
  "comments & formatting stripped; string quotes and numeric literals canonicalized; " +
  "identifiers and type annotations preserved (no alpha-renaming); " +
  "computed()/useMemo()/useCallback() compared by callback body. " +
  "Vue SFC <script> is extracted to TS, so Vue and React compare on equal footing.";

const DEFAULT_MAX_DIVERGENCES = 40;

/** Pure comparison core — no fs, no catalog. Unit-testable with inline source. */
export function compareSymbols(
  a: { content: string; ref: SymbolRef },
  b: { content: string; ref: SymbolRef },
  opts?: { maxDivergences?: number }
): CompareResult | CompareError {
  const ra = resolveSymbol(a.content, a.ref.file, a.ref.symbol, a.ref.enclosingSymbol);
  if (!ra.ok) return resolutionError("a", a.ref, ra);
  const rb = resolveSymbol(b.content, b.ref.file, b.ref.symbol, b.ref.enclosingSymbol);
  if (!rb.ok) return resolutionError("b", b.ref, rb);

  const { divergences, truncated } = diffBodies(
    ra.symbol.tokens,
    rb.symbol.tokens,
    ra.symbol.content,
    rb.symbol.content
  );

  const max = opts?.maxDivergences ?? DEFAULT_MAX_DIVERGENCES;
  const shown = divergences.slice(0, max);
  const notes: string[] = [];
  if (truncated) {
    notes.push("Bodies were too large to align token-by-token; reported as a bulk replacement.");
  }
  if (divergences.length > shown.length) {
    notes.push(`${divergences.length - shown.length} further divergence(s) omitted (raise maxDivergences to see all).`);
  }

  return {
    a: sideInfo(a.ref, ra.symbol),
    b: sideInfo(b.ref, rb.symbol),
    verdict: divergences.length === 0 ? "equivalent" : "diverges",
    normalization: NORMALIZATION,
    divergenceCount: divergences.length,
    divergences: shown,
    ...(notes.length ? { note: notes.join(" ") } : {}),
  };
}

/**
 * Tool entry point. Resolves each side's `file` (a catalog path or a
 * workspace-relative/absolute path), reads the source, and runs the core.
 */
export async function compareImplementations(
  args: CompareArgs,
  scanner: ComponentScanner,
  cache: CacheManager,
  workspaceRoot: string
): Promise<CompareResult | CompareError> {
  if (!args?.a?.file || !args?.a?.symbol) {
    return { error: 'Provide a.file and a.symbol (the first implementation to compare).', side: "a" };
  }
  const aRef = args.a;
  const bRef: SymbolRef = { ...args.b, file: args.b?.file || aRef.file };
  if (!bRef.symbol) {
    return { error: "Provide b.symbol (the second implementation to compare).", side: "b" };
  }

  await ensureCatalog(scanner, cache);

  const aFile = await resolveFile(aRef.file, cache, workspaceRoot);
  if ("error" in aFile) return { ...aFile, side: "a" };
  const bFile = aRef.file === bRef.file && args.b?.file == null
    ? aFile
    : await resolveFile(bRef.file, cache, workspaceRoot);
  if ("error" in bFile) return { ...bFile, side: "b" };

  return compareSymbols(
    { content: aFile.content, ref: { ...aRef, file: aFile.relativePath } },
    { content: bFile.content, ref: { ...bRef, file: bFile.relativePath } },
    { maxDivergences: args.maxDivergences }
  );
}

function sideInfo(ref: SymbolRef, resolved: { declKind: DeclKind; startLine: number; endLine: number }): SideInfo {
  const out: SideInfo = {
    file: ref.file,
    symbol: ref.symbol,
    declKind: resolved.declKind,
    startLine: resolved.startLine,
    endLine: resolved.endLine,
  };
  if (ref.enclosingSymbol) out.enclosingSymbol = ref.enclosingSymbol;
  return out;
}

function resolutionError(
  side: "a" | "b",
  ref: SymbolRef,
  res: Extract<ReturnType<typeof resolveSymbol>, { ok: false }>
): CompareError {
  const where = ref.enclosingSymbol ? ` in "${ref.enclosingSymbol}"` : "";
  if (res.reason === "ambiguous") {
    return {
      error: `Symbol "${ref.symbol}"${where} in ${ref.file} matches ${res.candidates.length} declarations. ` +
        `Pass enclosingSymbol to disambiguate.`,
      side,
      candidates: res.candidates,
    };
  }
  return {
    error: `Symbol "${ref.symbol}"${where} was not found in ${ref.file}.` +
      (res.available.length ? " Available symbols are listed." : ""),
    side,
    available: res.available,
  };
}

interface ResolvedFile {
  path: string;
  relativePath: string;
  content: string;
}

/**
 * Resolve a `file` argument to a real file. Prefers catalog entries (exact
 * relative path → suffix → substring), falling back to a direct read of a
 * workspace-relative or absolute path so files outside the scanned catalog
 * (e.g. src/utils helpers) are still comparable.
 */
async function resolveFile(
  fileArg: string,
  cache: CacheManager,
  workspaceRoot: string
): Promise<ResolvedFile | { error: string; candidates?: { line: number; declKind: DeclKind }[] }> {
  const norm = (p: string) => p.split("\\").join("/");
  const wanted = norm(fileArg);
  const components = cache.getCatalog()?.components ?? [];

  const exact = components.filter((c) => norm(c.relativePath) === wanted);
  const suffix = components.filter((c) => norm(c.relativePath).endsWith(wanted));
  const substr = components.filter(
    (c) => norm(c.relativePath).includes(wanted) || norm(c.path).includes(wanted)
  );
  const tier = exact.length ? exact : suffix.length ? suffix : substr;
  const uniquePaths = [...new Set(tier.map((c) => c.path))];

  if (uniquePaths.length === 1) return readFile(uniquePaths[0], workspaceRoot);
  if (uniquePaths.length > 1) {
    return {
      error: `"${fileArg}" matches ${uniquePaths.length} files. Pass a more specific path.`,
    };
  }

  // Not in the catalog — treat as a path and read it directly.
  const abs = path.isAbsolute(fileArg) ? fileArg : path.join(workspaceRoot, fileArg);
  try {
    const content = await fs.readFile(abs, "utf-8");
    return { path: abs, relativePath: norm(path.relative(workspaceRoot, abs)), content };
  } catch {
    return { error: `Could not resolve or read file "${fileArg}".` };
  }
}

async function readFile(absPath: string, workspaceRoot: string): Promise<ResolvedFile> {
  const content = await fs.readFile(absPath, "utf-8");
  return {
    path: absPath,
    relativePath: path.relative(workspaceRoot, absPath).split("\\").join("/"),
    content,
  };
}
