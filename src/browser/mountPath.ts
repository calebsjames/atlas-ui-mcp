import fs from "fs/promises";
import ts from "typescript";
import { CacheManager } from "../cache/cacheManager.js";
import type { Component } from "../types.js";
import type { FlowAction } from "./types.js";
import type { RouteMapEntry } from "../tools/getRouteMap.js";
import { upstreamUsers } from "../analyzer/upstreamWalk.js";
import { planSectionReveal } from "./sectionReveal.js";
import { parseSfc, walkElements, eventBindings, staticAttr, staticTextOf } from "../analyzer/sfcParser.js";
import { findTemplateMountSites } from "../analyzer/templateMountSites.js";
import { activatorSelector } from "../analyzer/viewContainer.js";
import { RENDERABLE_LAYERS } from "../tools/shared.js";

/**
 * Mount-path resolution: how to get a component that no route renders
 * directly — a modal, a tab, a composable — onto the screen. Walk UPSTREAM
 * (the same importer/renderer/hook-consumer edges whats_affected follows) to
 * the nearest ROUTED ancestor, then describe each hop down from it: which
 * template guard mounts it, and whether a URL query / section click reveals
 * it (statically revealable) or only a state change does (a modal's
 * `v-if="showNew"`), with the control that flips that state when the
 * template says so.
 */

export interface MountHop {
  component: string;
  relativePath: string;
  /** How the previous hop reaches this one: mounts it in its template, or consumes it (hook/service). */
  edge?: "renders" | "uses" | "imports";
  /** The template guard the previous hop mounts this one behind (`v-if: showNew`). */
  gate?: string;
  /** How the gate opens: a section reveal by URL query or click, or an app-state change. */
  reveal?: "query" | "click" | "state";
  /** The section id, for a section reveal. */
  section?: string;
  /** For a state gate: the control that opens it, when the template identifies one. */
  activator?: { selector: string; label?: string };
  /** False when page load plus section reveals cannot reach this hop. */
  revealed: boolean;
}

export interface MountPlan {
  route: RouteMapEntry;
  /** Routed ancestor first, target last. */
  hops: MountHop[];
  /** Query params that reveal sections along the path. */
  query: { key: string; value: string }[];
  /** Clicks after load that reveal click-switched sections, in order. */
  revealActions: FlowAction[];
  /** Some hop needs an app-state change (open a modal, select a row). */
  stateGated: boolean;
}

/** How many hops up the walk goes before giving up. */
const MAX_DISTANCE = 8;
/** Cost of a hop that page load + section reveals reach, vs one behind app state. */
const REVEALED_COST = 1;
const STATE_GATE_COST = 10;

/** One evaluated parent→child mount edge. */
interface HopEval {
  hop: MountHop;
  query: MountPlan["query"];
  actions: FlowAction[];
  cost: number;
}

interface Reached {
  item: Component;
  cost: number;
  hops: number;
  /** The node one step DOWN (toward the target) and the evaluated edge to it. */
  child?: Component;
  edge?: HopEval;
}

/**
 * Plan the mount path for `target`, or null when no routed page reaches it.
 * Best-first over upstream edges, each costed by whether page load + section
 * reveals reach it (1) or it needs app state (10), so the chosen ancestor is
 * the one with the fewest state gates, then the fewest hops — even when paths
 * converge on a shared component. Template-mount (`renders`) and consumption
 * (`uses`) edges are tried first; bare import edges only if that finds nothing.
 */
export async function planMountPath(
  target: Component,
  routes: RouteMapEntry[],
  catalog: Component[],
  cache: CacheManager
): Promise<MountPlan | null> {
  const routedByPath = new Map<string, RouteMapEntry>();
  // Static routes first so `/home` wins over `/x/:id` for the same page.
  for (const r of [...routes].sort((a, b) => Number(a.isDynamic) - Number(b.isDynamic))) {
    const rel = r.componentDetails?.relativePath;
    if (rel && !routedByPath.has(norm(rel))) routedByPath.set(norm(rel), r);
  }
  const hookUsers = new Map<string, Component[]>();
  for (const c of catalog) {
    for (const h of c.hooks || []) {
      const k = h.toLowerCase();
      hookUsers.set(k, [...(hookUsers.get(k) || []), c]);
    }
  }
  const sources = new Map<string, Promise<string | undefined>>();
  const read = (c: Component) => {
    if (!sources.has(c.path)) sources.set(c.path, fs.readFile(c.path, "utf-8").catch(() => undefined));
    return sources.get(c.path)!;
  };

  for (const permissive of [false, true]) {
    const best = new Map<string, Reached>([[norm(target.relativePath), { item: target, cost: 0, hops: 0 }]]);
    const done = new Set<string>();
    const frontier: Reached[] = [best.get(norm(target.relativePath))!];
    while (frontier.length) {
      frontier.sort((a, b) => a.cost - b.cost);
      const cur = frontier.shift()!;
      const key = norm(cur.item.relativePath);
      if (done.has(key)) continue;
      done.add(key);

      const route = cur.hops > 0 ? routedByPath.get(key) : undefined;
      // A routed page is a terminal: what imports IT is the router, not a mount.
      if (route) return assemble(cur, best, route);
      if (cur.hops >= MAX_DISTANCE) continue;

      for (const user of upstreamUsers(cur.item, cache, hookUsers)) {
        const ukey = norm(user.relativePath);
        if (done.has(ukey)) continue;
        const kind = edgeKind(user, cur.item);
        if (kind.edge === "imports" && !permissive) continue;
        const ev = await evaluateHop(user, cur.item, kind, read);
        // A dynamic route breaks ties toward a static one.
        const routeTax = routedByPath.get(ukey)?.isDynamic ? 0.5 : 0;
        const cost = cur.cost + ev.cost + routeTax;
        const prev = best.get(ukey);
        if (prev && prev.cost <= cost) continue;
        const next: Reached = { item: user, cost, hops: cur.hops + 1, child: cur.item, edge: ev };
        best.set(ukey, next);
        frontier.push(next);
      }
    }
  }
  return null;
}

