import fs from "fs/promises";
import path from "path";
import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { ProjectConfig } from "../types.js";
import { ensureCatalog, escapeRegex } from "./shared.js";
import { loadReferenceContents } from "./referenceFiles.js";

export interface ComponentUsage {
  file: string;
  component: string;
  line: number;
  usageType: "jsx" | "import" | "template";
}

/**
 * Find all components that use (import and render) a specific component.
 * Uses indexed cache for fast initial lookup, then scans files for line numbers.
 */
export async function findComponentUsages(
  args: { name: string },
  scanner: ComponentScanner,
  cache: CacheManager,
  workspaceRoot: string,
  config?: ProjectConfig
): Promise<ComponentUsage[]> {
  const { name } = args;
  const catalog = await ensureCatalog(scanner, cache);

  const usages: ComponentUsage[] = [];
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

  const importers = cache.getImportersOf(name);
  const renderers = cache.getRenderersOf(name);

  const candidateSet = new Map<string, { path: string; relativePath: string; name: string }>();
  for (const comp of [...importers, ...renderers]) {
    if (comp.name.toLowerCase() === name.toLowerCase()) continue;
    candidateSet.set(comp.path, {
      path: comp.path,
      relativePath: comp.relativePath,
      name: comp.name,
    });
  }

  for (const candidate of candidateSet.values()) {
    scanFileForUsages(
      await readFileSafe(candidate.path),
      candidate.relativePath,
      candidate.name,
      jsxRegex,
      importRegex,
      usages
    );
  }

  if (name.startsWith("use")) {
    const hookCallRegex = new RegExp(`\\b${escapedName}\\s*\\(`, "g");

    for (const comp of catalog.components) {
      if (comp.name.toLowerCase() === name.toLowerCase()) continue;
      if (candidateSet.has(comp.path)) continue;
      if (!comp.hooks?.some((h) => h.toLowerCase() === name.toLowerCase())) continue;

      const content = await readFileSafe(comp.path);
      if (!content) continue;

      const lines = content.split("\n");
      for (let idx = 0; idx < lines.length; idx++) {
        hookCallRegex.lastIndex = 0;
        if (!hookCallRegex.test(lines[idx])) continue;
        usages.push({
          file: comp.relativePath,
          component: comp.name,
          line: idx + 1,
          usageType: "import",
        });
      }
    }
  }

  // Entry points and route files (App.tsx, main.tsx, layouts) never enter the
  // catalog, yet they're where top-level components are actually imported and
  // rendered. Scan their raw content with the same patterns so those real
  // usages aren't invisible.
  const referenceFiles = await loadReferenceContents(workspaceRoot, config);
  const hookCallRegex = name.startsWith("use")
    ? new RegExp(`\\b${escapedName}\\s*\\(`, "g")
    : null;
  for (const [relativePath, content] of referenceFiles) {
    const componentName = path.basename(relativePath, path.extname(relativePath));
    scanFileForUsages(content, relativePath, componentName, jsxRegex, importRegex, usages);
    if (hookCallRegex) {
      const lines = content.split("\n");
      for (let idx = 0; idx < lines.length; idx++) {
        hookCallRegex.lastIndex = 0;
        if (!hookCallRegex.test(lines[idx])) continue;
        usages.push({
          file: relativePath,
          component: componentName,
          line: idx + 1,
          usageType: "import",
        });
      }
    }
  }

  const seen = new Set<string>();
  return usages.filter((u) => {
    const key = `${u.file}:${u.line}:${u.usageType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

function scanFileForUsages(
  content: string | null,
  relativePath: string,
  componentName: string,
  jsxRegex: RegExp,
  importRegex: RegExp,
  usages: ComponentUsage[]
): void {
  const isVue = relativePath.endsWith(".vue");
  const templateUsageType = isVue ? "template" : "jsx";

  if (!content) {
    usages.push({
      file: relativePath,
      component: componentName,
      line: 0,
      usageType: templateUsageType,
    });
    return;
  }

  const lines = content.split("\n");
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];

    for (const [regex, type] of [[jsxRegex, templateUsageType], [importRegex, "import"]] as [RegExp, "jsx" | "import" | "template"][]) {
      regex.lastIndex = 0;
      if (!regex.test(line)) continue;
      usages.push({
        file: relativePath,
        component: componentName,
        line: idx + 1,
        usageType: type,
      });
    }
  }
}
