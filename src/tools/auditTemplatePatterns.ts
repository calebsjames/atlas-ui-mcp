import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { Component, ProjectConfig, TemplatePatterns } from "../types.js";
import { ensureCatalog } from "./shared.js";

/**
 * Repo-wide template-layer drift audit — the "grep battery in one call" for
 * overlay/modal markup. For every component carrying templatePatterns it returns
 * the raw signals plus synthesized findings against the design rubric: a backdrop
 * click without `.self`, an overlay not wrapped in a Teleport, z-index over the
 * configured cap, a modal with no accessible heading, etc.
 *
 * Only the WARNINGS are opinionated; the raw per-component signals are also on
 * get_component_detail. z-index-over-max only fires when browser-agnostic
 * `templatePatterns.maxZIndex` is configured, so the tool isn't noisy by default.
 */
export async function auditTemplatePatterns(
  args: { file?: string },
  scanner: ComponentScanner,
  cache: CacheManager,
  config: ProjectConfig
): Promise<{
  scanned: number;
  findingCount: number;
  findings: Finding[];
  components: Array<{ name: string; relativePath: string; templatePatterns: TemplatePatterns; findings: Finding[] }>;
  config: { maxZIndex?: number };
  note: string;
}> {
  const catalog = await ensureCatalog(scanner, cache);
  const maxZIndex = config.templatePatterns?.maxZIndex;

  const targets = catalog.components.filter(
    (c) => c.templatePatterns && (!args.file || c.relativePath.includes(args.file) || c.path.includes(args.file))
  );

  const allFindings: Finding[] = [];
  const components = targets.map((c) => {
    const findings = synthesizeFindings(c, c.templatePatterns!, maxZIndex);
    allFindings.push(...findings);
    return { name: c.name, relativePath: c.relativePath, templatePatterns: c.templatePatterns!, findings };
  });

  const sevRank = { warn: 0, info: 1 };
  allFindings.sort(
    (a, b) => sevRank[a.severity] - sevRank[b.severity] || a.component.localeCompare(b.component) || a.code.localeCompare(b.code)
  );

  return {
    scanned: targets.length,
    findingCount: allFindings.length,
    findings: allFindings,
    components,
    config: { maxZIndex },
    note:
      "Regex-based template analysis; overlay classes, z-index cap, and header classes are tunable via config.templatePatterns. " +
      (maxZIndex == null ? "Set templatePatterns.maxZIndex to enable z-index-over-cap warnings. " : "") +
      "Raw per-component signals are also on get_component_detail.templatePatterns.",
  };
}

export interface Finding {
  component: string;
  relativePath: string;
  code:
    | "backdrop-click-missing-self"
    | "overlay-not-teleported"
    | "overlay-no-dismiss"
    | "zindex-exceeds-max"
    | "modal-no-heading"
    | "teleport-disabled-binding";
  severity: "warn" | "info";
  message: string;
  line?: number;
}

function synthesizeFindings(c: Component, tp: TemplatePatterns, maxZIndex?: number): Finding[] {
  const out: Finding[] = [];
  const at = (code: Finding["code"], severity: Finding["severity"], message: string, line?: number) =>
    out.push({ component: c.name, relativePath: c.relativePath, code, severity, message, ...(line != null ? { line } : {}) });

  const overlays = tp.overlays ?? [];
  const hasTeleport = !!tp.teleport?.present;

  for (const o of overlays) {
    const where = `<${o.tag}${o.classes.length ? ` class="${o.classes.join(" ")}"` : ""}>`;
    if (o.clickHandler?.bound) {
      if (!o.clickHandler.modifiers.includes("self")) {
        at(
          "backdrop-click-missing-self",
          "warn",
          `Backdrop ${where} closes on @click without \`.self\` — clicks inside the modal content will also dismiss it. Use @click.self.`,
          o.line
        );
      }
    } else {
      at("overlay-no-dismiss", "info", `Overlay ${where} has no click handler — not dismissible by backdrop click (may be intentional).`, o.line);
    }
    if (!hasTeleport) {
      at(
        "overlay-not-teleported",
        "warn",
        `Overlay ${where} is rendered in-tree (no <Teleport>) — it can clip under an ancestor's stacking context or overflow:hidden.`,
        o.line
      );
    }
  }

  // A modal/overlay needs an accessible name: a heading or an aria-label/labelledby.
  if (overlays.length && !(tp.headings && tp.headings.length)) {
    const aria = c.accessibility?.ariaAttributes ?? [];
    if (!aria.includes("aria-label") && !aria.includes("aria-labelledby")) {
      at("modal-no-heading", "info", "Overlay/modal has no heading and no aria-label/aria-labelledby — dialogs should have an accessible name.");
    }
  }

  if (maxZIndex != null) {
    for (const z of tp.zIndexes ?? []) {
      if (z.numeric != null && z.numeric > maxZIndex) {
        at(
          "zindex-exceeds-max",
          "warn",
          `z-index ${z.numeric}${z.selector ? ` (${z.selector})` : ""} exceeds the configured max of ${maxZIndex}.`,
          z.line
        );
      }
    }
  }

  if (tp.teleport?.disabledBinding) {
    at("teleport-disabled-binding", "info", "Teleport has a :disabled binding — the overlay may conditionally render in-tree.");
  }

  return out;
}
