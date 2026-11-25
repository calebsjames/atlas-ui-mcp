/**
 * Per-call API stubs (`mockApi`). A screen is often built before its server
 * part exists: the endpoint 404s, or a new field isn't served yet, so the page
 * could never be seen with data. A stub fulfills matching requests for ONE
 * call; everything else passes through to the real API, and the route is
 * removed when the call ends (even on error), so the shared browser is never
 * left stubbed.
 *
 * Matching uses the same classification and URL reduction as `apiCalls`:
 * only xhr/fetch requests (or URLs under `/api/`), compared by pathname on
 * any origin — so the path an agent reads in `apiCalls` is the path it mocks.
 */
import fs from "fs";
import path from "path";
import type { Page, Request, Route } from "playwright";
import type { ApiMock, MockReport, NetworkEntry } from "./types.js";
import { isApiRequest } from "./network.js";
import { escapeRegex } from "../util.js";

const MOCK_KEYS = ["method", "path", "query", "status", "json", "jsonFile", "body", "bodyFile", "headers"] as const;
/** The four ways to give a stub its response body — at most one per stub. */
const BODY_KEYS = ["json", "jsonFile", "body", "bodyFile"] as const;
/** A mock file larger than this is refused (it would be re-sent on every matching request). */
const MAX_MOCK_FILE_BYTES = 5_000_000;
/** content-type for a `bodyFile`, by extension (text/plain otherwise). */
const BODY_FILE_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".xml": "application/xml",
  ".csv": "text/csv; charset=utf-8",
};
/** Likely wrong names for a mock field → the field meant. */
const KEY_ALIASES: Record<string, string> = {
  url: "path", pattern: "path", route: "path", endpoint: "path", pathname: "path",
  statuscode: "status", code: "status",
  response: "json", data: "json", payload: "json", responsejson: "json", result: "json",
  responsebody: "body", text: "body", raw: "body",
  params: "query", searchparams: "query", querystring: "query",
  verb: "method", httpmethod: "method",
  contenttype: "headers", responseheaders: "headers",
  file: "jsonFile", filepath: "jsonFile", jsonpath: "jsonFile", jsonfilepath: "jsonFile", fixture: "jsonFile", fixturefile: "jsonFile",
  bodypath: "bodyFile", bodyfilepath: "bodyFile", textfile: "bodyFile",
};
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "*"]);

/** A validated stub with its matchers compiled. */
export interface CompiledMock {
  /** Upper-case method, or "*" for any. */
  method: string;
  /** The `path` as the caller wrote it (for reports). */
  path: string;
  status: number;
  /** Pinned origin when `path` was a full URL. */
  origin?: string;
  pathRe: RegExp;
  query: Array<[string, string]>;
  body: string;
  headers: Record<string, string>;
  /** The `jsonFile` / `bodyFile` the body was read from, as the caller wrote it. */
  file?: string;
  /** Last literal path segment, for near-miss hints on an unmatched stub. */
  lastSegment?: string;
}

/**
 * Validate and compile `mockApi`. Throws one message naming every problem —
 * an unknown key gets a did-you-mean — before any browser work starts.
 * `baseDir` (the workspace root) is where `jsonFile` / `bodyFile` resolve,
 * and the directory they must stay inside.
 */
