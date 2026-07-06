import fs from "fs/promises";
import path from "path";
import type { ProjectConfig } from "../types.js";

/**
 * Well-known entry points that wire the app together but almost never live
 * inside a scan target (they're not "components" in the catalog sense). If we
 * ignore them, anything they import/render — App shells, top-level pages,
 * providers — looks unreferenced and can be misreported as dead code. This is
 * the flat, curated list of those files; missing ones are silently skipped.
 */
const WELL_KNOWN_ENTRY_POINTS: string[] = [
  "src/main.tsx",
  "src/main.ts",
  "src/main.jsx",
  "src/main.js",
  "src/index.tsx",
  "src/index.ts",
  "src/App.tsx",
  "src/App.jsx",
  "src/App.vue",
  "src/app.tsx",
  "app/layout.tsx",
  "src/app/layout.tsx",
];

/**
 * Read the contents of files that sit OUTSIDE the scan targets but still
 * reference cataloged code: configured route files plus the well-known entry
 * points above. Usage and dead-code analysis merge these in so a component
 * that's only imported from App.tsx/main.tsx isn't flagged dead.
 *
 * Returns a map of workspace-relative path → file content. Files that don't
 * exist are ignored (the list is intentionally broad and cross-framework).
 */
export async function loadReferenceContents(
  workspaceRoot: string,
  config?: ProjectConfig
): Promise<Map<string, string>> {
  const relativePaths = new Set<string>();
  for (const routeFile of config?.routeFiles || []) relativePaths.add(routeFile);
  for (const entry of WELL_KNOWN_ENTRY_POINTS) relativePaths.add(entry);

  const contents = new Map<string, string>();
  await Promise.all(
    [...relativePaths].map(async (relativePath) => {
      try {
        const content = await fs.readFile(
          path.resolve(workspaceRoot, relativePath),
          "utf-8"
        );
        contents.set(relativePath, content);
      } catch {
        /* file doesn't exist in this project — skip */
      }
    })
  );

  return contents;
}
