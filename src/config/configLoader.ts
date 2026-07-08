import fs from "fs/promises";
import path from "path";
import type { ProjectConfig, ScanTarget } from "../types.js";
import { readPackageDeps } from "../util.js";

const CONFIG_FILENAME = ".atlas-ui.json";

type Framework = "react" | "vue" | "both";

const REACT_SCAN_TARGETS: ScanTarget[] = [
  { dir: "src/components", extensions: [".tsx"], type: "component" },
  { dir: "src/pages", extensions: [".tsx"], type: "page" },
  { dir: "src/hooks", extensions: [".ts", ".tsx"], type: "hook" },
  { dir: "src/services", extensions: [".ts"], type: "service" },
  { dir: "src/adapters", extensions: [".ts"], type: "adapter" },
  { dir: "src/contexts", extensions: [".tsx"], type: "context" },
  { dir: "src/stores", extensions: [".ts"], type: "store" },
  { dir: "src/store", extensions: [".ts"], type: "store" },
];

const VUE_SCAN_TARGETS: ScanTarget[] = [
  // Vue SFCs plus colocated .ts/.tsx (composables/helpers next to components,
  // classified by name — e.g. use*.ts under src/components resolves as a hook).
  { dir: "src/components", extensions: [".vue", ".ts", ".tsx"], type: "component" },
  { dir: "src/views", extensions: [".vue"], type: "page" },
  { dir: "src/pages", extensions: [".vue"], type: "page" },
  { dir: "src/composables", extensions: [".ts"], type: "hook" },
  { dir: "src/services", extensions: [".ts"], type: "service" },
  { dir: "src/adapters", extensions: [".ts"], type: "adapter" },
  { dir: "src/stores", extensions: [".ts"], type: "store" },
  { dir: "src/store", extensions: [".ts"], type: "store" },
  // Non-visual layers — kept as graph nodes so impact analysis can trace
  // through them. Missing dirs are simply skipped, so these are safe defaults.
  { dir: "src/dto", extensions: [".ts"], type: "dto" },
  { dir: "src/types", extensions: [".ts"], type: "type" },
  { dir: "src/utils", extensions: [".ts"], type: "util" },
  { dir: "src/auth", extensions: [".ts"], type: "util" },
];

const REACT_ROUTE_FILES = ["src/App.tsx"];
const VUE_ROUTE_FILES = ["src/router/index.ts", "src/router/index.js"];

/**
 * Detect the framework used in the workspace by checking package.json dependencies
 */
async function detectFramework(workspaceRoot: string): Promise<Framework> {
  const deps = await readPackageDeps(workspaceRoot);
  const hasReact = "react" in deps;
  const hasVue = "vue" in deps;

  if (hasReact && hasVue) return "both";
  if (hasVue) return "vue";
  return "react";
}

/**
 * Build default scan targets based on detected framework
 */
const DEFAULT_BROWSER: ProjectConfig["browser"] = {
  devServerUrl: "http://localhost:5173",
  headless: true,
  viewport: { width: 1280, height: 800 },
  outputDir: ".atlas-ui/captures",
  routeParams: {},
};

function buildDefaults(framework: Framework): ProjectConfig {
  const exclude = ["node_modules", "dist", "build", "__tests__", "*.test.*", "*.spec.*"];
  const aliases: Record<string, string> = { "@/": "src/" };
  const browser = DEFAULT_BROWSER;

  if (framework === "vue") {
    return {
      scanTargets: VUE_SCAN_TARGETS,
      routeFiles: VUE_ROUTE_FILES,
      aliases,
      exclude,
      browser,
    };
  }

  if (framework === "both") {
    // Merge: use both extensions where directories overlap, include framework-specific dirs
    const scanTargets: ScanTarget[] = [
      { dir: "src/components", extensions: [".tsx", ".vue"], type: "component" },
      { dir: "src/pages", extensions: [".tsx", ".vue"], type: "page" },
      { dir: "src/views", extensions: [".vue"], type: "page" },
      { dir: "src/hooks", extensions: [".ts", ".tsx"], type: "hook" },
      { dir: "src/composables", extensions: [".ts"], type: "hook" },
      { dir: "src/services", extensions: [".ts"], type: "service" },
      { dir: "src/adapters", extensions: [".ts"], type: "adapter" },
      { dir: "src/contexts", extensions: [".tsx"], type: "context" },
      { dir: "src/stores", extensions: [".ts"], type: "store" },
      { dir: "src/store", extensions: [".ts"], type: "store" },
    ];
    return {
      scanTargets,
      routeFiles: [...REACT_ROUTE_FILES, ...VUE_ROUTE_FILES],
      aliases,
      exclude,
      browser,
    };
  }

  // React (default)
  return {
    scanTargets: REACT_SCAN_TARGETS,
    routeFiles: REACT_ROUTE_FILES,
    aliases,
    exclude,
    browser,
  };
}

/**
 * Load project configuration from .atlas-ui.json
 * Falls back to auto-detected framework defaults if file doesn't exist
 */
export async function loadConfig(workspaceRoot: string): Promise<ProjectConfig> {
  const configPath = path.join(workspaceRoot, CONFIG_FILENAME);
  const framework = await detectFramework(workspaceRoot);
  const defaults = buildDefaults(framework);

  try {
    const content = await fs.readFile(configPath, "utf-8");
    const userConfig: ProjectConfig = JSON.parse(content);

    // Merge with detected defaults
    return {
      scanTargets: userConfig.scanTargets || defaults.scanTargets,
      routeFiles: userConfig.routeFiles || defaults.routeFiles,
      aliases: { ...defaults.aliases, ...userConfig.aliases },
      exclude: userConfig.exclude || defaults.exclude,
      phiCompliance: {
        ...defaults.phiCompliance,
        ...userConfig.phiCompliance,
      },
      browser: {
        ...defaults.browser,
        ...userConfig.browser,
        viewport: userConfig.browser?.viewport || defaults.browser?.viewport,
        routeParams: { ...defaults.browser?.routeParams, ...userConfig.browser?.routeParams },
      },
      templatePatterns: userConfig.templatePatterns,
    };
  } catch {
    return defaults;
  }
}

export { REACT_SCAN_TARGETS as DEFAULT_SCAN_TARGETS };
