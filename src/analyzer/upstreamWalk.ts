import path from "path";
import type { CacheManager } from "../cache/cacheManager.js";
import type { Component } from "../types.js";

/**
 * The upstream dependency walk shared by whats_affected (impact) and the
 * runtime tools' mount-path resolution (render_component / verify_data_flow
 * reaching a modal or tab through its nearest routed ancestor).
 */

/** Path-keyed: forward slashes regardless of platform. */
function toForwardSlashes(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * Breadth-first walk from the changed items to everything that depends on them,
 * following importers, JSX renderers (both by real name and fileAlias), and —
 * for hooks — the components whose `hooks` list references them. Keyed by
 * relativePath so shared nodes are visited once, at their shortest distance.
 */
export interface VisitedNode {
  item: Component;
  distance: number;
  /** The changed file this node traces back to (first one to reach it). */
  seed?: Component;
  /** The immediate downstream node whose edge pulled this one in. */
  parent?: Component;
  /** Template guard this node mounts `parent` behind, when it does. */
  gate?: string;
}

/** How `parent` gates its template mount of `child`, when it does. */
export function renderGate(parent: Component, child: Component): string | undefined {
  const conditions =
    parent.childComponentRendering?.[child.name] ??
    (child.fileAlias ? parent.childComponentRendering?.[child.fileAlias] : undefined);
  if (!conditions) return undefined;
  const parts: string[] = [];
  if (conditions.vIf) parts.push(`v-if: ${conditions.vIf}`);
  if (conditions.vShow) parts.push(`v-show: ${conditions.vShow}`);
  if (conditions.vFor) parts.push(`v-for: ${conditions.vFor}`);
  return parts.length ? parts.join("; ") : undefined;
}

export function bfsUpstream(
  seeds: Component[],
  cache: CacheManager,
  hookUsers: Map<string, Component[]>,
  maxDistance: number = 5
): Map<string, VisitedNode> {
  const visited = new Map<string, VisitedNode>();
  const queue: VisitedNode[] = [];

  for (const seed of seeds) {
    const key = toForwardSlashes(seed.relativePath);
    if (!visited.has(key)) {
      const node: VisitedNode = { item: seed, distance: 0, seed };
      visited.set(key, node);
      queue.push(node);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.distance >= maxDistance) continue;

    for (const user of upstreamUsers(current.item, cache, hookUsers)) {
      const key = toForwardSlashes(user.relativePath);
      if (visited.has(key)) continue;
      const gate = renderGate(user, current.item);
      const next: VisitedNode = {
        item: user,
        distance: current.distance + 1,
        seed: current.seed,
        parent: current.item,
        ...(gate ? { gate } : {}),
      };
      visited.set(key, next);
      queue.push(next);
    }
  }

  return visited;
}

/** Components that import, render, or hook-consume the given item. */
export function upstreamUsers(
  item: Component,
  cache: CacheManager,
  hookUsers: Map<string, Component[]>
): Component[] {
  const names = [item.name];
  if (item.fileAlias) names.push(item.fileAlias);

  const users: Component[] = [];
  for (const name of names) {
    users.push(...cache.getImportersOf(name));
    users.push(...cache.getRenderersOf(name));
  }

  // Path-keyed importers: catches files that import only a NAMED export
  // (e.g. `updateClockOffset` from useTokenRefreshTimer) — the name-keyed
  // lookup above misses those entirely and skews distances.
  users.push(...cache.getImportersOfFile(item.relativePath));

  if (item.architectureLayer === "hook" || item.name.startsWith("use")) {
    for (const name of names) {
      users.push(...(hookUsers.get(name.toLowerCase()) || []));
    }
  }

  return users;
}

