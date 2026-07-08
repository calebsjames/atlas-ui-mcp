import fs from "fs/promises";
import path from "path";
import ts from "typescript";
import type {
  ComponentAnalysis,
  ImportInfo,
  ArchitectureLayer,
  FormFieldInfo,
  ProjectConfig,
} from "../types.js";
import {
  FORM_CONTROL_TAGS,
  getJsxAttrStringValue,
  extractJsxFormField,
  dedupeFormFields,
} from "./formFields.js";
import {
  extractVueScript,
  analyzeVueTemplate,
  extractChildEventBindings,
  extractVueTemplateSelectors,
} from "./vueTemplate.js";
import { extractVueEmits, extractEmitLiveness } from "./vueEmits.js";
import { analyzeVueTemplatePatterns } from "./templatePatterns.js";
import {
  adapterMethodCallOf,
  addToSetMap,
  analyzeHook,
  analyzeServiceOrAdapter,
  extractStoreName,
  setMapToRecord,
} from "./layerAnalyzers.js";
import { checkPhiCompliance } from "./phiCompliance.js";
import { extractAccessibility } from "./accessibility.js";
import { detectDataFetchingPattern } from "./dataFetching.js";

/**
 * Component Analyzer - AST-Based
 * Uses TypeScript Compiler API for accurate code analysis instead of regex.
 * Vue <template> concerns live in the vueTemplate/vueEmits/templatePatterns
 * modules; layer-specific extras (hook/service/store/PHI) in layerAnalyzers.
 */
export class ComponentAnalyzer {
  constructor(
    private readonly config?: ProjectConfig,
    private readonly workspaceRoot?: string
  ) {}

