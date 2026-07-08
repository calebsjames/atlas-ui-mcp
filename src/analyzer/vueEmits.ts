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
  // Options API gets `emit` from the setup CONTEXT instead — `setup(props,
  // { emit })` or `setup(props, ctx)` + `ctx.emit(...)` — so both context
  // shapes register too. (Missing them flagged real fire sites as dead.)
  const emitVars = new Set<string>();
  const ctxVars = new Set<string>();

  // Record bindings named/renamed from `emit` in `{ emit }` / `{ emit: fire }`.
  const addEmitBindings = (pattern: ts.ObjectBindingPattern) => {
    for (const el of pattern.elements) {
      const prop = el.propertyName ?? el.name;
      if (ts.isIdentifier(prop) && prop.text === "emit" && ts.isIdentifier(el.name)) {
        emitVars.add(el.name.text);
      }
    }
  };
  const registerSetupContext = (ctxParam: ts.ParameterDeclaration | undefined) => {
    if (!ctxParam) return;
    if (ts.isObjectBindingPattern(ctxParam.name)) addEmitBindings(ctxParam.name);
    else if (ts.isIdentifier(ctxParam.name)) ctxVars.add(ctxParam.name.text);
  };

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
    // setup(props, { emit }) {...}  — Options API method form.
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "setup") {
      registerSetupContext(node.parameters[1]);
    }
    // setup: (props, ctx) => {...} / setup: function (props, ctx) {...}
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "setup" &&
      (ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer))
    ) {
      registerSetupContext(node.initializer.parameters[1]);
    }
    // const { emit } = ctx — late destructuring of a setup context object.
    // (The setup node is visited before its body, so ctxVars is populated.)
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      ctxVars.has(node.initializer.text)
    ) {
      addEmitBindings(node.name);
    }
    ts.forEachChild(node, findEmitVar);
  };
  findEmitVar(sourceFile);

  const fired = new Set<string>();
  let dynamic = false;
  // The emit fn passed OUT of the component (useOrderForm(props, emit)) can
  // fire any declared event in another module — deadness becomes unprovable,
  // exactly like emit(variable), so it suppresses the dead list too.
  let escaped = false;
  const recordFirstArg = (call: ts.CallExpression) => {
    const arg = call.arguments[0];
    if (!arg) return;
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) fired.add(arg.text);
    else dynamic = true; // emit(variable) — which event fires is unknowable statically
  };

  // Script call sites: emit('x', ...), *.$emit('x', ...), and ctx.emit('x', ...).
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && emitVars.has(callee.text)) recordFirstArg(node);
      else if (ts.isPropertyAccessExpression(callee) && callee.name.text === "$emit") recordFirstArg(node);
      else if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "emit" &&
        ts.isIdentifier(callee.expression) &&
        ctxVars.has(callee.expression.text)
      ) {
        recordFirstArg(node);
      }
    }
    // Any use of the emit identifier that isn't calling it or binding it means
    // it escapes this file (function argument, object property, reassignment).
    if (
      ts.isIdentifier(node) &&
      emitVars.has(node.text) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
      !(ts.isVariableDeclaration(node.parent) && node.parent.name === node) &&
      !ts.isBindingElement(node.parent) &&
      !ts.isParameter(node.parent)
    ) {
      escaped = true;
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
  const unprovable = dynamic || escaped;
  return {
    fired: declared.filter((e) => fired.has(e)).sort(),
    dead: unprovable ? [] : declared.filter((e) => !fired.has(e)).sort(),
    undeclared: declared.length ? [...fired].filter((e) => !declaredSet.has(e)).sort() : [],
    dynamic: unprovable,
  };
}
