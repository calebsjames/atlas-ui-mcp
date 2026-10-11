import fs from "fs/promises";
import path from "path";
import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { ArchitectureLayer, Component, ProjectConfig, RenderConditions } from "../types.js";
import {
  ensureCatalog,
  escapeRegex,
  nameNotFound,
  type NameSuggestion,
} from "./shared.js";
import { findTemplateMountSites, type TemplateMountSite } from "../analyzer/templateMountSites.js";
import { loadReferenceContents } from "./referenceFiles.js";

export interface ComponentUsage {
  file: string;
  component: string;
  line: number;
  /**
   * - `template` / `jsx` — the symbol is MOUNTED here
   * - `import`  — the import statement that brings it in
   * - `call`    — a call site `name(...)`; how a plain function is actually used
   */
  usageType: "jsx" | "import" | "template" | "call";
  /** Present only on usages inside the module that declares the symbol. */
  scope?: "self-module";
  /** `prop="literal"` bound at this mount site — real values. */
  staticProps?: Record<string, string>;
  /** Valueless attributes (`<Panel embedded />`): Vue passes `""`, Boolean props cast it to true. */
  flagProps?: string[];
  /** `:prop="expr"` — the expression SOURCE. A pointer, not a value. */
  boundProps?: Record<string, string>;
  /** `v-model:prop="expr"` — also expressions, not values. */
  vModelProps?: Record<string, string>;
  /** `v-bind="obj"` — an unknown set of props spread in at this site. */
  spreadProps?: string[];
  /** v-if / v-show / v-for governing this mount site. */
  renderedWhen?: RenderConditions;
}

export interface UsageResolution {
  /**
   * - `indexed`          — the catalog has a node whose own name is the symbol
   * - `indexed-as-export`— the symbol is one of an indexed module's OTHER exports
   * - `not-in-catalog`   — no indexed module declares this name at all
   */
  status: "indexed" | "indexed-as-export" | "not-in-catalog";
  /** Workspace-relative file(s) that declare the symbol, when indexed. */
  declaredIn?: string[];
  architectureLayer?: ArchitectureLayer;
  /** The catalog name of the declaring module, when it differs from the symbol. */
  modulePrimaryName?: string;
  note: string;
}

export interface UsageReport {
  symbol: string;
  resolution: UsageResolution;
  /** Usages outside the declaring module — the impact-analysis number. */
  externalUsageCount: number;
  /** Usages inside the declaring module itself (`scope: "self-module"`). */
  selfModuleUsageCount: number;
  usages: ComponentUsage[];
  /**
   * Other exports of the declaring module and how many files import each.
   * A zero-usage symbol that sits beside a heavily-used sibling is a different
   * fact from a dead one.
   */
  siblingExports?: { name: string; importedByFiles: number }[];
  /** Near-matches, only when the symbol is not in the catalog. */
  suggestions?: NameSuggestion[];
  caveats: string[];
}

interface UsagePatterns {
  jsx: RegExp;
  import: RegExp;
  asyncImport: RegExp;
  stringMount: RegExp;
  /** `name(` — set only for non-PascalCase names (functions, hooks, helpers). */
  call: RegExp | null;
  /** Lines that DECLARE the symbol, so a declaration isn't reported as a call. */
  declaration: RegExp;
}

/** `<component :is="...">` anywhere in the file. Non-global: used only as a test. */
const DYNAMIC_MOUNT_RE = /<component\b[^>]*(?::is|v-bind:is|\bis)\s*=/;

interface Candidate {
  path: string;
  relativePath: string;
  name: string;
  /** This file declares the symbol — its hits are self-module, not impact. */
  isDeclaringModule: boolean;
}

/**
 * Find everywhere a symbol is used — a component mounted in a template/JSX, a
 * composable called, or a plain exported function called.
 *
 * Two root causes shaped this over the previous version:
 *
 *  1. Candidate files came only from "who imports this NAME" plus "who renders
 *     this CHILD". A free function exported from a `dto/` or `utils/` module
 *     that nothing imports by that exact name produced an empty array — and the
 *     empty array was indistinguishable from "this symbol does not exist".
 *     Resolution status is now reported explicitly, and the declaring module is
 *     scanned too, so intra-module call sites are visible.
 *  2. Call sites were only matched for `use*` names, so a plain helper reported
 *     its import line and nothing else. Call matching now covers every
 *     non-PascalCase name.
 *
 * For Vue SFCs the mount sites come from the compiler AST rather than a line
 * regex, which both fixes kebab-case/multi-line tags and carries the props
 * BOUND at each site (see `staticProps` / `boundProps`).
 */
