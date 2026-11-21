/**
 * Who is the browser signed in as? Two answers, both needed when an agent sees
 * different data than a person on the same route:
 *
 *  1. The account the login pre-step types — resolved from `browser.login` /
 *     `browser.profiles` and the env vars it references (which may exist only
 *     in this server's process). Only an email is ever reported; a fill whose
 *     selector or env var looks like a secret is never read.
 *  2. The app's own signed-in user, read from localStorage / sessionStorage on
 *     the page a call ended on: JSON user objects and JWT claims, reduced to
 *     email / id / name / roles (never tokens), plus any impersonation state.
 *
 * App-agnostic: no storage key names are hard-coded; user objects are found by
 * shape and ranked by the key they live under. `source` always names the key,
 * and other distinct users found are listed, so a wrong guess is visible.
 */
import type { Page } from "playwright";
import type { BrowserLoginConfig } from "../types.js";
import type { AppUser, Impersonation } from "./types.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const JWT_RE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
/** Selectors / env var names that hold secrets — never resolved, never reported. */
const SECRET_SELECTOR = /pass|pwd|secret|otp|token|\bpin\b/i;
const SECRET_VAR = /PASS|PWD|SECRET|TOKEN|OTP|API_?KEY|PRIVATE/i;
const EMAILISH = /e-?mail|user|login|account/i;

