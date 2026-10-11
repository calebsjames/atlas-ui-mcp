import fs from "fs/promises";
import ts from "typescript";
import { extractVueScript } from "./vueTemplate.js";
import { scriptAbsoluteLine } from "./sfcParser.js";

/** Where and what one exported symbol of a module is. */
export interface ExportDeclarationInfo {
  /** 1-based line of the declaration in the original file. */
  line: number;
  kind: "function" | "class" | "variable" | "type" | "interface" | "enum" | "reexport";
  /** The declaration's JSDoc summary, when it has one. */
  description?: string;
}

/**
 * Locate the top-level declaration of `symbol` in a module, so a tool answering
 * about a SECONDARY export can report that symbol's own line and JSDoc instead
 * of the primary export's. Handles `export function/class/const/type/…` and
 * `export { local as symbol }`. Undefined when the file can't be read or the
 * symbol isn't declared at top level.
 */
export async function findExportDeclaration(
  filePath: string,
  symbol: string
): Promise<ExportDeclarationInfo | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return undefined;
  }
  const isVue = filePath.endsWith(".vue");
  const content = isVue ? extractVueScript(raw) : raw;
  const sf = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    /\.(tsx|jsx)$/.test(filePath) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const lineOf = (n: ts.Node) => {
    const l = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    return isVue ? scriptAbsoluteLine(raw, l) : l;
  };

  // `export { local as symbol }` points at a local declaration.
  let wanted = symbol;
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        if (el.name.text !== symbol) continue;
        if (st.moduleSpecifier) return { line: lineOf(el), kind: "reexport" };
        if (el.propertyName) wanted = el.propertyName.text;
      }
    }
  }

  for (const st of sf.statements) {
    const hit = declares(st, wanted);
    if (hit) return { line: lineOf(st), kind: hit, ...jsdoc(st) };
  }
  return undefined;
}

function declares(st: ts.Statement, name: string): ExportDeclarationInfo["kind"] | undefined {
  if (ts.isFunctionDeclaration(st) && st.name?.text === name) return "function";
  if (ts.isClassDeclaration(st) && st.name?.text === name) return "class";
  if (ts.isInterfaceDeclaration(st) && st.name.text === name) return "interface";
  if (ts.isTypeAliasDeclaration(st) && st.name.text === name) return "type";
  if (ts.isEnumDeclaration(st) && st.name.text === name) return "enum";
  if (ts.isVariableStatement(st)) {
    for (const d of st.declarationList.declarations) {
      if (bindsName(d.name, name)) return "variable";
    }
  }
  return undefined;
}

/** `x`, or `x` bound inside a destructuring pattern (`const { useLogin } = …`). */
function bindsName(b: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(b)) return b.text === name;
  return b.elements.some((el) => ts.isBindingElement(el) && bindsName(el.name, name));
}

function jsdoc(node: ts.Node): { description?: string } {
  const docs = (node as unknown as { jsDoc?: ts.JSDoc[] }).jsDoc;
  const last = docs?.[docs.length - 1];
  const comment = last?.comment;
  const text = typeof comment === "string" ? comment : comment?.map((c) => c.text).join("");
  return text?.trim() ? { description: text.trim() } : {};
}
