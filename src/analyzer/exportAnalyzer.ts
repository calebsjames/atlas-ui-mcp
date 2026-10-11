import ts from "typescript";

/** Names bound by a declaration name node (identifier or destructuring pattern). */
function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const out: string[] = [];
  for (const el of name.elements) {
    if (ts.isBindingElement(el)) out.push(...bindingNames(el.name));
  }
  return out;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === kind);
}

const isUseName = (n: string) => /^use[A-Z0-9]/.test(n);
const isPascal = (n: string) => /^[A-Z]/.test(n);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export interface ModuleExports {
  /** Best single name for the file's catalog node; undefined if nothing nameable. */
  primary?: string;
  /** Every exported symbol name — indexed so any export resolves by name. */
  names: string[];
  /** The subset of `names` exported as types only (`export type { X }`). */
  typeOnlyNames: string[];
}

/**
 * Enumerate a module's exports from its AST and pick the primary name. Correctly
 * reads forms the old regex missed: `export { X }`, `export { X as default }`,
 * `export default Ident`, `export default function/class X`, and destructured
 * `export const { a, b } = …`.
 *
 * Primary priority: a named default export (the file's main thing) → for hook
 * files, a `useX` export → an export whose name matches the filename → the
 * first PascalCase export → the first export.
 *
 * Type-only exports (`export type { X }`) are ranked LAST for the primary name:
 * they export no runtime value, so letting one win made a re-exported type the
 * catalog name of a module full of real functions. They stay in `names` (and so
 * in the by-export index) — a module whose exports are all types is still named
 * after one of them rather than falling back to its filename.
 */
export function analyzeModuleExports(
  sourceFile: ts.SourceFile,
  fileBaseName: string,
  layerHint: string
): ModuleExports {
  let defaultName: string | undefined;
  const named: string[] = [];
  const typeOnly = new Set<string>();

  for (const stmt of sourceFile.statements) {
    // export default <ident>   (not `export =`)
    if (ts.isExportAssignment(stmt)) {
      if (!stmt.isExportEquals && ts.isIdentifier(stmt.expression)) {
        defaultName ??= stmt.expression.text;
      }
      continue;
    }
    // export [default] function/class Foo
    if (
      (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) &&
      hasModifier(stmt, ts.SyntaxKind.ExportKeyword) &&
      stmt.name
    ) {
      if (hasModifier(stmt, ts.SyntaxKind.DefaultKeyword)) defaultName ??= stmt.name.text;
      else named.push(stmt.name.text);
      continue;
    }
    // export const/let/var … (including destructuring patterns)
    if (ts.isVariableStatement(stmt) && hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) {
      for (const decl of stmt.declarationList.declarations) named.push(...bindingNames(decl.name));
      continue;
    }
    // export { a, b as c }  /  export { X as default }
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        if (el.name.text === "default") {
          if (el.propertyName) defaultName ??= el.propertyName.text;
        } else {
          named.push(el.name.text);
          // `export type { X }` (whole clause) or `export { type X }` (specifier).
          if (stmt.isTypeOnly || el.isTypeOnly) typeOnly.add(el.name.text);
        }
      }
    }
  }

  const fileNorm = norm(fileBaseName);
  // Value exports first; type-only exports are the fallback pool.
  const values = named.filter((n) => !typeOnly.has(n));
  const pick = (pool: string[]) =>
    (layerHint === "hook" ? pool.find(isUseName) : undefined) ??
    pool.find((n) => norm(n) === fileNorm) ??
    pool.find(isPascal) ??
    pool[0];
  const primary = defaultName ?? pick(values) ?? pick(named);

  const names = [...new Set([...(defaultName ? [defaultName] : []), ...named])];
  return { primary, names, typeOnlyNames: [...typeOnly] };
}