/** Follow `child` pointers from the routed ancestor down to the target. */
function assemble(top: Reached, best: Map<string, Reached>, route: RouteMapEntry): MountPlan {
  const hops: MountHop[] = [{ component: top.item.name, relativePath: top.item.relativePath, revealed: true }];
  const query: MountPlan["query"] = [];
  const revealActions: FlowAction[] = [];
  let cur: Reached | undefined = top;
  while (cur?.child && cur.edge) {
    hops.push(cur.edge.hop);
    query.push(...cur.edge.query);
    revealActions.push(...cur.edge.actions);
    cur = best.get(norm(cur.child.relativePath));
  }
  return { route, hops, query, revealActions, stateGated: hops.some((h) => !h.revealed) };
}

/** How `user` reaches `child`, and the tag it mounts it under (name or fileAlias). */
function edgeKind(user: Component, child: Component): { edge: NonNullable<MountHop["edge"]>; tag?: string } {
  const names = [child.name, child.fileAlias].filter((n): n is string => !!n);
  const tag = (user.childComponents || []).find((c) => names.some((n) => n.toLowerCase() === c.toLowerCase()));
  if (tag) return { edge: "renders", tag };
  if (!RENDERABLE_LAYERS.includes(child.architectureLayer)) return { edge: "uses" };
  return { edge: "imports" };
}

/**
 * Props that make an always-mounted modal/drawer visible — the `:is-open`
 * convention. A component mounted unconditionally but shown by one of these is
 * still behind app state.
 */
const VISIBILITY_PROP = /^(is-?open|open|opened|show|shown|visible|is-?visible|is-?shown|model-?value)$/i;

async function evaluateHop(
  parent: Component,
  child: Component,
  kind: { edge: NonNullable<MountHop["edge"]>; tag?: string },
  read: (c: Component) => Promise<string | undefined>
): Promise<HopEval> {
  const hop: MountHop = { component: child.name, relativePath: child.relativePath, edge: kind.edge, revealed: true };
  const ok = (): HopEval => ({ hop, query: [], actions: [], cost: REVEALED_COST });

  if (kind.edge === "uses") return ok();
  if (kind.edge === "imports") {
    hop.gate = "mounted indirectly (imported, no template mount found)";
    hop.reveal = "state";
    hop.revealed = false;
    return { hop, query: [], actions: [], cost: STATE_GATE_COST };
  }

  const tag = kind.tag ?? child.name;
  const cond = parent.childComponentRendering?.[tag] ?? parent.childComponentRendering?.[child.name];
  const guard = cond?.vIf ?? cond?.vShow;

  if (cond && guard) {
    hop.gate = [cond.vIf && `v-if: ${cond.vIf}`, cond.vShow && `v-show: ${cond.vShow}`, cond.vFor && `v-for: ${cond.vFor}`]
      .filter(Boolean)
      .join("; ");
    const plan = await planSectionReveal(parent.path, parent.name, { child: tag }).catch(() => null);
    if (plan?.applied && plan.via === "query") {
      hop.reveal = "query";
      if (plan.section) hop.section = plan.section;
      const query = [plan.queryParam, ...(plan.alsoQuery ?? [])].filter((q): q is { key: string; value: string } => !!q);
      return { hop, query, actions: [], cost: REVEALED_COST };
    }
    if (plan?.applied && plan.via === "click") {
      hop.reveal = "click";
      if (plan.section) hop.section = plan.section;
      return { hop, query: [], actions: plan.actions ?? [], cost: REVEALED_COST };
    }
    return stateGate(hop, parent, guard);
  }

  // Mounted unconditionally — but a modal shown by `:is-open="x"` / v-model is
  // still behind app state.
  const source = parent.path.endsWith(".vue") ? await read(parent) : undefined;
  const site = source ? findTemplateMountSites(source, tag)?.[0] : undefined;
  if (site) {
    for (const [prop, expr] of [
      ...Object.entries(site.vModelProps).map(([k, v]) => [`v-model${k === "modelValue" ? "" : ":" + k}`, v]),
      ...Object.entries(site.boundProps).filter(([k]) => VISIBILITY_PROP.test(k)).map(([k, v]) => [`:${k}`, v]),
    ]) {
      if (!expr || /^(true|1)$/.test(expr)) continue;
      hop.gate = `${prop}="${expr}"`;
      return stateGate(hop, parent, expr);
    }
  }
  if (cond?.vFor) hop.gate = `v-for: ${cond.vFor}`; // once per item — needs a non-empty list, not a click
  return ok();
}