export async function findComponentUsages(
  args: { name: string },
  scanner: ComponentScanner,
  cache: CacheManager,
  workspaceRoot: string,
  config?: ProjectConfig
): Promise<UsageReport> {
  const { name } = args;
  const catalog = await ensureCatalog(scanner, cache);

  const usages: ComponentUsage[] = [];
  const caveats: string[] = [];
  const escapedName = escapeRegex(name);
  // The tag name may sit at end-of-line (multiline templates: `<KitDetailModal`
  // then one attribute per line), and this scan is per-line so there is no
  // trailing `\n` to satisfy a `[\s/>]` class — use a negative lookahead
  // instead, which accepts EOL/attrs/`>`/`/>` while still rejecting
  // `<KitDetailModalSuffix`. Vue templates may also use the kebab-case form;
  // only match it when it contains a hyphen (single-word lowercase names would
  // collide with native HTML tags like <button>).
  const kebabName = name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  const tagNames =
    kebabName.includes("-") && kebabName !== name.toLowerCase()
      ? `(?:${escapedName}|${escapeRegex(kebabName)})`
      : escapedName;
  const jsxRegex = new RegExp(`<${tagNames}(?![\\w-])`, "g");
  // Match any import line containing the name as a word before "from"
  // Handles: import Name from, import Name, { Other } from, import { Name } from
  const importRegex = new RegExp(
    `import\\s+[^;]*\\b${escapedName}\\b[^;]*\\s+from`,
    "g"
  );

  // `const Name = defineAsyncComponent(() => import("..."))` — a genuine import
  // that the static-import pattern above cannot match.
  const asyncImportRegex = new RegExp(
    `\\b${escapedName}\\s*=\\s*defineAsyncComponent\\b`,
    "g"
  );
  // `<component :is="nameFromMap">` mounts by string, so the quoted name is the
  // mount site. Only applied to files that actually contain a dynamic mount.
  const stringMountRegex = new RegExp(`["'\`]${escapedName}["'\`]`, "g");

  // PascalCase names are components; `Name(` in their case would be a factory
  // call, not a usage worth reporting. Everything else — hooks, DTO predicates,
  // utils — is used BY BEING CALLED, which is the usage that matters.
  const callRegex = /^[A-Z]/.test(name)
    ? null
    : new RegExp(`\\b${escapedName}\\s*\\(`, "g");
  const declarationRegex = new RegExp(
    `\\b(?:function|class)\\s+${escapedName}\\b|` +
      `\\b(?:const|let|var)\\s+${escapedName}\\b\\s*[=:]`
  );

  const patterns: UsagePatterns = {
    jsx: jsxRegex,
    import: importRegex,
    asyncImport: asyncImportRegex,
    stringMount: stringMountRegex,
    call: callRegex,
    declaration: declarationRegex,
  };

  // --- Resolve the symbol before looking for usages -------------------------
  const declaringNodes = cache.getByName(name);
  const declaringPaths = new Set(declaringNodes.map((c) => c.path));
  const resolution = describeResolution(name, declaringNodes);

  const candidateSet = new Map<string, Candidate>();
  const addCandidate = (comp: Component, isDeclaringModule: boolean): void => {
    if (candidateSet.has(comp.path)) return;
    candidateSet.set(comp.path, {
      path: comp.path,
      relativePath: comp.relativePath,
      name: comp.name,
      isDeclaringModule,
    });
  };

  for (const comp of [...cache.getImportersOf(name), ...cache.getRenderersOf(name)]) {
    if (declaringPaths.has(comp.path)) continue;
    if (comp.name.toLowerCase() === name.toLowerCase()) continue;
    addCandidate(comp, false);
  }
  // The declaring module itself: sibling exports calling the symbol are real
  // usages, and their absence is what makes "genuinely unused" provable.
  for (const comp of declaringNodes) addCandidate(comp, true);

  for (const candidate of candidateSet.values()) {
    const content = await readFileSafe(candidate.path);
    scanFileForUsages(content, candidate, patterns, name, usages);
  }

  // Hooks are frequently recorded on a component's `hooks` field without the
  // import index catching them (barrel re-exports, auto-imports). Sweep those.
  if (callRegex) {
    for (const comp of catalog.components) {
      if (candidateSet.has(comp.path)) continue;
      if (!comp.hooks?.some((h) => h.toLowerCase() === name.toLowerCase())) continue;

      const content = await readFileSafe(comp.path);
      if (!content) continue;
      scanFileForUsages(
        content,
        { path: comp.path, relativePath: comp.relativePath, name: comp.name, isDeclaringModule: false },
        patterns,
        name,
        usages
      );
    }
  }

  // Entry points and route files (App.tsx, main.tsx, layouts) never enter the
  // catalog, yet they're where top-level components are actually imported and
  // rendered. Scan their raw content with the same patterns so those real
  // usages aren't invisible.
  const referenceFiles = await loadReferenceContents(workspaceRoot, config);
  for (const [relativePath, content] of referenceFiles) {
    const componentName = path.basename(relativePath, path.extname(relativePath));
    scanFileForUsages(
      content,
      { path: relativePath, relativePath, name: componentName, isDeclaringModule: false },
      patterns,
      name,
      usages
    );
  }

  const seen = new Set<string>();
  const deduped = usages.filter((u) => {
    const key = `${u.file}:${u.line}:${u.usageType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const externalUsageCount = deduped.filter((u) => u.scope !== "self-module").length;
  const selfModuleUsageCount = deduped.length - externalUsageCount;

  // --- Honest framing of the result ----------------------------------------
  if (resolution.status === "not-in-catalog") {
    caveats.push(
      `"${name}" is NOT in the catalog — no scanned module declares it. ` +
        (deduped.length
          ? "The usages below are raw text matches in entry/route files only."
          : "An empty usages list therefore means NOT INDEXED, not 'unused'.") +
        " It may live outside .atlas-ui.json scanTargets, come from node_modules, or be misspelled;" +
        " check `suggestions` and confirm with a grep before concluding anything."
    );
  } else if (externalUsageCount === 0) {
    caveats.push(
      `"${name}" IS indexed (declared in ${resolution.declaredIn?.join(", ")}) and has zero usages ` +
        "outside its own module — this is a real 'unused', not a lookup miss. " +
        (selfModuleUsageCount
          ? `${selfModuleUsageCount} call site(s) inside the declaring module are listed with scope "self-module".`
          : "")
    );
  }
  if (resolution.status === "indexed-as-export") {
    caveats.push(
      `The catalog names that file "${resolution.modulePrimaryName}" (one primary name per file); ` +
        `"${name}" is one of its other exports.`
    );
  }
  caveats.push(
    "Static analysis: usages reached through re-export barrels, dynamic property access, or a " +
      "renamed import (`import { a as b }`) are not tracked."
  );
  if (callRegex) {
    caveats.push(
      "`call` usages are line-level regex matches for `name(` with declaration lines excluded; " +
        "a same-named local variable in another scope would still match."
    );
  }
  caveats.push(
    "staticProps are literal VALUES; boundProps/vModelProps are expression SOURCE (a pointer into " +
      "that file's script, NOT a value); flagProps are valueless attributes (Vue passes \"\", a " +
      "Boolean-declared prop casts it to true); spreadProps means an unknown set of props was " +
      "spread in via v-bind. Props are extracted for Vue SFC mount sites only — JSX attributes " +
      "are not parsed."
  );

  const siblingExports = buildSiblingExports(name, declaringNodes, cache);

  return {
    symbol: name,
    resolution,
    externalUsageCount,
    selfModuleUsageCount,
    usages: deduped,
    ...(siblingExports.length ? { siblingExports } : {}),
    ...(resolution.status === "not-in-catalog"
      ? { suggestions: nameNotFound(name, cache).suggestions }
      : {}),
    caveats,
  };
}

/** Where the symbol is declared, and how confident we are that it exists at all. */
function describeResolution(name: string, declaringNodes: Component[]): UsageResolution {
  if (declaringNodes.length === 0) {
    return {
      status: "not-in-catalog",
      note: `No scanned module declares "${name}".`,
    };
  }
  const primary = declaringNodes[0];
  const isOwnName = declaringNodes.some((c) => c.name.toLowerCase() === name.toLowerCase());
  const declaredIn = declaringNodes.map((c) => c.relativePath);

  return {
    status: isOwnName ? "indexed" : "indexed-as-export",
    declaredIn,
    architectureLayer: primary.architectureLayer,
    ...(isOwnName ? {} : { modulePrimaryName: primary.name }),
    note: isOwnName
      ? `Declared in ${declaredIn.join(", ")} (layer "${primary.architectureLayer}").`
      : `A named export of ${declaredIn.join(", ")} (layer "${primary.architectureLayer}"), ` +
        `whose catalog name is "${primary.name}".`,
  };
}

/** Sibling exports of the declaring module(s), with how many files import each. */
function buildSiblingExports(
  name: string,
  declaringNodes: Component[],
  cache: CacheManager
): { name: string; importedByFiles: number }[] {
  const out = new Map<string, number>();
  for (const node of declaringNodes) {
    for (const exported of node.exportedNames || []) {
      if (exported.toLowerCase() === name.toLowerCase()) continue;
      out.set(exported, cache.getImportersOf(exported).length);
    }
  }
  return [...out.entries()]
    .map(([exportName, importedByFiles]) => ({ name: exportName, importedByFiles }))
    .sort((a, b) => b.importedByFiles - a.importedByFiles || a.name.localeCompare(b.name))
    .slice(0, 20);
}

async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/** Project a parsed mount site onto a usage entry, omitting empty fields. */
function withMountProps(usage: ComponentUsage, site: TemplateMountSite): ComponentUsage {
  if (Object.keys(site.staticProps).length) usage.staticProps = site.staticProps;
  if (site.flagProps.length) usage.flagProps = site.flagProps;
  if (Object.keys(site.boundProps).length) usage.boundProps = site.boundProps;
  if (Object.keys(site.vModelProps).length) usage.vModelProps = site.vModelProps;
  if (site.spreadProps.length) usage.spreadProps = site.spreadProps;
  if (site.renderedWhen) usage.renderedWhen = site.renderedWhen;
  return usage;
}

function scanFileForUsages(
  content: string | null,
  candidate: Candidate,
  patterns: UsagePatterns,
  name: string,
  usages: ComponentUsage[]
): void {
  const { relativePath, name: componentName, isDeclaringModule } = candidate;
  const isVue = relativePath.endsWith(".vue");
  const templateUsageType = isVue ? "template" : "jsx";
  const scope = isDeclaringModule ? ({ scope: "self-module" } as const) : {};

  if (!content) {
    // An unreadable IMPORTER is still evidence of a usage (line 0 = "we know it
    // uses this, we can't say where"). An unreadable DECLARING module is not —
    // that file is the definition, so a placeholder there would invent a usage.
    if (!isDeclaringModule) {
      usages.push({
        file: relativePath,
        component: componentName,
        line: 0,
        usageType: templateUsageType,
      });
    }
    return;
  }

  // Vue: take mount sites from the compiler AST. It sees kebab-case tags and
  // attributes split across lines, ignores commented-out markup, and — the
  // point of defect 3 — carries the props bound at each site.
  const mountSites = isVue ? findTemplateMountSites(content, name) : undefined;
  if (mountSites) {
    for (const site of mountSites) {
      usages.push(
        withMountProps(
          {
            file: relativePath,
            component: componentName,
            line: site.line,
            usageType: "template",
            ...scope,
          },
          site
        )
      );
    }
  }

  const pairs: [RegExp, ComponentUsage["usageType"]][] = [
    [patterns.import, "import"],
    [patterns.asyncImport, "import"],
  ];
  // The tag regex stays in play only when the AST pass could not run (no
  // parseable <template>, or a non-Vue file) — otherwise it would re-report
  // the same sites without props and resurrect the commented-out-markup bug.
  if (!mountSites) pairs.push([patterns.jsx, templateUsageType]);
  // A bare quoted name is only a mount when the file dynamically mounts something.
  if (DYNAMIC_MOUNT_RE.test(content)) {
    pairs.push([patterns.stringMount, templateUsageType]);
  }

  const lines = content.split("\n");
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];

    for (const [regex, type] of pairs) {
      regex.lastIndex = 0;
      if (!regex.test(line)) continue;
      usages.push({
        file: relativePath,
        component: componentName,
        line: idx + 1,
        usageType: type,
        ...scope,
      });
    }

    if (patterns.call) {
      patterns.call.lastIndex = 0;
      if (patterns.call.test(line) && !patterns.declaration.test(line)) {
        usages.push({
          file: relativePath,
          component: componentName,
          line: idx + 1,
          usageType: "call",
          ...scope,
        });
      }
    }
  }
}
