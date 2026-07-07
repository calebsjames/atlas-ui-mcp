import ts from "typescript";
import { extractTemplateBlock } from "./vueTemplate.js";

/**
 * Vue emit extraction: which events a component declares (defineEmits /
 * Options API) and which of those actually fire.
 */

/** Declared emits from defineEmits<...>(), defineEmits([...]), or `emits:` options. */
export function extractVueEmits(sourceFile: ts.SourceFile): string[] {
  const emits: string[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineEmits") {
      // Pattern 1: defineEmits<{ (e: "name", val: T): void }>()
      if (node.typeArguments?.[0] && ts.isTypeLiteralNode(node.typeArguments[0])) {
        for (const member of node.typeArguments[0].members) {
          // Call signature: (e: "name", ...): void
          if (ts.isCallSignatureDeclaration(member) && member.parameters.length > 0) {
            const firstParam = member.parameters[0];
            if (firstParam.type && ts.isLiteralTypeNode(firstParam.type) && ts.isStringLiteral(firstParam.type.literal)) {
              emits.push(firstParam.type.literal.text);
            }
          }
        }
      }
      // Pattern 2: defineEmits(["name1", "name2"])
      if (node.arguments[0] && ts.isArrayLiteralExpression(node.arguments[0])) {
        for (const el of node.arguments[0].elements) {
          if (ts.isStringLiteral(el)) {
            emits.push(el.text);
          }
        }
      }
    }

    // Options API: emits: ["update:modelValue", "close"]
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "emits" &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const el of node.initializer.elements) {
        if (ts.isStringLiteral(el)) emits.push(el.text);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return [...new Set(emits)].sort();
}

export interface EmitLiveness {
  fired: string[];
  dead: string[];
  undeclared: string[];
  dynamic: boolean;
}

/**
 * Split DECLARED emits from ones with a real fire site. An event declared but
 * never `emit()`-ed is dead plumbing; one `$emit`-ed but never declared would
 * warn at runtime. Script call sites come from the AST; template call sites
 * (`@click="$emit('x')"`) are scanned from the raw <template>, which isn't in
 * the script AST. A dynamic `emit(someVar)` makes deadness unprovable, so we
 * suppress the dead list rather than report false positives.
 */
export function extractEmitLiveness(
  sourceFile: ts.SourceFile,
  rawContent: string,
  declared: string[]
): EmitLiveness {
  // Identify the identifier bound to defineEmits (usually `emit`), so emit('x')
  // calls are recognisable. `$emit` (Options API / template) always counts.
  const emitVars = new Set<string>();
  const findEmitVar = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "defineEmits" &&
      ts.isIdentifier(node.name)
    ) {
      emitVars.add(node.name.text);
    }
    ts.forEachChild(node, findEmitVar);
  };
  findEmitVar(sourceFile);

  const fired = new Set<string>();
  let dynamic = false;
  const recordFirstArg = (call: ts.CallExpression) => {
    const arg = call.arguments[0];
    if (!arg) return;
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) fired.add(arg.text);
    else dynamic = true; // emit(variable) — which event fires is unknowable statically
  };

  // Script call sites: emit('x', ...) and *.$emit('x', ...).
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && emitVars.has(callee.text)) recordFirstArg(node);
      else if (ts.isPropertyAccessExpression(callee) && callee.name.text === "$emit") recordFirstArg(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  // Template call sites (not in the script AST): $emit('x') or emit('x').
  const template = extractTemplateBlock(rawContent);
  if (template !== undefined) {
    const nameGroup = [...emitVars, "\\$emit"].join("|");
    const re = new RegExp(`(?:${nameGroup})\\(\\s*['"\`]([\\w:-]+)['"\`]`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(template))) fired.add(m[1]);
  }

  const declaredSet = new Set(declared);
  return {
    fired: declared.filter((e) => fired.has(e)).sort(),
    dead: dynamic ? [] : declared.filter((e) => !fired.has(e)).sort(),
    undeclared: declared.length ? [...fired].filter((e) => !declaredSet.has(e)).sort() : [],
    dynamic,
  };
}
