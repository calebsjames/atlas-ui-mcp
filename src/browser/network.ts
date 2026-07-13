/**
 * Network-request classification and JSON-body summarization for the runtime
 * browser tools. Both live below the framework layer — this is raw HTTP, so it
 * behaves identically for Vue and React apps.
 */

/**
 * Classify a network entry as one of the app's own API calls — an xhr/fetch
 * request, or any URL under `/api/`. Static assets, documents, and the HTML
 * navigation itself are excluded. Shared by the response-body summarizer and
 * the per-step API-call reporters so "what counts as an API call" is defined
 * in exactly one place.
 */
export function isApiRequest(e: { resourceType: string; url: string }): boolean {
  return e.resourceType === "xhr" || e.resourceType === "fetch" || /\/api\//.test(e.url);
}

/** Structural summary of a JSON response body — never its contents. */
export interface BodySummary {
  /** Number of rows in the primary collection. */
  rowCount?: number;
  /**
   * Where `rowCount` came from: "$" (top-level array) or the JSON key path
   * (e.g. "data" / "data.items"). Always reported so a caller can tell when
   * the heuristic counted the wrong collection.
   */
  rowsFrom?: string;
  /**
   * Server-reported total (pagination) when present. Differs from `rowCount`
   * on a paged response — the page holds N rows out of `totalCount`.
   */
  totalCount?: number;
}

// Well-known collection wrappers across REST / GraphQL / Spring / Django / etc.
// Array order = precedence when a body carries more than one.
const ENVELOPE_KEYS = ["data", "results", "items", "rows", "records", "content", "nodes", "edges", "list"];
// Object wrappers to unwrap one level: { data: { items: [...] } }.
const WRAPPER_KEYS = ["data", "result", "response", "payload"];
// Conventional pagination totals.
const TOTAL_KEYS = ["total", "totalCount", "totalElements", "totalItems", "count"];

/** Parse a JSON body buffer and summarize it. Returns null on non-JSON or no signal. */
export function summarizeJsonBody(buf: Buffer): BodySummary | null {
  let json: unknown;
  try {
    json = JSON.parse(buf.toString("utf-8"));
  } catch {
    return null;
  }
  return summarizeJson(json);
}

/**
 * Reduce a parsed JSON value to a row-count summary WITHOUT hardcoding any
 * app-specific field name: a top-level array counts directly; an object is
 * counted via a well-known envelope key (data/results/items/…) or its sole
 * array-valued property, with a single-level unwrap of a `data`/`result`
 * object wrapper. `rowsFrom` always names the counted key so a caller can
 * see — and second-guess — the choice.
 */
export function summarizeJson(json: unknown, prefix = "", depth = 0): BodySummary | null {
  if (Array.isArray(json)) return { rowCount: json.length, rowsFrom: prefix || "$" };
  if (!json || typeof json !== "object") return null;

  const obj = json as Record<string, unknown>;
  const summary: BodySummary = {};

  for (const k of TOTAL_KEYS) {
    if (typeof obj[k] === "number") {
      summary.totalCount = obj[k] as number;
      break;
    }
  }

  let arrKey = ENVELOPE_KEYS.find((k) => Array.isArray(obj[k]));
  if (!arrKey) {
    const arrays = Object.keys(obj).filter((k) => Array.isArray(obj[k]));
    if (arrays.length === 1) arrKey = arrays[0];
  }
  if (arrKey) {
    summary.rowCount = (obj[arrKey] as unknown[]).length;
    summary.rowsFrom = joinKey(prefix, arrKey);
    return summary;
  }

  // No array at this level — unwrap one known object wrapper and try again,
  // carrying up a total we already found (e.g. { total, data: { items:[…] } }).
  if (depth < 1) {
    for (const k of WRAPPER_KEYS) {
      const inner = obj[k];
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        const nested = summarizeJson(inner, joinKey(prefix, k), depth + 1);
        if (nested) {
          if (nested.totalCount == null && summary.totalCount != null) {
            nested.totalCount = summary.totalCount;
          }
          return nested;
        }
      }
    }
  }

  return summary.totalCount != null ? summary : null;
}

function joinKey(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}
