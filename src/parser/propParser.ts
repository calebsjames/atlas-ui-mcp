import ts from "typescript";
import fs from "fs/promises";
import path from "path";
import type { ComponentProps, PropInfo } from "../types.js";

/**
 * TypeScript Prop Parser
 * Uses TypeScript Compiler API to extract prop interfaces and default values
 */
export class PropParser {
  /**
   * Parse props from a component file
   */
  async parseFile(filePath: string): Promise<ComponentProps | null> {
    try {
      let content = await fs.readFile(filePath, "utf-8");
      const ext = path.extname(filePath);
      const componentName = path.basename(filePath, ext);
      const isVue = filePath.endsWith(".vue");

      // For .vue files, extract <script> block before parsing
      if (isVue) {
        const scriptMatch = content.match(/<script\b[^>]*>([\s\S]*?)<\/script>/);
        content = scriptMatch ? scriptMatch[1] : "";
        if (!content.trim()) return { componentName, props: {} };
      }

      const sourceFile = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true,
        filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      );

      const defaults = this.extractDefaultValues(sourceFile, componentName);
      const propsInterfaceName = `${componentName}Props`;

      // Standard: look for ComponentNameProps or *Props interface/type alias
      const candidates: (ts.InterfaceDeclaration | ts.TypeAliasDeclaration | null)[] = [
        this.findNode(sourceFile, ts.isInterfaceDeclaration, (n) => n.name.text === propsInterfaceName),
        this.findNode(sourceFile, ts.isTypeAliasDeclaration, (n) => n.name.text === propsInterfaceName),
        this.findNode(sourceFile, ts.isInterfaceDeclaration, (n) => n.name.text.endsWith("Props")),
        this.findNode(sourceFile, ts.isTypeAliasDeclaration, (n) => n.name.text.endsWith("Props")),
      ];

      for (const candidate of candidates) {
        if (!candidate) continue;
        const parsed = ts.isInterfaceDeclaration(candidate)
          ? this.parseInterface(candidate, componentName, sourceFile)
          : this.parseTypeAlias(candidate, componentName, sourceFile);
        return this.mergeDefaults(parsed, defaults);
      }

      // Vue: try defineProps<{...}>() / withDefaults(defineProps<...>(), {...})
      if (isVue) {
        const vueProps = this.parseVueDefineProps(sourceFile, componentName, defaults);
        if (vueProps) return vueProps;

        const optionsProps = this.parseOptionsApiProps(sourceFile, componentName);
        if (optionsProps) return optionsProps;
      }

      return { componentName, props: {} };
    } catch (error) {
      console.error(`Error parsing file ${filePath}:`, error);
      return null;
    }
  }

  private findNode<T extends ts.Node>(
    sourceFile: ts.SourceFile,
    guard: (node: ts.Node) => node is T,
    predicate: (node: T) => boolean
  ): T | null {
    let result: T | null = null;
    const visit = (node: ts.Node) => {
      if (guard(node) && predicate(node)) {
        result = node;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return result;
  }

  private parsePropFromMember(
    member: ts.TypeElement,
    sourceFile: ts.SourceFile
  ): [string, PropInfo] | null {
    if (!ts.isPropertySignature(member) || !member.name) return null;
    const propName = member.name.getText(sourceFile);
    const type = member.type
      ? this.getTypeAsString(member.type, sourceFile)
      : "unknown";
    return [propName, {
      type,
      required: !member.questionToken,
      description: this.getJSDocComment(member),
    }];
  }

  private collectPropsFromMembers(
    members: ts.NodeArray<ts.TypeElement>,
    sourceFile: ts.SourceFile
  ): Record<string, PropInfo> {
    const props: Record<string, PropInfo> = {};
    for (const member of members) {
      const parsed = this.parsePropFromMember(member, sourceFile);
      if (parsed) props[parsed[0]] = parsed[1];
    }
    return props;
  }

  /**
   * Parse type alias declaration for props
   */
  private parseTypeAlias(
    typeAlias: ts.TypeAliasDeclaration,
    componentName: string,
    sourceFile: ts.SourceFile
  ): ComponentProps {
    const typeNodes = ts.isIntersectionTypeNode(typeAlias.type)
      ? typeAlias.type.types
      : [typeAlias.type];

    const props: Record<string, PropInfo> = {};
    for (const typeNode of typeNodes) {
      if (ts.isTypeLiteralNode(typeNode)) {
        Object.assign(props, this.collectPropsFromMembers(typeNode.members, sourceFile));
      }
    }

    return {
      componentName,
      propsInterfaceName: typeAlias.name.text,
      props,
    };
  }

  /**
   * Parse interface declaration
   */
  private parseInterface(
    interfaceNode: ts.InterfaceDeclaration,
    componentName: string,
    sourceFile: ts.SourceFile
  ): ComponentProps {
    const extendsTypes: string[] = [];
    for (const clause of interfaceNode.heritageClauses ?? []) {
      for (const type of clause.types) {
        extendsTypes.push(type.expression.getText(sourceFile));
      }
    }

    return {
      componentName,
      propsInterfaceName: interfaceNode.name.text,
      props: this.collectPropsFromMembers(interfaceNode.members, sourceFile),
      extendsTypes: extendsTypes.length > 0 ? extendsTypes : undefined,
    };
  }

  /**
   * Extract default values from component function parameters
   *
   * Handles patterns:
   *   function Comp({ title = "Hello", count = 0 }: Props) { ... }
   *   const Comp = ({ title = "Hello" }: Props) => { ... }
   *   function Comp(props: Props) { const { title = "Hello" } = props; }
   */
  private extractDefaultValues(
    sourceFile: ts.SourceFile,
    componentName: string
  ): Record<string, string> {
    const defaults: Record<string, string> = {};

    const extractFromBindingPattern = (pattern: ts.ObjectBindingPattern) => {
      for (const element of pattern.elements) {
        if (!ts.isBindingElement(element) || !element.initializer) continue;
        const propName = ts.isIdentifier(element.name) ? element.name.text : element.name.getText(sourceFile);
        defaults[propName] = element.initializer.getText(sourceFile);
      }
    };

    const extractFromFunc = (func: ts.FunctionLikeDeclaration) => {
      for (const param of func.parameters) {
        if (ts.isObjectBindingPattern(param.name)) {
          extractFromBindingPattern(param.name);
        }
      }
      if (func.body && ts.isBlock(func.body)) {
        this.extractDestructuringDefaults(func.body, sourceFile, defaults);
      }
    };

    const visit = (node: ts.Node) => {
      // Pattern 1: function Comp({ title = "Hello" }: Props) { ... }
      if (ts.isFunctionDeclaration(node) && node.name?.text === componentName) {
        extractFromFunc(node);
      }

      // Pattern 2: const Comp = ({ title = "Hello" }: Props) => { ... }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === componentName) {
        const func = this.extractFunctionFromInitializer(node.initializer);
        if (func) extractFromFunc(func);
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return defaults;
  }

  private extractFunctionFromInitializer(
    initializer: ts.Expression | undefined
  ): ts.ArrowFunction | ts.FunctionExpression | undefined {
    if (!initializer) return undefined;
    if (ts.isArrowFunction(initializer)) return initializer;
    if (ts.isFunctionExpression(initializer)) return initializer;
    // Handle React.memo/forwardRef wrapping
    if (ts.isCallExpression(initializer) && initializer.arguments[0]) {
      const inner = initializer.arguments[0];
      if (ts.isArrowFunction(inner)) return inner;
      if (ts.isFunctionExpression(inner)) return inner;
    }
    return undefined;
  }

  /**
   * Extract defaults from destructured `props` inside function body:
   *   const { title = "Hello", count = 0 } = props;
   */
  private extractDestructuringDefaults(
    body: ts.Block,
    sourceFile: ts.SourceFile,
    defaults: Record<string, string>
  ): void {
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        ts.isIdentifier(node.initializer) &&
        node.initializer.text === "props"
      ) {
        for (const element of node.name.elements) {
          if (!ts.isBindingElement(element) || !element.initializer) continue;
          const propName = ts.isIdentifier(element.name) ? element.name.text : element.name.getText(sourceFile);
          defaults[propName] = element.initializer.getText(sourceFile);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(body);
  }

  /**
   * Merge extracted default values into parsed props
   */
  private mergeDefaults(
    result: ComponentProps,
    defaults: Record<string, string>
  ): ComponentProps {
    for (const [propName, defaultValue] of Object.entries(defaults)) {
      if (result.props[propName]) {
        result.props[propName].defaultValue = defaultValue;
      } else {
        // Prop exists in destructuring but not in interface — still add default
        result.props[propName] = {
          type: "unknown",
          required: false,
          defaultValue,
        };
      }
    }
    return result;
  }

  // ========== Vue Prop Parsing ==========

  /**
   * Parse Vue defineProps<{...}>() or withDefaults(defineProps<...>(), {...})
   */
  private parseVueDefineProps(
    sourceFile: ts.SourceFile,
    componentName: string,
    defaults: Record<string, string>
  ): ComponentProps | null {
    let result: ComponentProps | null = null;

    const visit = (node: ts.Node) => {
      if (result) return;
      if (!ts.isCallExpression(node)) {
        ts.forEachChild(node, visit);
        return;
      }

      const expr = node.expression;
      const isDefineProps = ts.isIdentifier(expr) && expr.text === "defineProps";
      const isWithDefaults = ts.isIdentifier(expr) && expr.text === "withDefaults";

      if (!isDefineProps && !isWithDefaults) {
        ts.forEachChild(node, visit);
        return;
      }

      let definePropsNode: ts.CallExpression = node;

      // For withDefaults, first arg is the defineProps call, second arg has defaults
      if (isWithDefaults) {
        const innerCall = node.arguments[0];
        if (innerCall && ts.isCallExpression(innerCall)) {
          definePropsNode = innerCall;
          // Extract defaults from second argument
          const defaultsArg = node.arguments[1];
          if (defaultsArg && ts.isObjectLiteralExpression(defaultsArg)) {
            for (const prop of defaultsArg.properties) {
              if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                defaults[prop.name.text] = prop.initializer.getText(sourceFile);
              }
            }
          }
        }
      }

      // Get type argument: defineProps<TYPE>()
      const typeArgs = definePropsNode.typeArguments;
      if (!typeArgs || typeArgs.length === 0) return;

      const typeArg = typeArgs[0];

      // Inline type literal: defineProps<{ prop: type; ... }>()
      if (ts.isTypeLiteralNode(typeArg)) {
        result = {
          componentName,
          props: this.collectPropsFromMembers(typeArg.members, sourceFile),
        };
      }
      // Reference to local interface: defineProps<Props>()
      else if (ts.isTypeReferenceNode(typeArg) && ts.isIdentifier(typeArg.typeName)) {
        const refName = typeArg.typeName.text;
        const iface = this.findNode(sourceFile, ts.isInterfaceDeclaration, (n) => n.name.text === refName);
        if (iface) {
          result = this.parseInterface(iface, componentName, sourceFile);
        } else {
          const typeAlias = this.findNode(sourceFile, ts.isTypeAliasDeclaration, (n) => n.name.text === refName);
          if (typeAlias) {
            result = this.parseTypeAlias(typeAlias, componentName, sourceFile);
          }
        }
      }
    };

    visit(sourceFile);

    if (result) {
      return this.mergeDefaults(result, defaults);
    }
    return null;
  }

  /**
   * Parse Options API props: defineComponent({ props: { modelValue: { type: String, required: true } } })
   */
  private parseOptionsApiProps(
    sourceFile: ts.SourceFile,
    componentName: string
  ): ComponentProps | null {
    let result: ComponentProps | null = null;

    const visit = (node: ts.Node) => {
      if (result) return;

      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "props" &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        const props: Record<string, PropInfo> = {};

        for (const prop of node.initializer.properties) {
          if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
          const propName = prop.name.text;

          if (ts.isObjectLiteralExpression(prop.initializer)) {
            let type = "unknown";
            let required = false;
            let defaultValue: string | undefined;

            for (const inner of prop.initializer.properties) {
              if (!ts.isPropertyAssignment(inner) || !ts.isIdentifier(inner.name)) continue;
              if (inner.name.text === "type") type = inner.initializer.getText(sourceFile);
              if (inner.name.text === "required" && inner.initializer.kind === ts.SyntaxKind.TrueKeyword) required = true;
              if (inner.name.text === "default") defaultValue = inner.initializer.getText(sourceFile);
            }

            props[propName] = { type, required, defaultValue };
          } else {
            // Shorthand: propName: String
            props[propName] = { type: prop.initializer.getText(sourceFile), required: false };
          }
        }

        result = { componentName, props };
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return result;
  }

  /**
   * Convert TypeScript type node to string
   */
  private getTypeAsString(typeNode: ts.TypeNode, sourceFile: ts.SourceFile): string {
    return typeNode.getText(sourceFile);
  }

  /**
   * Extract JSDoc comment from node
   */
  private getJSDocComment(node: ts.Node): string | undefined {
    const jsDocTags = (node as any).jsDoc;
    if (jsDocTags && jsDocTags.length > 0) {
      const comment = jsDocTags[0].comment;
      if (typeof comment === "string") return comment;
    }
    return undefined;
  }
}
