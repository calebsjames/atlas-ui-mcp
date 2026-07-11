import fs from "fs/promises";
import path from "path";
import ts from "typescript";
import { ComponentAnalyzer } from "../analyzer/componentAnalyzer.js";
import { analyzeModuleExports } from "../analyzer/exportAnalyzer.js";
import type {
  Component,
  ComponentCatalog,
  ScanTarget,
  ArchitectureLayer,
  ProjectConfig,
} from "../types.js";
import { DEFAULT_SCAN_TARGETS } from "../config/configLoader.js";
import { computeCoverageWarning } from "./coverage.js";
import { matchesExclude } from "../util.js";

/**
 * Component Scanner
 * Recursively scans multiple directories and builds a catalog of all
 * React components, pages, hooks, services, adapters, and contexts
 */
export class ComponentScanner {
  private workspaceRoot: string;
  private scanTargets: ScanTarget[];
  private analyzer: ComponentAnalyzer;
  private excludePatterns: string[];
  private routeFiles: string[];

  constructor(workspaceRoot: string, config?: ProjectConfig) {
    this.workspaceRoot = workspaceRoot;
    this.scanTargets = config?.scanTargets || DEFAULT_SCAN_TARGETS;
    this.analyzer = new ComponentAnalyzer(config, workspaceRoot);
    this.excludePatterns = config?.exclude || [
      "node_modules", "dist", "build", "__tests__", "*.test.*", "*.spec.*",
    ];
    this.routeFiles = config?.routeFiles || [];
  }

  /**
   * App entry/root files scanned in addition to the configured targets. They
   * live outside every scanTarget directory but host app-global UI (modals,
   * toast hosts, panels), so without them anything mounted only from the root
   * has invisible upstream edges and its impact is silently under-reported.
   */
  private static ROOT_ENTRY_FILES = [
    "src/App.vue",
    "src/App.tsx",
    "src/App.jsx",
    "src/main.ts",
    "src/main.tsx",
    "src/main.js",
    "src/main.jsx",
  ];

  /**
   * Scan all targets and build catalog
   */
  async scan(): Promise<ComponentCatalog> {
    const allComponents: Component[] = [];

    for (const target of this.scanTargets) {
      const targetDir = path.join(this.workspaceRoot, target.dir);
      try {
        await fs.access(targetDir);
        const components = await this.scanDirectory(
          targetDir,
          target,
          undefined
        );
        allComponents.push(...components);
      } catch {
        // Directory doesn't exist, skip
      }
    }

    allComponents.push(...(await this.scanRootEntryFiles(allComponents)));

    // Organize by category
    const categories: Record<string, Component[]> = {};
    for (const component of allComponents) {
      if (!categories[component.category]) {
        categories[component.category] = [];
      }
      categories[component.category].push(component);
    }

    // Sort each category alphabetically (case-insensitive)
    for (const category in categories) {
      categories[category].sort((a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase())
      );
    }

    const coverageWarning = await computeCoverageWarning({
      workspaceRoot: this.workspaceRoot,
      scanTargets: this.scanTargets,
      excludePatterns: this.excludePatterns,
      extraCoveredFiles: [...ComponentScanner.ROOT_ENTRY_FILES, ...this.routeFiles],
      scannedUiFileCount: allComponents.filter((c) =>
        /\.(tsx|jsx|vue)$/.test(c.relativePath)
      ).length,
    });

    return {
      components: allComponents,
      categories,
      totalCount: allComponents.length,
      lastScanned: Date.now(),
      ...(coverageWarning ? { coverageWarning } : {}),
    };
  }