/** The account a login flow signs in with: an email from config/env, or why it isn't known. */
export function loginAccount(
  login: BrowserLoginConfig | undefined,
  env: NodeJS.ProcessEnv = process.env
): { loginEmail?: string; loginEmailFrom?: string } {
  if (!login) return {};
  let unresolved: string | undefined;
  for (const a of login.actions ?? []) {
    if (a.type !== "fill" || typeof a.text !== "string") continue;
    const vars = [...a.text.matchAll(/\$\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
    if (SECRET_SELECTOR.test(a.selector ?? "") || vars.some((v) => SECRET_VAR.test(v))) continue;
    const missing: string[] = [];
    const value = a.text
      .replace(/\$\{([A-Za-z0-9_]+)\}/g, (_m, name: string) => {
        const v = env[name];
        if (v == null) missing.push(name);
        return v ?? "";
      })
      .trim();
    if (missing.length) {
      if (!unresolved && (EMAILISH.test(a.selector ?? "") || missing.some((v) => /EMAIL|USER|LOGIN/i.test(v)))) {
        unresolved = `env ${missing.join(", ")} — not set in atlas-ui's environment`;
      }
      continue;
    }
    if (EMAIL_RE.test(value)) {
      return { loginEmail: value, loginEmailFrom: vars.length ? `env ${vars.join(", ")}` : "browser.login (literal)" };
    }
  }
  return unresolved ? { loginEmailFrom: unresolved } : {};
}

export interface StorageEntry {
  area: "localStorage" | "sessionStorage";
  key: string;
  value: string;
}

/**
 * The page's storage entries that could hold a user: JSON objects, JWTs, and
 * any key naming impersonation. Values are parsed here in Node, so nothing is
 * evaluated in the page beyond reading storage.
 */
export async function readStorageEntries(page: Page): Promise<StorageEntry[]> {
  return page.evaluate(() => {
    const out: Array<{ area: "localStorage" | "sessionStorage"; key: string; value: string }> = [];
    const areas: Array<["localStorage" | "sessionStorage", () => Storage]> = [
      ["sessionStorage", () => sessionStorage],
      ["localStorage", () => localStorage],
    ];
    for (const [area, get] of areas) {
      try {
        const s = get();
        for (let i = 0; i < s.length && out.length < 300; i++) {
          const key = s.key(i);
          const value = key == null ? null : s.getItem(key);
          if (key == null || value == null || value.length > 100_000) continue;
          const t = value.trimStart();
          if (t.startsWith("{") || t.startsWith("eyJ") || /impersonat|masquerad/i.test(key)) out.push({ area, key, value });
        }
      } catch {
        /* storage blocked */
      }
    }
    return out;
  });
}

export interface ExtractedIdentity {
  user?: AppUser;
  alsoFound?: AppUser[];
  impersonating: false | Impersonation;
}

interface Candidate {
  user: AppUser;
  score: number;
  path: string;
}

/** Find the app's signed-in user (and impersonation state) in storage entries. */
export function extractIdentity(entries: StorageEntry[]): ExtractedIdentity {
  const candidates: Candidate[] = [];
  let impersonation: Impersonation | undefined;

  for (const e of entries) {
    const source = `${e.area}.${e.key}`;
    const parsed = parseValue(e.value);
    if (/impersonat|masquerad/i.test(e.key)) {
      const imp = readImpersonation(parsed, e.value, source);
      if (imp && (!impersonation || (imp.active && !impersonation.active))) impersonation = imp;
      continue;
    }
    if (parsed === undefined) continue;
    const jwt = isJwt(e.value);
    walk(parsed, "", 0, (fields, path) => {
      const keyText = `${e.key}.${path}`;
      let score = fields.score;
      if (/user|auth|account|session|profile|identity|viewer|login|\bme\b/i.test(keyText)) score += 2;
      if (/selected|customer|client|contact|recent|draft|cache|list|target/i.test(keyText)) score -= 3;
      if (jwt) score -= 1;
      candidates.push({
        user: { ...fields.user, source: path ? `${source} → ${path}` : jwt ? `${source} (JWT claims)` : source },
        score,
        path,
      });
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const alsoFound: AppUser[] = [];
  if (best) {
    for (const c of candidates.slice(1)) {
      if (sameUser(c.user, best.user) || alsoFound.some((u) => sameUser(u, c.user))) continue;
      alsoFound.push(c.user);
      if (alsoFound.length >= 3) break;
    }
  }
  return {
    ...(best ? { user: best.user } : {}),
    ...(alsoFound.length ? { alsoFound } : {}),
    impersonating: impersonation ?? false,
  };
}

function parseValue(v: string): unknown {
  const t = v.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch {
      return undefined;
    }
  }
  if (JWT_RE.test(t)) {
    try {
      const payload = t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isJwt(v: string): boolean {
  return JWT_RE.test(v.trim());
}

/**
 * Visit every user-shaped object under `value` (objects only — arrays are
 * lists of OTHER people, not the signed-in user). Strings holding JSON are
 * parsed and walked too (apps store nested JSON-in-a-string snapshots).
 */
function walk(
  value: unknown,
  path: string,
  depth: number,
  visit: (fields: { user: Omit<AppUser, "source">; score: number }, path: string) => void
): void {
  if (depth > 4 || value == null) return;
  if (typeof value === "string") {
    if (depth === 0 || value.length > 100_000) return;
    const parsed = parseValue(value);
    if (parsed && typeof parsed === "object") walk(parsed, path, depth + 1, visit);
    return;
  }
  if (typeof value !== "object" || Array.isArray(value)) return;
  const fields = asUser(value as Record<string, unknown>);
  if (fields) visit(fields, path);
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (/token|secret|password/i.test(k)) continue;
    walk(v, path ? `${path}.${k}` : k, depth + 1, visit);
  }
}

/** Reduce an object to identity fields when it looks like a user (email and/or roles, plus id/name). */
function asUser(o: Record<string, unknown>): { user: Omit<AppUser, "source">; score: number } | undefined {
  const email = [o.email, o.emailAddress, o.mail, o.upn, o.preferred_username].find(
    (v): v is string => typeof v === "string" && EMAIL_RE.test(v)
  );
  const roles = rolesOf(o);
  const idRaw = [o.id, o.uid, o.userId, o.user_id, o.sub, o._id].find(
    (v) => typeof v === "string" || typeof v === "number"
  );
  const name = nameOf(o);
  let score = 0;
  if (email) score += 2;
  if (roles) score += 2;
  if (idRaw != null) score += 1;
  if (name) score += 1;
  if (score < 3 || (!email && !roles)) return undefined;
  return {
    user: {
      ...(email ? { email } : {}),
      ...(idRaw != null ? { id: String(idRaw) } : {}),
      ...(name ? { name } : {}),
      ...(roles ? { roles } : {}),
    },
    score,
  };
}

function rolesOf(o: Record<string, unknown>): string[] | undefined {
  const rolesKey = Object.keys(o).find((k) => /(^|[/:._-])roles$/i.test(k) || k === "authorities");
  const raw = rolesKey ? o[rolesKey] : o.role ?? o.userRole ?? o.userType;
  const list = (Array.isArray(raw) ? raw : raw != null ? [raw] : [])
    .map((r) => (typeof r === "string" ? r : r && typeof r === "object" ? (r as Record<string, unknown>).name ?? (r as Record<string, unknown>).authority : undefined))
    .filter((r): r is string => typeof r === "string" && r.length > 0 && r.length < 80);
  return list.length ? [...new Set(list)].slice(0, 20) : undefined;
}

function nameOf(o: Record<string, unknown>): string | undefined {
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const first = s(o.firstName) ?? s(o.first_name) ?? s(o.given_name);
  const last = s(o.lastName) ?? s(o.last_name) ?? s(o.family_name);
  if (first || last) return [first, last].filter(Boolean).join(" ");
  return s(o.displayName) ?? s(o.fullName) ?? s(o.name) ?? s(o.username);
}

function sameUser(a: AppUser, b: AppUser): boolean {
  if (a.email && b.email) return a.email.toLowerCase() === b.email.toLowerCase();
  return !!a.id && a.id === b.id;
}

/**
 * Read an impersonation entry: a stored phase/status/flag decides `active`;
 * the user inside it under a non-"original" path is who is impersonated, one
 * under an "original"/"admin"/"real" path is the real user.
 */
function readImpersonation(parsed: unknown, raw: string, source: string): Impersonation | undefined {
  const trimmed = raw.trim();
  if (!trimmed || /^(false|0|null|undefined|""|\{\})$/i.test(trimmed)) return undefined;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    // A bare flag ("true", "active") or a token — impersonation is on.
    return { active: true, ...(trimmed.length < 40 && !isJwt(trimmed) ? { phase: trimmed } : {}), source };
  }
  const o = parsed as Record<string, unknown>;
  const phaseRaw = [o.phase, o.status, o.state, o.mode].find((v): v is string => typeof v === "string");
  const flag = [o.active, o.isActive, o.enabled, o.impersonating].find((v): v is boolean => typeof v === "boolean");
  let as: Candidate | undefined;
  let original: Candidate | undefined;
  walk(parsed, "", 0, (fields, path) => {
    const c = { user: { ...fields.user, source: path ? `${source} → ${path}` : source }, score: fields.score, path };
    if (/original|admin|real|previous|actor|impersonator/i.test(path)) {
      if (!original || c.score > original.score) original = c;
    } else if (!as || c.score > as.score) {
      as = c;
    }
  });
  const active = flag ?? (phaseRaw ? /^(active|on|true|started|impersonating)$/i.test(phaseRaw) : !!as);
  return {
    active,
    ...(phaseRaw ? { phase: phaseRaw } : {}),
    ...(as ? { as: (as as Candidate).user } : {}),
    ...(original ? { original: (original as Candidate).user } : {}),
    source,
  };
}

/** "admin@x.com [Admin]" for a summary line. */
export function describeUser(u: AppUser | undefined): string {
  if (!u) return "?";
  const who = u.email ?? u.name ?? (u.id ? `id ${u.id}` : "?");
  return u.roles?.length ? `${who} [${u.roles.join(", ")}]` : who;
}