export function compileMocks(raw: unknown, opts: { baseDir?: string } = {}): CompiledMock[] {
  if (!Array.isArray(raw)) {
    throw new Error("mockApi must be an array of stubs, e.g. [{\"path\": \"/orders/catalog\", \"json\": [...]}].");
  }
  const problems: string[] = [];
  const out: CompiledMock[] = [];
  raw.forEach((m, i) => {
    const where = `mockApi[${i}]`;
    if (!m || typeof m !== "object" || Array.isArray(m)) {
      problems.push(`${where} must be an object.`);
      return;
    }
    const mock = m as Record<string, unknown>;
    for (const key of Object.keys(mock)) {
      if ((MOCK_KEYS as readonly string[]).includes(key)) continue;
      const hint = suggestKey(key);
      problems.push(`${where}: unknown key "${key}"${hint ? ` — did you mean "${hint}"?` : "."}`);
    }
    if (typeof mock.path !== "string" || !mock.path.trim()) {
      problems.push(`${where}: "path" (string) is required, e.g. "/orders/catalog".`);
      return;
    }
    const method = mock.method == null ? "GET" : String(mock.method).toUpperCase();
    if (!METHODS.has(method === "ANY" ? "*" : method)) {
      problems.push(`${where}: method "${String(mock.method)}" is not one of GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS or "*".`);
    }
    const status = mock.status == null ? 200 : mock.status;
    if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
      problems.push(`${where}: status must be an integer HTTP status (100-599).`);
    }
    const given = BODY_KEYS.filter((k) => mock[k] !== undefined);
    if (given.length === 2 && given[0] === "json" && given[1] === "body") {
      problems.push(`${where}: give "json" or "body", not both.`);
    } else if (given.length > 1) {
      problems.push(`${where}: give one of "json", "jsonFile", "body" or "bodyFile", not ${given.map((k) => `"${k}"`).join(" and ")}.`);
    }
    if (mock.body !== undefined && typeof mock.body !== "string") {
      problems.push(`${where}: "body" must be a string (use "json" for an object).`);
    }
    // A body kept in a file, so a large payload is not pasted into every call.
    let fileBody: string | undefined;
    let fileType: string | undefined;
    const fileKey = given.length === 1 && (given[0] === "jsonFile" || given[0] === "bodyFile") ? given[0] : undefined;
    if (fileKey) {
      const read = readMockFile(mock[fileKey], fileKey, opts.baseDir);
      if ("problem" in read) {
        problems.push(`${where}: ${read.problem}`);
      } else if (fileKey === "jsonFile") {
        try {
          fileBody = JSON.stringify(JSON.parse(read.text));
          fileType = "application/json";
        } catch (err) {
          problems.push(`${where}: "jsonFile" ${read.shown} is not valid JSON (${err instanceof Error ? err.message : String(err)}). Use "bodyFile" to serve a file as-is.`);
        }
      } else {
        fileBody = read.text;
        fileType = BODY_FILE_TYPES[path.extname(read.shown).toLowerCase()] ?? "text/plain; charset=utf-8";
      }
    }
    const headers = stringMap(mock.headers, `${where}.headers`, problems);
    const queryIn = stringMap(mock.query, `${where}.query`, problems, true);

    let compiled: CompiledPath | undefined;
    try {
      compiled = compilePath(mock.path.trim(), queryIn);
    } catch (err) {
      problems.push(`${where}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!compiled) return;

    const hasJson = mock.json !== undefined;
    const contentType = Object.keys(headers).some((h) => h.toLowerCase() === "content-type");
    out.push({
      ...compiled,
      method: method === "ANY" ? "*" : method,
      status: typeof status === "number" ? status : 200,
      body: fileBody !== undefined ? fileBody : hasJson ? JSON.stringify(mock.json) : typeof mock.body === "string" ? mock.body : "",
      headers: {
        ...(contentType
          ? {}
          : fileType
            ? { "content-type": fileType }
            : hasJson
              ? { "content-type": "application/json" }
              : mock.body !== undefined
                ? { "content-type": "text/plain; charset=utf-8" }
                : {}),
        ...headers,
      },
      ...(fileKey && typeof mock[fileKey] === "string" ? { file: mock[fileKey] as string } : {}),
    });
  });
  if (problems.length) {
    throw new Error(
      `Invalid mockApi — ${problems.join(" ")} Each stub: {method?, path, query?, status?, json? | jsonFile? | body? | bodyFile?, headers?}.`
    );
  }
  return out;
}

/**
 * Read a stub's `jsonFile` / `bodyFile`. The path resolves against the
 * workspace root and must stay inside it — lexically and after symlinks are
 * followed — so a stub cannot serve an arbitrary file from the machine to the
 * page. Returns the text, or the problem to report.
 */
function readMockFile(
  file: unknown,
  key: "jsonFile" | "bodyFile",
  baseDir: string | undefined
): { text: string; shown: string } | { problem: string } {
  if (typeof file !== "string" || !file.trim()) {
    return { problem: `"${key}" must be a file path (string), relative to the workspace root.` };
  }
  if (!baseDir) return { problem: `"${key}" needs a workspace root to resolve against, and none is known here.` };
  const realOrSelf = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const root = realOrSelf(baseDir);
  const inside = (p: string) => {
    const rel = path.relative(root, p);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  const outside = `"${key}" ${JSON.stringify(file)} resolves outside the workspace root (${root}) — a mock file must be inside it. Copy it into the workspace (e.g. .atlas-ui/mocks/) or pass the body inline.`;
  // Resolve against both spellings of the root, so an absolute path written
  // through a symlinked root (macOS /tmp) is still recognised as inside.
  const abs = path.resolve(root, file);
  const lexical = inside(abs) ? abs : inside(realOrSelf(path.resolve(baseDir, file))) ? path.resolve(baseDir, file) : undefined;
  if (!lexical) return { problem: outside };
  let real: string;
  try {
    real = fs.realpathSync(lexical);
  } catch {
    return { problem: `"${key}" file not found: ${lexical} (relative paths resolve against the workspace root ${root}).` };
  }
  if (!inside(real)) return { problem: outside };
  try {
    const st = fs.statSync(real);
    if (!st.isFile()) return { problem: `"${key}" ${JSON.stringify(file)} is not a file.` };
    if (st.size > MAX_MOCK_FILE_BYTES) {
      return { problem: `"${key}" ${JSON.stringify(file)} is ${st.size} bytes — over the ${MAX_MOCK_FILE_BYTES}-byte limit for a mock body.` };
    }
    return { text: fs.readFileSync(real, "utf-8").replace(/^\uFEFF/, ""), shown: file };
  } catch (err) {
    return { problem: `"${key}" ${JSON.stringify(file)} could not be read (${err instanceof Error ? err.message.split("\n")[0] : String(err)}).` };
  }
}

function suggestKey(key: string): string | undefined {
  const k = key.toLowerCase().replace(/[-_]/g, "");
  if (KEY_ALIASES[k]) return KEY_ALIASES[k];
  return MOCK_KEYS.find((c) => editDistance(k, c.toLowerCase()) <= 2);
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/** An optional {string: scalar} map; non-scalar values are a problem. */
function stringMap(v: unknown, where: string, problems: string[], allowScalars = false): Record<string, string> {
  if (v == null) return {};
  if (typeof v !== "object" || Array.isArray(v)) {
    problems.push(`${where} must be an object of strings.`);
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string" || (allowScalars && (typeof val === "number" || typeof val === "boolean"))) {
      out[k] = String(val);
    } else {
      problems.push(`${where}.${k} must be a string.`);
    }
  }
  return out;
}

/** A compiled URL pattern: what `mockApi` paths and `captureBodies` patterns share. */
export type CompiledPath = Pick<CompiledMock, "path" | "origin" | "pathRe" | "query" | "lastSegment">;

/** Parse `path` (exact / glob / "re:" / full URL, optional ?query) into matchers. */
export function compilePath(raw: string, queryIn: Record<string, string>): CompiledPath {
  const query = new Map(Object.entries(queryIn));
  if (raw.startsWith("re:")) {
    let pathRe: RegExp;
    try {
      pathRe = new RegExp(raw.slice(3), "i");
    } catch (err) {
      throw new Error(`invalid regex in path "${raw}": ${err instanceof Error ? err.message : String(err)}`);
    }
    return { path: raw, pathRe, query: [...query] };
  }

  let origin: string | undefined;
  let pathname = raw;
  if (/^https?:\/\//i.test(raw)) {
    const u = new URL(raw);
    origin = u.origin;
    pathname = decodeURIComponent(u.pathname) + (u.search || "");
  }
  const q = pathname.indexOf("?");
  if (q >= 0) {
    for (const [k, v] of new URLSearchParams(pathname.slice(q + 1))) if (!query.has(k)) query.set(k, v);
    pathname = pathname.slice(0, q);
  }
  if (!pathname.startsWith("/") && !pathname.startsWith("*")) pathname = "/" + pathname;
  const body = pathname.replace(/\/+$/, "");
  // `**` = any depth (including none, so "**/x" matches "/x"); `*` = within one segment.
  let re = "";
  for (let i = 0; i < body.length; i++) {
    if (body.startsWith("**/", i)) {
      re += "(?:.*/)?";
      i += 2;
    } else if (body.startsWith("**", i)) {
      re += ".*";
      i += 1;
    } else if (body[i] === "*") {
      re += "[^/]*";
    } else {
      re += escapeRegex(body[i]);
    }
  }
  const segments = body.split("/").filter((s) => s && !s.includes("*"));
  return {
    path: raw,
    origin,
    pathRe: new RegExp(`^${re}/?$`, "i"),
    query: [...query],
    ...(segments.length ? { lastSegment: segments[segments.length - 1].toLowerCase() } : {}),
  };
}

export function pathMatches(m: Pick<CompiledMock, "origin" | "pathRe">, url: URL): boolean {
  if (m.origin && url.origin !== m.origin) return false;
  return m.pathRe.test(safeDecode(url.pathname));
}

export function queryMatches(m: Pick<CompiledMock, "query">, url: URL): boolean {
  return m.query.every(([k, v]) => url.searchParams.get(k) === v);
}

export function methodMatches(m: Pick<CompiledMock, "method">, method: string): boolean {
  return m.method === "*" || m.method === method.toUpperCase();
}

function safeDecode(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/**
 * Installs one call's stubs on a page and counts hits. `install` routes only
 * URLs whose path some stub could match (so the dev server's module requests
 * never pass through a handler); `uninstall` removes exactly that route.
 */
export class MockRouter {
  private readonly hits: number[];
  private page: Page | null = null;
  private readonly matcher = (url: URL) => this.mocks.some((m) => pathMatches(m, url));
  private readonly handler = (route: Route) => this.handle(route);
  private onMocked: (req: Request) => void = () => {};

  constructor(private readonly mocks: CompiledMock[]) {
    this.hits = mocks.map(() => 0);
  }

  async install(page: Page, onMocked: (req: Request) => void): Promise<void> {
    this.onMocked = onMocked;
    await page.route(this.matcher, this.handler);
    this.page = page;
  }

  async uninstall(): Promise<void> {
    const page = this.page;
    this.page = null;
    if (!page || page.isClosed()) return;
    await page.unroute(this.matcher, this.handler).catch(() => {});
  }

  private async handle(route: Route): Promise<void> {
    const req = route.request();
    let url: URL;
    try {
      url = new URL(req.url());
    } catch {
      return route.fallback();
    }
    const method = req.method().toUpperCase();
    // Cross-origin stubs need no CORS work here: while any route is installed,
    // Playwright (Chromium) answers every CORS preflight itself, and
    // route.fulfill adds access-control-allow-origin/-credentials for a
    // cross-origin request (verified against playwright-core 1.61).
    if (!isApiRequest({ resourceType: req.resourceType(), url: req.url() })) return route.fallback();
    const i = this.mocks.findIndex((m) => methodMatches(m, method) && pathMatches(m, url) && queryMatches(m, url));
    if (i < 0) return route.fallback();

    this.hits[i]++;
    this.onMocked(req);
    const m = this.mocks[i];
    await route.fulfill({ status: m.status, headers: m.headers, body: m.body }).catch(() => {
      // The page navigated away or aborted the request — nothing to answer.
    });
  }

  /** Hits per stub; stubs that matched nothing, with near misses from `requests`. */
  report(requests: NetworkEntry[]): MockReport {
    const mocks = this.mocks.map((m, i) => ({
      method: m.method, path: m.path, status: m.status, hits: this.hits[i], ...(m.file ? { file: m.file } : {}),
    }));
    const unmatched = this.mocks
      .map((m, i) => ({ m, i }))
      .filter(({ i }) => this.hits[i] === 0)
      .map(({ m }) => {
        const nearMisses = nearMissesFor(m, requests);
        return { method: m.method, path: m.path, ...(nearMisses.length ? { nearMisses } : {}) };
      });
    if (!unmatched.length) return { mocks };
    return {
      mocks,
      unmatched,
      warning:
        `${unmatched.length} stub(s) matched no request: ${unmatched.map((u) => `${u.method} ${u.path}`).join(", ")}. ` +
        "The page never asked for it during this call — check the method, the path the page really calls " +
        "(apiCalls / nearMisses; an API base prefix needs \"**/\" or the full path), or whether the action that fetches it ran.",
    };
  }
}

/** Observed API calls that look like what an unmatched stub meant. */
export function nearMissesFor(m: CompiledPath & { method: string }, requests: NetworkEntry[]): string[] {
  const out = new Set<string>();
  for (const r of requests) {
    if (!isApiRequest(r) || r.mocked) continue;
    let url: URL;
    try {
      url = new URL(r.url);
    } catch {
      continue;
    }
    const p = safeDecode(url.pathname);
    const status = r.status != null ? ` → ${r.status}` : r.failure ? ` → ${r.failure}` : "";
    if (pathMatches(m, url)) {
      const why = !methodMatches(m, r.method) ? "method differs" : !queryMatches(m, url) ? "query differs" : "";
      if (why) out.add(`${r.method} ${p}${status} (${why})`);
    } else if (m.lastSegment && p.toLowerCase().replace(/\/+$/, "").endsWith("/" + m.lastSegment)) {
      out.add(`${r.method} ${p}${status}`);
    }
    if (out.size >= 5) break;
  }
  return [...out];
}
