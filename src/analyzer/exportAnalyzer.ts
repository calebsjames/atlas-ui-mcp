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
  /**
   * Callable members reachable through an export, keyed `Owner.method` → 1-based
   * line: methods of an exported class (static or instance), function-valued
   * properties of an exported object literal (`export const fooAdapter = {…}`),
   * and the class methods behind an exported instance (`export const x = new C()`).
   * Class members are not exports, so without this they had no usage index.
   * Every entry here is callable through the named owner itself.
   */
  members: Record<string, number>;
  /**
   * INSTANCE methods of an exported class, as `Class.method` → line. Callers
   * reach them through instances whose names are not known statically (made
   * in another module, or a subclass), so they are listed for lookup but not
   * judged dead.
   */
  instanceMembers: Record<string, number>;
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
  return { primary, names, typeOnlyNames: [...typeOnly], ...extractMembers(sourceFile, names) };
}

const isFn = (e: ts.Expression | undefined) => !!e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e));

/** `Owner.method` → line for the callable members of the exported owners. */
function extractMembers(
  sf: ts.SourceFile,
  exported: string[]
): { members: Record<string, number>; instanceMembers: Record<string, number> } {
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const exportedSet = new Set(exported);
  // Per class: static members (callable as Class.m) and instance members.
  const classMembers = new Map<string, Array<[string, number]>>();
  const classStatics = new Map<string, Array<[string, number]>>();
  const out: Record<string, number> = {};
  const instanceOut: Record<string, number> = {};

  for (const st of sf.statements) {
    if (!ts.isClassDeclaration(st) || !st.name) continue;
    const ms: Array<[string, number]> = [];
    const statics: Array<[string, number]> = [];
    for (const m of st.members) {
      if (!m.name || !ts.isIdentifier(m.name)) continue; // skips #private and computed names
      if (hasModifier(m, ts.SyntaxKind.PrivateKeyword)) continue;
      const callable =
        ts.isMethodDeclaration(m) ||
        ts.isGetAccessorDeclaration(m) ||
        (ts.isPropertyDeclaration(m) && isFn(m.initializer));
      if (!callable) continue;
      (hasModifier(m, ts.SyntaxKind.StaticKeyword) ? statics : ms).push([m.name.text, line(m)]);
    }
    classMembers.set(st.name.text, ms);
    classStatics.set(st.name.text, statics);
  }

  const add = (owner: string, members: Array<[string, number]>) => {
    for (const [m, l] of members) out[`${owner}.${m}`] ??= l;
  };
  for (const [cls, ms] of classMembers) {
    if (!exportedSet.has(cls)) continue;
    add(cls, classStatics.get(cls) ?? []);
    for (const [m, l] of ms) instanceOut[`${cls}.${m}`] ??= l;
  }

  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !exportedSet.has(d.name.text) || !d.initializer) continue;
      let init: ts.Expression = d.initializer;
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression?.(init) || ts.isParenthesizedExpression(init)) {
        init = (init as ts.AsExpression).expression;
      }
      const owner = d.name.text;
      if (ts.isObjectLiteralExpression(init)) {
        const ms: Array<[string, number]> = [];
        for (const p of init.properties) {
          if (!p.name || !ts.isIdentifier(p.name)) continue;
          if (
            ts.isMethodDeclaration(p) ||
            ts.isShorthandPropertyAssignment(p) ||
            (ts.isPropertyAssignment(p) && isFn(p.initializer))
          ) {
            ms.push([p.name.text, line(p)]);
          }
        }
        add(owner, ms);
      } else if (ts.isNewExpression(init) && ts.isIdentifier(init.expression)) {
        add(owner, classMembers.get(init.expression.text) ?? []);
      } else {
        // An instance of a local class by other means: a typed binding
        // (`export const x: C = …`) or a singleton accessor (`C.getInstance()`).
        const typed =
          d.type && ts.isTypeReferenceNode(d.type) && ts.isIdentifier(d.type.typeName)
            ? d.type.typeName.text
            : undefined;
        const viaStatic =
          ts.isCallExpression(init) &&
          ts.isPropertyAccessExpression(init.expression) &&
          ts.isIdentifier(init.expression.expression)
            ? init.expression.expression.text
            : undefined;
        const cls = [typed, viaStatic].find((c) => c && classMembers.has(c));
        if (cls) add(owner, classMembers.get(cls)!);
      }
    }
  }
  return { members: out, instanceMembers: instanceOut };
}