  async analyzeComponent(
    filePath: string,
    componentName: string,
    layer: ArchitectureLayer = "component"
  ): Promise<ComponentAnalysis> {
    try {
      const rawContent = await fs.readFile(filePath, "utf-8");
      const isVue = filePath.endsWith(".vue");

      // For .vue files, extract the <script> block for AST analysis
      const content = isVue ? extractVueScript(rawContent) : rawContent;

      const sourceFile = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true,
        filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      );

      const base = this.analyzeWithAST(sourceFile, content, componentName, filePath);

      if (isVue) {
        this.applyVueAnalysis(base, sourceFile, rawContent);
      }

      this.applyLayerAnalysis(base, sourceFile, content, layer);

      // PHI compliance is opt-in — noisy heuristics only run when explicitly enabled.
      if (
        this.config?.phiCompliance?.enabled === true &&
        (layer === "hook" || layer === "component" || layer === "page")
      ) {
        base.phiCompliance = checkPhiCompliance(sourceFile);
      }

      return base;
    } catch (error) {
      console.error(`Error analyzing ${filePath}:`, error);
      return {};
    }
  }

  /** Vue-only signals: template children/events, emits + liveness, selectors, patterns. */
  private applyVueAnalysis(
    base: ComponentAnalysis,
    sourceFile: ts.SourceFile,
    rawContent: string
  ): void {
    const templateAnalysis = analyzeVueTemplate(rawContent);
    base.childComponents = [...new Set([...(base.childComponents || []), ...templateAnalysis.childComponents])].sort();
    base.eventHandlers = [...new Set([...(base.eventHandlers || []), ...templateAnalysis.eventHandlers])].sort();

    // Extract emits from defineEmits / Options API
    base.emits = extractVueEmits(sourceFile);

    // Emit liveness: which declared emits actually fire vs. which are dead
    // plumbing (declared but never emit()-ed), plus any fired-but-undeclared.
    const liveness = extractEmitLiveness(sourceFile, rawContent, base.emits ?? []);
    if (liveness.fired.length) base.emitsFired = liveness.fired;
    if (liveness.dead.length) base.emitsDead = liveness.dead;
    if (liveness.undeclared.length) base.emitsUndeclared = liveness.undeclared;
    if (liveness.dynamic) base.emitsDynamic = true;

    // Per-child @event bindings — feeds cross-component dangling-listener detection.
    const childBindings = extractChildEventBindings(rawContent);
    if (childBindings.length) base.childEventBindings = childBindings;

    // Template-layer design signals: overlay/backdrop, Teleport, z-index, header.
    const templatePatterns = analyzeVueTemplatePatterns(rawContent, this.config?.templatePatterns);
    if (templatePatterns) base.templatePatterns = templatePatterns;

    // Detect v-model bindings: emits matching "update:xxx" pattern
    const vModelBindings = (base.emits ?? [])
      .filter((e) => e.startsWith("update:"))
      .map((e) => e.slice("update:".length));
    if (vModelBindings.length > 0) {
      base.vModelBindings = vModelBindings;
    }

    // Use full content for accessibility (includes <template>)
    base.accessibility = extractAccessibility(rawContent);

    // Selectors live in the <template>, not the <script> AST — extract via regex.
    const vueSelectors = extractVueTemplateSelectors(rawContent);
    if (vueSelectors.testIds.length) {
      base.testIds = [...new Set([...(base.testIds || []), ...vueSelectors.testIds])].sort();
    }
    if (vueSelectors.formFields.length) {
      base.formFields = dedupeFormFields([...(base.formFields || []), ...vueSelectors.formFields]);
    }
  }

  /** Layer-specific extras for hooks, services/adapters, and stores. */
  private applyLayerAnalysis(
    base: ComponentAnalysis,
    sourceFile: ts.SourceFile,
    content: string,
    layer: ArchitectureLayer
  ): void {
    if (layer === "hook") {
      Object.assign(base, analyzeHook(sourceFile));
    } else if (layer === "service" || layer === "adapter") {
      Object.assign(base, analyzeServiceOrAdapter(sourceFile, content));
    } else if (layer === "store") {
      // Stores expose service endpoints (they frequently call services directly)
      // AND collect adapter/service calls the way a hook does. Merge both signals.
      const serviceAnalysis = analyzeServiceOrAdapter(sourceFile, content);
      const hookAnalysis = analyzeHook(sourceFile);
      Object.assign(base, serviceAnalysis, hookAnalysis);
      const mergedAdapterCalls = [
        ...new Set([...(serviceAnalysis.adapterCalls || []), ...(hookAnalysis.adapterCalls || [])]),
      ];
      if (mergedAdapterCalls.length) base.adapterCalls = mergedAdapterCalls.sort();
      const storeName = extractStoreName(sourceFile);
      if (storeName) base.storeName = storeName;
    }
  }

  /**
   * AST-based analysis — replaces regex for accuracy
   */
  private analyzeWithAST(
    sourceFile: ts.SourceFile,
    content: string,
    componentName: string,
    filePath?: string
  ): ComponentAnalysis {
    const hooks = new Set<string>();
    const stateVariables: string[] = [];
    const childComponents = new Set<string>();
    const eventHandlers = new Set<string>();
    const imports: ImportInfo[] = [];
    const testIds = new Set<string>();
    const formFields: FormFieldInfo[] = [];
    const storeCalls = new Set<string>();
    const methodCalls = new Map<string, Set<string>>();
    let line: number | undefined;
    let exportType: "named" | "default" | "none" = "none";
    let description: string | undefined;

    const filteredJsxNames = new Set([
      "Fragment", "Provider", "Consumer", "Suspense", "StrictMode",
    ]);

    const visit = (node: ts.Node) => {
      // Extract imports
      if (ts.isImportDeclaration(node)) {
        const imp = this.extractImportFromNode(node, filePath);
        if (imp) {
          imports.push(imp);
          // Store hooks imported from a store-ish path (Pinia/Zustand convention).
          if (imp.source.toLowerCase().includes("store")) {
            for (const n of imp.names) {
              if (/^use[A-Z]/.test(n)) storeCalls.add(n);
            }
          }
        }
      }

      // Find component declaration line + export type + JSDoc
      if (ts.isFunctionDeclaration(node) && node.name?.text === componentName) {
        line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        exportType = this.getExportType(node);
        description = this.getJSDocFromNode(node);
      }
      if (ts.isVariableStatement(node)) {
        const decl = node.declarationList.declarations[0];
        if (decl && ts.isIdentifier(decl.name) && decl.name.text === componentName) {
          line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          exportType = this.getExportType(node);
          description = this.getJSDocFromNode(node);
        }
      }

      // Extract hook calls: useXxx(...) or React.useXxx(...)
      if (ts.isCallExpression(node)) {
        const hookName = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : undefined;
        if (hookName && /^use[A-Z]/.test(hookName)) {
          hooks.add(hookName);
          // Store usage: useCartStore(), useUserStore() — Pinia + Zustand convention.
          if (/^use[A-Z]\w*Store$/.test(hookName)) storeCalls.add(hookName);
        }
        // Components call services directly too (someService.method()) —
        // record method-level calls so data-flow tracing can scope the
        // service/adapter endpoint surface to what's actually invoked.
        const methodCall = adapterMethodCallOf(node);
        if (methodCall) addToSetMap(methodCalls, methodCall.callee, methodCall.method);
      }

      // Extract useState destructuring: const [x, setX] = useState(...)
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (
          ts.isCallExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression) &&
          node.initializer.expression.text === "useState" &&
          ts.isArrayBindingPattern(node.name)
        ) {
          const first = node.name.elements[0];
          if (first && ts.isBindingElement(first) && ts.isIdentifier(first.name)) {
            if (first.name.text !== "_") {
              stateVariables.push(first.name.text);
            }
          }
        }

        // Vue: const x = ref(...), reactive({...}), computed(...), shallowRef(...)
        if (
          ts.isCallExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression) &&
          ["ref", "reactive", "computed", "shallowRef", "shallowReactive"].includes(node.initializer.expression.text) &&
          ts.isIdentifier(node.name) &&
          node.name.text !== "_"
        ) {
          stateVariables.push(node.name.text);
        }
      }

      // Extract JSX elements (child components) + form controls
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const { tagName } = node;
        const name = ts.isIdentifier(tagName) ? tagName.text
          : ts.isPropertyAccessExpression(tagName) ? tagName.getText(sourceFile)
          : undefined;
        if (name && /^[A-Z]/.test(name) && !filteredJsxNames.has(name)) {
          childComponents.add(name);
        }
        // Lowercase intrinsic form controls → drivable selectors for capture_flow.
        if (ts.isIdentifier(tagName) && FORM_CONTROL_TAGS.has(tagName.text)) {
          formFields.push(extractJsxFormField(node, tagName.text));
        }
      }

      // Extract JSX event handler attributes: onClick={...}, and data-testid values
      if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name)) {
        const attrName = node.name.text;
        if (/^on[A-Z]/.test(attrName)) {
          eventHandlers.add(attrName);
        }
        if (attrName === "data-testid") {
          const val = getJsxAttrStringValue(node);
          if (val) testIds.add(val);
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    // Detect data fetching pattern
    const hooksArray = Array.from(hooks).sort();
    const dataFetchingPattern = detectDataFetchingPattern(content, hooksArray);

    // Extract accessibility info (keep regex here — it's scanning HTML-like content)
    const accessibility = extractAccessibility(content);

    const analysis: ComponentAnalysis = {
      line,
      exportType,
      description,
      hooks: hooksArray,
      stateVariables: stateVariables.sort(),
      childComponents: Array.from(childComponents).sort(),
      eventHandlers: Array.from(eventHandlers).sort(),
      imports,
      dataFetchingPattern,
      accessibility,
    };

    // Selector signals — omit entirely (not []) when nothing was found.
    const testIdList = Array.from(testIds).sort();
    if (testIdList.length) analysis.testIds = testIdList;

    const dedupedFields = dedupeFormFields(formFields);
    if (dedupedFields.length) analysis.formFields = dedupedFields;

    const storeCallList = Array.from(storeCalls).sort();
    if (storeCallList.length) analysis.storeCalls = storeCallList;

    const methodCallRecord = setMapToRecord(methodCalls);
    if (methodCallRecord) analysis.methodCalls = methodCallRecord;

    return analysis;
  }

  /**
   * Extract import info from an import declaration AST node
   */
  private extractImportFromNode(
    node: ts.ImportDeclaration,
    filePath?: string
  ): ImportInfo | null {
    const moduleSpecifier = node.moduleSpecifier;
    if (!ts.isStringLiteral(moduleSpecifier)) return null;

    const source = moduleSpecifier.text;
    const clause = node.importClause;
    if (!clause) return null;

    const names: string[] = [];
    let type: "named" | "default" | "namespace" = "named";

    // Default import
    if (clause.name) {
      type = "default";
      names.push(clause.name.text);
    }

    // Named / namespace imports
    if (clause.namedBindings) {
      if (ts.isNamedImports(clause.namedBindings)) {
        type = clause.name ? "default" : "named";
        for (const element of clause.namedBindings.elements) {
          names.push(element.name.text);
        }
      } else if (ts.isNamespaceImport(clause.namedBindings)) {
        type = "namespace";
        names.push(clause.namedBindings.name.text);
      }
    }

    if (names.length === 0) return null;

    return {
      type,
      names,
      source,
      resolvedPath: this.resolveImportPath(source, filePath),
    };
  }

  /**
   * Resolve import path using configured aliases
   */
  private resolveImportPath(
    importSource: string,
    filePath?: string
  ): string | undefined {
    if (this.config?.aliases) {
      for (const [alias, target] of Object.entries(this.config.aliases)) {
        if (importSource.startsWith(alias)) {
          return target + importSource.slice(alias.length);
        }
      }
    }
    // Default @/ alias
    if (importSource.startsWith("@/")) {
      return `src/${importSource.slice(2)}`;
    }
    if (!importSource.startsWith(".")) {
      return undefined;
    }
    // Relative import: resolve against the importing file so consumers can key
    // importers by target file path (e.g. "../composables/useTokenRefreshTimer"
    // from src/adapters/apiClient.ts -> "src/composables/useTokenRefreshTimer").
    if (filePath && this.workspaceRoot) {
      const abs = path.resolve(path.dirname(filePath), importSource);
      const rel = path.relative(this.workspaceRoot, abs);
      if (!rel.startsWith("..")) {
        return rel.split(path.sep).join("/");
      }
    }
    return importSource;
  }

  /**
   * Get export type from a node
   */
  private getExportType(node: ts.Node): "named" | "default" | "none" {
    if (!ts.canHaveModifiers(node)) return "none";
    const modifiers = ts.getModifiers(node);
    if (!modifiers) return "none";

    const hasExport = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const hasDefault = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

    if (hasExport && hasDefault) return "default";
    if (hasExport) return "named";
    return "none";
  }

  /**
   * Extract JSDoc comment from a node using TS API
   */
  private getJSDocFromNode(node: ts.Node): string | undefined {
    const jsDocs = (node as any).jsDoc as ts.JSDoc[] | undefined;
    if (!jsDocs || jsDocs.length === 0) return undefined;

    const comment = jsDocs[0].comment;
    if (typeof comment === "string") return comment;
    if (Array.isArray(comment)) {
      return comment.map((c: any) => (typeof c === "string" ? c : c.text || "")).join("");
    }
    return undefined;
  }

  // Keep extractImports as a public method for backward compatibility
  extractImports(content: string, filePath?: string): ImportInfo[] {
    const sourceFile = ts.createSourceFile(
      filePath || "temp.ts",
      content,
      ts.ScriptTarget.Latest,
      true
    );

    const imports: ImportInfo[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node)) {
        const imp = this.extractImportFromNode(node, filePath);
        if (imp) imports.push(imp);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return imports;
  }
}
