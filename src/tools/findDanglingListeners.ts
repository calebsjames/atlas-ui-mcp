import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { Component } from "../types.js";
import { ensureCatalog, matchesFile } from "./shared.js";

/**
 * Cross-component dead event wiring: a parent binds `@some-event` on a child
 * component that never fires it. Two high-confidence shapes:
 *  - "dead-plumbing": the child DECLARES the event but never `emit()`s it
 *    (pairs with emitsDead — the ECS-83 case).
 *  - "unknown-event": the child neither declares nor fires it (typo/renamed).
 *
 * Native DOM events (click, input, change, …) are ignored — a component can
 * re-emit those via attribute fallthrough without declaring them. Children with
 * dynamic emits (`emit(variable)`) or no declared emits at all are skipped, so
 * we never guess where deadness can't be proven.
 */
export async function findDanglingListeners(
  args: { file?: string },
  scanner: ComponentScanner,
  cache: CacheManager
): Promise<{
  scanned: number;
  danglingCount: number;
  dangling: DanglingListener[];
  unresolvedChildren: number;
  note: string;
}> {
  const catalog = await ensureCatalog(scanner, cache);

  // name (lowercased) → components. A child tag can resolve to >1 file; we treat
  // the union of their emits, so ANY match firing the event clears it.
  const byName = new Map<string, Component[]>();
  for (const c of catalog.components) {
    const key = c.name.toLowerCase();
    const list = byName.get(key);
    if (list) list.push(c);
    else byName.set(key, [c]);
  }

  const parents = catalog.components.filter(
    (c) => c.childEventBindings?.length && matchesFile(c, args.file)
  );

  const dangling: DanglingListener[] = [];
  let unresolvedChildren = 0;

  for (const parent of parents) {
    for (const binding of parent.childEventBindings ?? []) {
      const candidates = byName.get(binding.component.toLowerCase());
      if (!candidates || candidates.length === 0) {
        unresolvedChildren++; // external/library child — can't verify its emits
        continue;
      }
      // Skip when deadness is unprovable: any candidate emits dynamically, or a
      // candidate declares no emits at all (fallthrough-style child).
      if (candidates.some((c) => c.emitsDynamic || !(c.emits && c.emits.length))) continue;

      const firedNorm = new Set(candidates.flatMap((c) => (c.emitsFired ?? []).map(normalizeEvent)));
      const declaredNorm = new Set(candidates.flatMap((c) => (c.emits ?? []).map(normalizeEvent)));

      for (const event of binding.events) {
        const n = normalizeEvent(event);
        if (NATIVE_DOM_EVENTS.has(n) || firedNorm.has(n)) continue;
        const line = binding.lines?.[event];
        dangling.push({
          parent: parent.name,
          parentPath: parent.relativePath,
          child: binding.component,
          event,
          ...(line !== undefined ? { line } : {}),
          reason: declaredNorm.has(n)
            ? "child declares this event but never emits it (dead plumbing)"
            : "child neither declares nor emits this event (typo or renamed event?)",
        });
      }
    }
  }

  dangling.sort(
    (a, b) => a.parent.localeCompare(b.parent) || a.child.localeCompare(b.child) || a.event.localeCompare(b.event)
  );

  return {
    scanned: parents.length,
    danglingCount: dangling.length,
    dangling,
    unresolvedChildren,
    note:
      "Native DOM events and children with dynamic/undeclared emit APIs are excluded to avoid false positives. " +
      "`unresolvedChildren` are child tags not found in the catalog (external components), which can't be verified.",
  };
}

export interface DanglingListener {
  parent: string;
  parentPath: string;
  child: string;
  event: string;
  /** 1-based line of the binding in the parent's template, when known. */
  line?: number;
  reason: string;
}

/** Match Vue's event-name normalization: case- and hyphen-insensitive. */
function normalizeEvent(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** DOM events a component can re-emit via attribute fallthrough without declaring. */
const NATIVE_DOM_EVENTS = new Set(
  [
    "click", "dblclick", "mousedown", "mouseup", "mouseenter", "mouseleave", "mousemove",
    "mouseover", "mouseout", "contextmenu",
    "input", "change", "submit", "reset", "invalid",
    "focus", "blur", "focusin", "focusout",
    "keydown", "keyup", "keypress",
    "scroll", "wheel", "resize",
    "drag", "drop", "dragover", "dragenter", "dragleave", "dragstart", "dragend",
    "touchstart", "touchend", "touchmove", "touchcancel",
    "pointerdown", "pointerup", "pointermove", "pointerenter", "pointerleave",
    "pointerover", "pointerout", "pointercancel",
    "copy", "cut", "paste",
    "load", "error", "abort",
    "animationstart", "animationend", "animationiteration", "transitionend",
  ].map((e) => e.replace(/[^a-z0-9]/g, ""))
);
