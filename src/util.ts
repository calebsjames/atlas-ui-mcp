import fs from "fs/promises";
import path from "path";

/** Small helpers shared across layers (tools, browser, analyzers). */

/** Human-readable message from an unknown thrown value. */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Join a possibly-relative path/URL onto a base URL (absolute URLs pass through). */
export function toAbsoluteUrl(baseUrl: string, raw: string): string {
  if (raw.startsWith("http")) return raw;
  return baseUrl.replace(/\/$/, "") + (raw.startsWith("/") ? raw : `/${raw}`);
}

/** Merged dependencies + devDependencies from the workspace package.json ({} on failure). */
export async function readPackageDeps(workspaceRoot: string): Promise<Record<string, string>> {
  try {
    const content = await fs.readFile(path.join(workspaceRoot, "package.json"), "utf-8");
    const pkg = JSON.parse(content);
    return { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return {};
  }
}

/**
 * Does `name` match any exclude pattern? Patterns with `*` are globs
 * (anchored, `*` = any run of characters); the rest are exact names.
 */
export function matchesExclude(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.includes("*")) {
      const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
      return regex.test(name);
    }
    return name === pattern;
  });
}