async function stateGate(hop: MountHop, parent: Component, guard: string): Promise<HopEval> {
  hop.reveal = "state";
  hop.revealed = false;
  const activator = await findActivator(parent, guard);
  if (activator) hop.activator = activator;
  return { hop, query: [], actions: [], cost: STATE_GATE_COST };
}

/**
 * The control in `parent`'s template that opens a state gate: a click handler
 * that assigns a gate variable (`showNew = true`) or calls a script function
 * that does (`openNew()` where `showNew.value = true`). Best effort — Vue SFCs
 * only; undefined when nothing identifiable.
 */
export async function findActivator(
  parent: Component,
  guard: string
): Promise<{ selector: string; label?: string } | undefined> {
  if (!parent.path.endsWith(".vue")) return undefined;
  let source: string;
  try {
    source = await fs.readFile(parent.path, "utf-8");
  } catch {
    return undefined;
  }
  const vars = gateVariables(guard.replace(/^!+/, ""));
  if (!vars.length) return undefined;

  const { descriptor, templateAst } = parseSfc(source);
  if (!templateAst) return undefined;
  const script = [descriptor?.script?.content, descriptor?.scriptSetup?.content].filter(Boolean).join("\n");
  const openers = openerFunctions(script, vars);

  const assigns = new RegExp(
    `\\b(?:${vars.map(esc).join("|")})(?:\\.value)?\\s*=(?!=)\\s*(?!false\\b|null\\b|undefined\\b|''|""|0\\b)`
  );
  const calls = openers.length ? new RegExp(`(?:^|[^\\w.$])(?:${openers.map(esc).join("|")})\\s*(?:\\(|$)`) : null;

  let found: { selector: string; label?: string } | undefined;
  walkElements(templateAst, (el) => {
    if (found) return;
    for (const ev of eventBindings(el)) {
      if (ev.event !== "click" || !ev.expression) continue;
      if (!assigns.test(ev.expression) && !(calls && calls.test(ev.expression))) continue;
      const label = staticTextOf(el).replace(/\s+/g, " ").trim() || staticAttr(el, "aria-label") || undefined;
      const selector = activatorSelector(staticAttr(el, "data-testid"), label);
      if (selector) {
        found = { selector, ...(label ? { label } : {}) };
        return;
      }
    }
  });
  return found;
}

/** Root identifiers a guard reads (`selected.value && !loading` → selected, loading). */
function gateVariables(expr: string): string[] {
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile("g.ts", `(${expr});`, ts.ScriptTarget.Latest, true);
  } catch {
    return [];
  }
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const isPropName = ts.isPropertyAccessExpression(p) && p.name === n;
      if (!isPropName && !["undefined", "true", "false", "null"].includes(n.text)) out.add(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...out];
}

/** Script functions that set one of `vars` to a non-falsy value. */
function openerFunctions(script: string, vars: string[]): string[] {
  if (!script) return [];
  const sf = ts.createSourceFile("s.ts", script, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  const setsVar = (body: ts.Node): boolean => {
    let hit = false;
    const visit = (n: ts.Node): void => {
      if (hit) return;
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const l = n.left;
        const target =
          ts.isIdentifier(l) ? l.text
          : ts.isPropertyAccessExpression(l) && l.name.text === "value" && ts.isIdentifier(l.expression) ? l.expression.text
          : undefined;
        const r = n.right;
        const falsy =
          r.kind === ts.SyntaxKind.FalseKeyword || r.kind === ts.SyntaxKind.NullKeyword ||
          (ts.isIdentifier(r) && r.text === "undefined");
        if (target && vars.includes(target) && !falsy) hit = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
    return hit;
  };
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body && setsVar(n.body)) names.push(n.name.text);
    if (
      ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) &&
      setsVar(n.initializer.body)
    ) {
      names.push(n.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
}

/** capture_flow steps that walk the plan: open the page, then one click per state gate. */
export function captureFlowSkeleton(plan: MountPlan, url: string): Array<Record<string, unknown>> {
  const steps: Array<Record<string, unknown>> = [
    {
      url,
      label: `open ${plan.route.component}`,
      ...(plan.revealActions.length ? { actions: plan.revealActions } : {}),
    },
  ];
  for (let i = 1; i < plan.hops.length; i++) {
    const hop = plan.hops[i];
    if (hop.revealed) continue;
    const parent = plan.hops[i - 1].component;
    steps.push({
      label: `reveal ${hop.component} (${hop.gate})`,
      actions: [
        {
          type: "click",
          selector: hop.activator?.selector ?? `<TODO: the control in ${parent} that opens ${hop.gate}>`,
        },
      ],
    });
  }
  return steps;
}

function norm(rel: string): string {
  return CacheManager.normalizeModulePath(rel);
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
