/**
 * Opt-in response bodies (`captureBodies`). `apiCalls` reports status, bytes
 * and a row count, never the body — so an agent that needs a stub shaped like
 * the real response plus a new field had to guess the shape. A call may name
 * path patterns (the same forms `mockApi` paths take); a matching API call's
 * entry then carries its response body: parsed JSON, else text.
 *
 * Bodies can hold personal data and are large, so this is never on by default
 * and every body is bounded: a per-body cap, a per-call total, and a cap on
 * how many bodies one call captures. A JSON body over the cap is shortened
 * structurally (long arrays keep their first rows, long strings their head),
 * so what is returned is still valid JSON with the real shape; secret-looking
 * values are replaced, not returned.
 */
import type { BodyCaptureReport, CapturedBody, NetworkEntry } from "./types.js";
import { isApiRequest } from "./network.js";
import { compilePath, methodMatches, nearMissesFor, pathMatches, queryMatches, type CompiledPath } from "./mockApi.js";

/** Largest body one entry carries, in characters of its JSON / text. */
export const MAX_BODY_CHARS = 16_000;
/** Largest total across every body one call returns. */
export const MAX_CALL_BODY_CHARS = 48_000;
/** Most distinct bodies one call captures. */
export const MAX_BODIES_PER_CALL = 20;
/** A response larger than this is not read at all. */
export const MAX_BODY_READ_BYTES = 5_000_000;
/** Below this much remaining budget a body is omitted rather than shortened to nothing. */
const MIN_USEFUL_CHARS = 500;

const METHOD_PREFIX = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY|\*)\s+(?=\S)/i;
const BINARY_TYPE = /^(image|audio|video|font)\/|octet-stream|application\/(pdf|zip|gzip|x-protobuf|protobuf|wasm)/i;
/** Keys whose string values are credentials, not shape. */
const SECRET_KEY = /password|passwd|passphrase|secret|token|authorization|api[-_]?key|cookie|credential|private[-_]?key|session[-_]?id|^otp$|^pin$/i;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const REDACTED = "[redacted]";

export interface CompiledBodyPattern extends CompiledPath {
  /** Upper-case method, or "*" (the default: any method). */
  method: string;
  /** The pattern as the caller wrote it. */
  raw: string;
}

/**
 * Validate and compile `captureBodies`: an array of path patterns, each
 * optionally prefixed with a method ("POST /orders"). Throws one message
 * naming every problem before any browser work starts.
 */