  /**
   * Recursively scan directory for matching files
   */
  private async scanDirectory(
    dir: string,
    target: ScanTarget,
    parentCategory?: string
  ): Promise<Component[]> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      console.error(`Error scanning directory ${dir}:`, error);
      return [];
    }

    const components: Component[] = [];

    for (const entry of entries) {
      if (this.isExcluded(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        const category = this.determineCategory(fullPath, target);
        const subComponents = await this.scanDirectory(fullPath, target, category);
        components.push(...subComponents);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!target.extensions.some((ext) => entry.name.endsWith(ext))) continue;

      let content: string;
      try {
        content = await fs.readFile(fullPath, "utf-8");
      } catch {
        continue;
      }

      const stats = await fs.stat(fullPath);
      const category = parentCategory || this.determineCategory(fullPath, target);
      const relativePath = path.relative(this.workspaceRoot, fullPath);
      const fileBaseName = entry.name.replace(/\.(vue|tsx?|jsx?)$/, "");
      const { name: componentName, exportedNames } = this.resolveComponentName(
        content, fileBaseName, entry.name, target.type
      );

      // Classify by content, not just directory: a use*-named .ts module living
      // under a components/ tree is a composable/hook, not a component.
      let layer: ArchitectureLayer = target.type;
      if (
        layer === "component" &&
        /\.(ts|js)$/.test(entry.name) &&
        /^use[A-Z0-9]/.test(componentName)
      ) {
        layer = "hook";
      }

      const analysis = await this.analyzer.analyzeComponent(fullPath, componentName, layer);

      const component: Component = {
        name: componentName,
        path: fullPath,
        relativePath,
        category,
        architectureLayer: layer,
        lastModified: stats.mtimeMs,
        ...analysis,
      };

      // Track filename alias when defineComponent name differs from filename
      if (componentName !== fileBaseName && fileBaseName !== componentName) {
        (component as any).fileAlias = fileBaseName;
      }
      if (exportedNames.length > 0) component.exportedNames = exportedNames;

      components.push(component);
    }

    return components;
  }

  /**
   * Scan the well-known root/entry files (App.*, main.*) into the catalog as
   * layer "root" nodes, skipping any already covered by a configured target.
   */
  private async scanRootEntryFiles(existing: Component[]): Promise<Component[]> {
    const seen = new Set(
      existing.map((c) => c.relativePath.split(path.sep).join("/"))
    );
    const rootComponents: Component[] = [];

    for (const rel of ComponentScanner.ROOT_ENTRY_FILES) {
      if (seen.has(rel)) continue;
      const fullPath = path.join(this.workspaceRoot, rel);

      let content: string;
      let stats;
      try {
        content = await fs.readFile(fullPath, "utf-8");
        stats = await fs.stat(fullPath);
      } catch {
        continue; // File doesn't exist in this project
      }

      const fileBaseName = path.basename(rel).replace(/\.(vue|tsx?|jsx?)$/, "");
      const { name: componentName, exportedNames } = this.resolveComponentName(
        content, fileBaseName, path.basename(rel), "root"
      );
      const analysis = await this.analyzer.analyzeComponent(fullPath, componentName, "root");

      const component: Component = {
        name: componentName,
        path: fullPath,
        relativePath: path.relative(this.workspaceRoot, fullPath),
        category: "root",
        architectureLayer: "root",
        lastModified: stats.mtimeMs,
        ...analysis,
      };
      if (componentName !== fileBaseName) {
        component.fileAlias = fileBaseName;
      }
      if (exportedNames.length > 0) component.exportedNames = exportedNames;
      rootComponents.push(component);
    }

    return rootComponents;
  }

  /**
   * Check if a filename matches any exclude pattern
   */
  private isExcluded(name: string): boolean {
    return matchesExclude(name, this.excludePatterns);
  }

  /**
   * Resolve the catalog name for a file. TS/JS modules go through the AST
   * resolver (handles `export {X}`, `export default Ident`, destructured
   * exports, and prefers the default export). Vue SFCs stay on the regex path —
   * their mixed template/script blocks don't parse as a TS module. Falls back to
   * the regex extractor, then the filename.
   */
  private resolveComponentName(
    content: string,
    fileBaseName: string,
    fileName: string,
    layerHint: string
  ): { name: string; exportedNames: string[] } {
    if (!fileName.endsWith(".vue")) {
      try {
        const sf = ts.createSourceFile(
          fileName, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX
        );
        const { primary, names } = analyzeModuleExports(sf, fileBaseName, layerHint);
        if (primary) return { name: primary, exportedNames: names };
      } catch {
        // Unparseable — fall through to the regex extractor.
      }
    }
    return { name: this.extractExportedName(content, fileBaseName) || fileBaseName, exportedNames: [] };
  }

  /**
   * Extract the actual exported symbol name from file content.
   */
  private static EXPORT_PATTERNS: RegExp[] = [
    /export\s+(?:default\s+)?function\s+([A-Z][A-Za-z0-9]*)\b/,
    /export\s+(?:default\s+)?const\s+([A-Z][A-Za-z0-9]*)\s*[=:]/,
    /export\s+default\s+class\s+([A-Z][A-Za-z0-9]*)\b/,
    /export\s+(?:default\s+)?function\s+(use[A-Z][A-Za-z0-9]*)\b/,
    /export\s+const\s+(use[A-Z][A-Za-z0-9]*)\s*[=:]/,
    /export\s+class\s+([A-Za-z][A-Za-z0-9]*)\b/,
    /export\s+(?:async\s+)?function\s+([a-zA-Z][A-Za-z0-9]*)\b/,
  ];

  private extractExportedName(
    content: string,
    fileBaseName: string
  ): string | null {
    for (const pattern of ComponentScanner.EXPORT_PATTERNS) {
      const match = content.match(pattern);
      if (match) return match[1];
    }

    // Vue: defineComponent({ name: "ComponentName" })
    const defineComponentName = content.match(
      /defineComponent\(\s*\{[^}]*name:\s*["']([A-Za-z][A-Za-z0-9]*)["']/
    );
    if (defineComponentName) return defineComponentName[1];

    return null;
  }

  /**
   * Determine component category based on file path and scan target
   */
  private determineCategory(filePath: string, target: ScanTarget): string {
    const targetDir = path.join(this.workspaceRoot, target.dir);
    const relativePath = path.relative(targetDir, filePath);
    const parts = relativePath.split(path.sep);

    if (target.type === "component") {
      if (parts[0] === "ui") return "ui-primitives";
      if (parts.length > 1) return this.toCategoryName(parts[0]);
      return "root";
    }

    if (parts.length > 1) {
      return `${target.type}:${this.toCategoryName(parts[0])}`;
    }

    return target.type;
  }

  /**
   * Convert directory name to category name (PascalCase to kebab-case)
   */
  private toCategoryName(dirName: string): string {
    return dirName
      .replace(/([A-Z])/g, "-$1")
      .toLowerCase()
      .replace(/^-/, "");
  }

  /**
   * Watch for file changes across all scan targets and invalidate cache
   */
  async watch(onChange: () => void): Promise<() => void> {
    const stopFunctions: (() => void)[] = [];

    // Watch the root entry files (App.*, main.*) — they live outside every
    // scanTarget directory, so without this a root-only edit leaves the
    // catalog stale.
    try {
      const srcDir = path.join(this.workspaceRoot, "src");
      await fs.access(srcDir);
      const rootWatcher = fs.watch(srcDir, { recursive: false });
      let rootStopped = false;
      (async () => {
        try {
          for await (const event of rootWatcher) {
            if (rootStopped) break;
            if (event.filename && /^(App|main)\.(vue|tsx?|jsx?)$/.test(event.filename)) {
              onChange();
            }
          }
        } catch (error) {
          if (!rootStopped) {
            console.error("File watcher error for src root files:", error);
          }
        }
      })();
      stopFunctions.push(() => {
        rootStopped = true;
        (rootWatcher as unknown as { close?: () => void }).close?.();
      });
    } catch {
      // src/ doesn't exist, skip
    }

    for (const target of this.scanTargets) {
      const targetDir = path.join(this.workspaceRoot, target.dir);
      try {
        await fs.access(targetDir);
        const watcher = fs.watch(targetDir, { recursive: true });
        let stopped = false;

        (async () => {
          try {
            for await (const event of watcher) {
              if (stopped) break;
              if (
                event.filename &&
                target.extensions.some((ext) =>
                  event.filename!.endsWith(ext)
                )
              ) {
                onChange();
              }
            }
          } catch (error) {
            if (!stopped) {
              console.error(
                `File watcher error for ${target.dir}:`,
                error
              );
            }
          }
        })();

        stopFunctions.push(() => {
          stopped = true;
          (watcher as unknown as { close?: () => void }).close?.();
        });
      } catch {
        // Directory doesn't exist, skip watcher
      }
    }

    return () => {
      for (const stop of stopFunctions) {
        stop();
      }
    };
  }
}
