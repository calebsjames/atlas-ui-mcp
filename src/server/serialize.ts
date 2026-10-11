import path from "path";

/**
 * Compact wire format for tool results. Every result used to be
 * pretty-printed (`JSON.stringify(data, null, 2)`) with empty arrays and each
 * node's absolute `path` — about 38% of an average get_component_detail
 * payload. Now: one line, empty arrays dropped below the top level, and an
 * absolute filesystem `path` inside the workspace dropped (every node also
 * carries `relativePath`).
 */

/**
 * Top-level arrays whose emptiness IS the answer ("no usages", "no unexpected
 * calls") — kept even when empty. Everything else drops `[]`.
 */
const KEEP_EMPTY_TOP_LEVEL = new Set([
  "usages", "chains", "allEndpoints", "unexpectedApiCalls", "matchedSample", "affectedItems",
  "affectedRoutes", "changedFiles", "suggestedChecks", "containers", "sections", "suggestions",
  "candidates", "unusedExports", "unusedMethods", "dependsOn", "usedBy", "components", "mounted",
  "unmatched", "findings", "divergences", "steps", "danglingListeners", "mountPath",
]);

export interface SerializeOptions {
  /** Absolute workspace root; string `path` values under it are dropped. */
  workspaceRoot?: string;
}

export function serializeResult(data: unknown, opts: SerializeOptions = {}): string {
  return JSON.stringify(compact(data, 0, opts)) ?? "null";
}

function compact(value: unknown, depth: number, opts: SerializeOptions): unknown {
  if (Array.isArray(value)) return value.map((v) => compact(v, depth + 1, opts));
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    if (key === "path" && typeof v === "string" && isWorkspacePath(v, opts.workspaceRoot)) continue;
    if (Array.isArray(v) && v.length === 0 && !(depth === 0 && KEEP_EMPTY_TOP_LEVEL.has(key))) continue;
    out[key] = compact(v, depth + 1, opts);
  }
  return out;
}

/** An absolute filesystem path inside the workspace (not a URL path like `/api/x`). */
function isWorkspacePath(v: string, root?: string): boolean {
  if (!path.isAbsolute(v)) return false;
  if (root) return v === root || v.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  return false;
}

/**
 * Re-serialize the JSON text items of an MCP content result (browser tools
 * build their own text+image payloads) in the compact format. Non-JSON text is
 * left as is.
 */
export function compactContent<T extends { content: unknown[] }>(result: T, opts: SerializeOptions): T {
  return {
    ...result,
    content: result.content.map((item) => {
      const it = item as { type?: string; text?: string };
      if (it.type !== "text" || typeof it.text !== "string") return item;
      const t = it.text.trimStart();
      if (!t.startsWith("{") && !t.startsWith("[")) return item;
      try {
        return { ...it, text: serializeResult(JSON.parse(it.text), opts) };
      } catch {
        return item;
      }
    }),
  };
}