export function compileBodyPatterns(raw: unknown): CompiledBodyPattern[] {
  const example = 'e.g. ["/orders/catalog", "**/orders/*", "POST /orders"]';
  if (!Array.isArray(raw)) {
    throw new Error(`captureBodies must be an array of path patterns, ${example}.`);
  }
  const problems: string[] = [];
  const out: CompiledBodyPattern[] = [];
  raw.forEach((p, i) => {
    const where = `captureBodies[${i}]`;
    if (typeof p !== "string" || !p.trim()) {
      problems.push(`${where} must be a path pattern (string).`);
      return;
    }
    let rest = p.trim();
    let method = "*";
    const m = METHOD_PREFIX.exec(rest);
    if (m) {
      method = m[1].toUpperCase() === "ANY" ? "*" : m[1].toUpperCase();
      rest = rest.slice(m[0].length);
    }
    try {
      out.push({ ...compilePath(rest, {}), method, raw: p });
    } catch (err) {
      problems.push(`${where}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  if (problems.length) {
    throw new Error(
      `Invalid captureBodies — ${problems.join(" ")} Each entry is a URL pathname as apiCalls shows it ` +
        `(exact, "*" / "**" glob, "re:" regex, or a full URL), optionally prefixed with a method, ${example}.`
    );
  }
  return out;
}

/**
 * One call's body capture: decides which responses to read, shortens and
 * budgets what it keeps, and reports what each pattern matched.
 */
export class BodyCapture {
  private readonly hits: number[];
  private used = 0;
  private captured = 0;
  /** The last body kept per method + URL, so an identical repeat (a poll) is not charged twice. */
  private readonly last = new Map<string, { raw: string; body: CapturedBody }>();
  constructor(private readonly patterns: CompiledBodyPattern[]) {
    this.hits = patterns.map(() => 0);
  }

  /** Does some pattern ask for this request's response body? (API calls only, like `mockApi`.) */
  wants(entry: { url: string; method: string; resourceType: string }): boolean {
    if (!isApiRequest(entry)) return false;
    let url: URL;
    try {
      url = new URL(entry.url);
    } catch {
      return false;
    }
    const i = this.patterns.findIndex((p) => methodMatches(p, entry.method) && pathMatches(p, url) && queryMatches(p, url));
    if (i < 0) return false;
    this.hits[i]++;
    return true;
  }

  /** Mark a wanted body as not captured, and why. */
  omit(entry: NetworkEntry, reason: string): void {
    entry.responseBody = { omitted: reason };
  }

  /** Attach the (shortened, redacted) body of a wanted response to its entry. */
  record(entry: NetworkEntry, buf: Buffer, contentType: string): void {
    const type = contentType.split(";")[0].trim().toLowerCase();
    if (buf.length === 0) return this.omit(entry, `empty response body${entry.status != null ? ` (status ${entry.status})` : ""}`);
    if (BINARY_TYPE.test(type)) return this.omit(entry, `binary content-type ${type} (${buf.length} bytes)`);

    const raw = buf.toString("utf-8");
    const key = `${entry.method} ${entry.url}`;
    const prev = this.last.get(key);
    if (prev && prev.raw === raw) {
      entry.responseBody = prev.body;
      return;
    }
    if (this.captured >= MAX_BODIES_PER_CALL) {
      return this.omit(entry, `this call already captured ${MAX_BODIES_PER_CALL} bodies (the per-call limit) — narrow captureBodies`);
    }
    const cap = Math.min(MAX_BODY_CHARS, MAX_CALL_BODY_CHARS - this.used);
    if (cap < MIN_USEFUL_CHARS) {
      return this.omit(
        entry,
        `the per-call body budget (${MAX_CALL_BODY_CHARS} chars) is used up — narrow captureBodies, or capture this call on its own`
      );
    }

    const body = buildBody(raw, buf.length, type, cap);
    this.used += body.json !== undefined ? JSON.stringify(body.json).length : (body.text ?? "").length;
    this.captured++;
    this.last.set(key, { raw, body });
    entry.responseBody = body;
  }

  /** What each pattern matched; patterns that matched nothing, with near misses from `requests`. */
  report(requests: NetworkEntry[]): BodyCaptureReport {
    const patterns = this.patterns.map((p, i) => ({ pattern: p.raw, matched: this.hits[i] }));
    const unmatched = this.patterns
      .filter((_p, i) => this.hits[i] === 0)
      .map((p) => {
        const nearMisses = nearMissesFor({ ...p, path: p.raw }, requests);
        return { pattern: p.raw, ...(nearMisses.length ? { nearMisses } : {}) };
      });
    const omitted = requests.filter((r) => r.responseBody?.omitted).length;
    const truncated = new Set(requests.map((r) => r.responseBody).filter((b) => b?.truncated)).size;
    const warnings: string[] = [];
    if (unmatched.length) {
      warnings.push(
        `${unmatched.length} pattern(s) matched no API call: ${unmatched.map((u) => u.pattern).join(", ")}. ` +
          'Use the path apiCalls shows (an API base prefix needs "**/" or the full path), and check the action that fetches it ran.'
      );
    }
    if (omitted) warnings.push(`${omitted} matching response(s) carry no body — see each entry's responseBody.omitted.`);
    return {
      patterns,
      bodies: this.captured,
      chars: this.used,
      limits: { perBodyChars: MAX_BODY_CHARS, perCallChars: MAX_CALL_BODY_CHARS, perCallBodies: MAX_BODIES_PER_CALL },
      ...(truncated ? { truncated } : {}),
      ...(unmatched.length ? { unmatched } : {}),
      ...(warnings.length ? { warning: warnings.join(" ") } : {}),
    };
  }
}

/** Parse, redact and shorten one response body to at most `cap` characters. */
export function buildBody(raw: string, bytes: number, contentType: string, cap: number): CapturedBody {
  const type = contentType ? { contentType } : {};
  const looksJson = /\bjson\b/i.test(contentType) || /^\s*[[{]/.test(raw);
  if (looksJson) {
    let parsed: unknown;
    let ok = false;
    try {
      parsed = JSON.parse(raw.replace(/^﻿/, ""));
      ok = true;
    } catch {
      /* not JSON after all — returned as text */
    }
    if (ok) {
      const counter = { n: 0 };
      const clean = redact(parsed, counter);
      const redacted = counter.n ? { redacted: counter.n } : {};
      const short = shrinkJson(clean, cap);
      if (!short.truncated) return { json: short.json, ...type, ...redacted };
      return {
        ...(short.text !== undefined ? { text: short.text } : { json: short.json }),
        ...type,
        truncated: true,
        originalBytes: bytes,
        truncation: short.notes,
        ...redacted,
      };
    }
  }
  let n = 0;
  const text = raw.replace(JWT, () => (n++, REDACTED));
  const redacted = n ? { redacted: n } : {};
  if (text.length <= cap) return { text, ...type, ...redacted };
  return {
    text: text.slice(0, cap),
    ...type,
    truncated: true,
    originalBytes: bytes,
    truncation: [`text cut to its first ${cap} of ${text.length} chars`],
    ...redacted,
  };
}

/** Replace credential-looking string values (by key name, or a JWT anywhere) — the shape stays. */
function redact(value: unknown, counter: { n: number }, key?: string): unknown {
  if (typeof value === "string") {
    if ((key && SECRET_KEY.test(key) && value.length > 0) || new RegExp(`^${JWT.source}$`).test(value)) {
      counter.n++;
      return REDACTED;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, counter, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redact(v, counter, k);
    return out;
  }
  return value;
}

interface ShrinkLevel { rows: number; str: number; depth: number; keys: number }
const SHRINK_LEVELS: ShrinkLevel[] = [
  { rows: 5, str: 1000, depth: Infinity, keys: Infinity },
  { rows: 3, str: 300, depth: Infinity, keys: Infinity },
  { rows: 2, str: 120, depth: 8, keys: 80 },
  { rows: 1, str: 60, depth: 5, keys: 40 },
];
const MAX_NOTES = 12;

/**
 * Shorten a JSON value to at most `cap` serialized characters while keeping
 * it valid JSON with the real shape: arrays keep their first rows, long
 * strings their head, and (only if still over) deep or very wide objects are
 * summarized. Each cut is listed by path (`$.items: kept 3 of 1578 rows`).
 * If even the tightest level is over the cap, the serialized text is cut.
 */
export function shrinkJson(
  value: unknown,
  cap: number
): { json?: unknown; text?: string; truncated: boolean; notes: string[] } {
  if (JSON.stringify(value).length <= cap) return { json: value, truncated: false, notes: [] };
  let last = "";
  let lastNotes = new Map<string, string>();
  for (const level of SHRINK_LEVELS) {
    const notes = new Map<string, string>();
    const pruned = prune(value, level, "$", 0, notes);
    last = JSON.stringify(pruned);
    lastNotes = notes;
    if (last.length <= cap) return { json: pruned, truncated: true, notes: listNotes(notes) };
  }
  return {
    text: last.slice(0, cap),
    truncated: true,
    notes: [...listNotes(lastNotes), `still over the cap after shortening: serialized JSON cut at ${cap} chars (not parseable)`],
  };
}

function listNotes(notes: Map<string, string>): string[] {
  const all = [...notes.values()];
  return all.length > MAX_NOTES ? [...all.slice(0, MAX_NOTES), `…and ${all.length - MAX_NOTES} more cuts`] : all;
}

function prune(value: unknown, level: ShrinkLevel, path: string, depth: number, notes: Map<string, string>): unknown {
  if (typeof value === "string") {
    if (value.length <= level.str) return value;
    notes.set(`${path}#str`, `${path}: strings cut to ${level.str} chars (longest ${Math.max(value.length, longest(notes, path))})`);
    return `${value.slice(0, level.str)}…(+${value.length - level.str} chars)`;
  }
  if (Array.isArray(value)) {
    if (depth >= level.depth) {
      notes.set(`${path}#depth`, `${path}: nested arrays below depth ${level.depth} summarized`);
      return `…(array of ${value.length})`;
    }
    if (value.length > level.rows) {
      notes.set(`${path}#rows`, `${path}: kept ${level.rows} of ${value.length} rows`);
    }
    return value.slice(0, level.rows).map((v) => prune(v, level, `${path}[]`, depth + 1, notes));
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (depth >= level.depth) {
      notes.set(`${path}#depth`, `${path}: nested objects below depth ${level.depth} summarized`);
      return `…(object with ${keys.length} keys)`;
    }
    if (keys.length > level.keys) {
      notes.set(`${path}#keys`, `${path}: kept ${level.keys} of ${keys.length} keys`);
    }
    const out: Record<string, unknown> = {};
    for (const k of keys.slice(0, level.keys)) {
      out[k] = prune((value as Record<string, unknown>)[k], level, `${path}.${k}`, depth + 1, notes);
    }
    return out;
  }
  return value;
}

/** The longest string length already noted for `path` (so the note reports the maximum seen). */
function longest(notes: Map<string, string>, path: string): number {
  const m = /longest (\d+)\)$/.exec(notes.get(`${path}#str`) ?? "");
  return m ? Number(m[1]) : 0;
}
