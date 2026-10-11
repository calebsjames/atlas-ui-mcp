import fs from "fs/promises";
import type { FlowAction } from "./types.js";
import { normalizeSectionId, type Section, type ViewContainer } from "../analyzer/viewContainer.js";
import { extractViewContainer } from "../analyzer/extractViewContainer.js";
import { detectViewGate } from "./viewGate.js";

/**
 * A plan for revealing a section inside a routed container page. A section can
 * be reached by appending a URL query param, by clicking an activator control
 * after navigation, or — when neither is statically resolvable — not at all
 * (via "unknown"), in which case the caller reports the gate so the agent knows
 * an interaction is needed.
 */
export interface SectionReveal {
  container: string;
  /** The state variable the switch keys on, when known. */
  selector?: string;
  /** The matched section id, when resolved via the multiplexer extractor. */
  section?: string;
  via: "query" | "click" | "unknown";
  /** The raw gate expression, for the "unknown" / single-gate reporting case. */
  condition?: string;
  /** Append to the URL to reveal the section. */
  queryParam?: { key: string; value: string };
  /** Further params a compound (`a && b`) section needs, all appended. */
  alsoQuery?: Array<{ key: string; value: string }>;
  /** A compound gate's full `{var: value}` conditions. */
  conditions?: Record<string, string>;
  /** Run after navigation to reveal the section (a click on the activator). */
  actions?: FlowAction[];
  /** True when we produced a concrete reveal (query appended or actions attached). */
  applied: boolean;
  note?: string;
}

/**
 * Plan how to reveal a section inside a routed container page: read the page
 * source, extract its view multiplexer, find the section by child-component
 * name or by explicit id, and return a query / click / unknown reveal. Falls
 * back to the single-child Vue query-gate detector for a page that gates ONE
 * child (below the multiplexer's ≥2 threshold). Best-effort — returns null when
 * the page can't be read or names no such section.
 */
export async function planSectionReveal(
  pagePath: string,
  pageName: string,
  target: { child?: string; sectionId?: string }
): Promise<SectionReveal | null> {
  let source: string;
  try {
    source = await fs.readFile(pagePath, "utf-8");
  } catch {
    return null;
  }

  let container: ViewContainer | null = null;
  try {
    container = extractViewContainer(source, pageName, pagePath);
  } catch {
    container = null;
  }

  if (container) {
    const section = findSection(container, target);
    if (section) return fromSection(container, section);
  }

  // Fallback: a single conditionally-rendered child (Vue query gate) — the
  // pre-multiplexer case the extractor's ≥2 threshold intentionally excludes.
  if (target.child && pagePath.endsWith(".vue")) {
    const gate = detectViewGate(source, target.child);
    if (gate) {
      const applied = !!(gate.queryKey && gate.queryValue !== undefined);
      return {
        container: pageName,
        via: gate.queryKey ? "query" : "unknown",
        condition: gate.condition,
        ...(applied ? { queryParam: { key: gate.queryKey!, value: gate.queryValue! } } : {}),
        applied,
        ...(applied
          ? {}
          : {
              note:
                `"${target.child}" is gated by \`${gate.condition}\` with no detectable URL wiring — ` +
                `an interaction is needed to reveal it.`,
            }),
      };
    }
  }

  return null;
}

function findSection(c: ViewContainer, t: { child?: string; sectionId?: string }): Section | undefined {
  // Ids match case-, whitespace-, `-`/`_`-insensitively: `clubfittings` and
  // `club-fittings` both find "Club Fittings" (the URL still gets the exact literal).
  const wanted = t.sectionId != null ? normalizeSectionId(t.sectionId) : undefined;
  return c.sections.find(
    (s) =>
      (wanted !== undefined && normalizeSectionId(s.id) === wanted) ||
      (t.child != null &&
        [s.child, ...(s.alsoRenders ?? [])].some((c) => c != null && c.toLowerCase() === t.child!.toLowerCase()))
  );
}

/**
 * The section ids a page's view multiplexer exposes — for the "no such
 * section" error. Empty when the page has no multiplexer or can't be read.
 */
export async function listSectionIds(pagePath: string, pageName: string): Promise<string[]> {
  try {
    const source = await fs.readFile(pagePath, "utf-8");
    return extractViewContainer(source, pageName, pagePath)?.sections.map((s) => s.id) ?? [];
  } catch {
    return [];
  }
}

function fromSection(c: ViewContainer, section: Section): SectionReveal {
  const base = {
    container: c.container,
    selector: c.selector,
    section: section.id,
    ...(section.conditions ? { conditions: section.conditions } : {}),
  };
  if (section.queryParam) {
    return {
      ...base,
      via: "query",
      queryParam: section.queryParam,
      ...(section.alsoQuery ? { alsoQuery: section.alsoQuery } : {}),
      applied: true,
    };
  }
  if (section.activator) {
    return {
      ...base,
      via: "click",
      actions: [{ type: "click", selector: section.activator.selector }],
      applied: true,
    };
  }
  return {
    ...base,
    via: "unknown",
    applied: false,
    note:
      `Section "${section.id}" of ${c.container} has no statically resolvable reveal ` +
      `(keyed on ${c.selector}); drive the UI to reach it.`,
  };
}
