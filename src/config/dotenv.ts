import path from "path";
import { readFileSync } from "node:fs";

/**
 * Populate process.env from the workspace's .env so `${ENV_VAR}` references in
 * `.atlas-ui.json` (e.g. browser.login credentials) resolve without inlining
 * secrets anywhere git-tracked. Secrets stay solely in the (gitignored) .env;
 * the committed config only names the vars. Existing env vars are never
 * overridden, and a missing/unreadable .env is a no-op.
 */
export function loadWorkspaceDotEnv(workspaceRoot: string): void {
  let raw: string;
  try {
    raw = readFileSync(path.join(workspaceRoot, ".env"), "utf-8");
  } catch {
    return; // no .env — nothing to load
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const withoutExport = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length)
      : trimmed;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!key || key in process.env) continue; // never override a real env var
    let value = withoutExport.slice(eq + 1).trim();
    // Strip a single layer of matching surrounding quotes; leave the rest of the
    // value intact so credentials containing #, =, etc. are preserved verbatim.
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
