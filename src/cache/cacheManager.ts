import crypto from "crypto";
import type { ComponentCatalog, ComponentProps, Component } from "../types.js";

/**
 * Cache Manager
 * In-memory cache with indexing for O(1) lookups and content-hash invalidation
 */
export class CacheManager {
  private catalogCache: ComponentCatalog | null = null;
  private propCache: Map<
    string,
    { hash: string; props: ComponentProps | null }
  > = new Map();

  // Indexes for O(1) lookups (rebuilt on catalog change)
  private nameIndex: Map<string, Component[]> = new Map();
  private importIndex: Map<string, Component[]> = new Map();
  private childIndex: Map<string, Component[]> = new Map();
  // Keyed by imported module PATH (workspace-relative, extensionless) — finds
  // importers even when they import a named export (e.g. `updateClockOffset`
  // from useTokenRefreshTimer) rather than the module's own name.
  private fileImportIndex: Map<string, Component[]> = new Map();
  // Keyed by the component's own module PATH (workspace-relative, extensionless)
  // — resolves a dependency edge to the FILE it points at, so a same-named type,
  // library export, or unrelated component can't masquerade as the target.
  private pathIndex: Map<string, Component[]> = new Map();
  // Keyed by EVERY exported symbol name (not just the node's primary name) —
  // consulted only when the primary name index misses, so a non-first export
  // (e.g. `useLogin`) is reachable without shadowing a real component that owns
  // that name as its primary.
  private exportIndex: Map<string, Component[]> = new Map();

  /**
   * Get cached catalog
   */
  getCatalog(): ComponentCatalog | null {
    return this.catalogCache;
  }

  /**
   * Set catalog cache and rebuild indexes
   */
  setCatalog(catalog: ComponentCatalog): void {
    this.catalogCache = catalog;
    this.rebuildIndexes(catalog);
  }

  /**
   * Invalidate catalog cache and indexes
   */
  invalidateCatalog(): void {
    this.catalogCache = null;
    this.clearIndexes();
  }

  /**
   * O(1) lookup by component name (case-insensitive)
   */
  getByName(name: string): Component[] {
    const key = name.toLowerCase();
    const primary = this.nameIndex.get(key);
    // Primary (node name / fileAlias) wins; secondary exports are a fallback so
    // they never shadow a component that owns the name as its primary.
    if (primary && primary.length > 0) return primary;
    return this.exportIndex.get(key) || [];
  }

  /**
   * O(1) lookup: find all components that import a given name
   */
  getImportersOf(name: string): Component[] {
    return this.importIndex.get(name.toLowerCase()) || [];
  }

  /**
   * O(1) lookup: find all components that render a given child
   */
  getRenderersOf(name: string): Component[] {
    return this.childIndex.get(name.toLowerCase()) || [];
  }

  /**
   * O(1) lookup: find all components whose imports resolve to the given FILE
   * (workspace-relative path, extension optional). Catches named-export
   * imports the name index misses.
   */
  getImportersOfFile(relativePath: string): Component[] {
    const key = CacheManager.normalizeModulePath(relativePath);
    const direct = this.fileImportIndex.get(key) || [];
    // A `<dir>/index.*` file is also importable as `<dir>`.
    const indexStripped = key.replace(/\/index$/, "");
    if (indexStripped !== key) {
      const viaDir = this.fileImportIndex.get(indexStripped) || [];
      return [...direct, ...viaDir];
    }
    return direct;
  }

  /**
   * O(1) lookup: catalog nodes whose own file IS the given module path
   * (workspace-relative, extension optional). A directory import (`@/x`) also
   * matches that directory's `index.*` barrel.
   */
  getByPath(relativePath: string): Component[] {
    const key = CacheManager.normalizeModulePath(relativePath);
    return [
      ...(this.pathIndex.get(key) || []),
      ...(this.pathIndex.get(`${key}/index`) || []),
    ];
  }

  /**
   * Resolve one import statement to the catalog nodes it actually points at,
   * by FILE — never by bare name. This is what keeps `import { Discussion }`
   * (a type) or `import { ErrorBoundary } from 'react-error-boundary'` (a
   * library) from being mistaken for a same-named page/component.
   *
   *   1. Exact file match on the resolved path (covers direct + `index` imports).
   *   2. Barrel fallback: when the path is a directory that re-exports (so no
   *      node sits exactly on it), accept a node INSIDE that directory whose
   *      name is one of the imported symbols — e.g. `@/components/ui/button`
   *      re-exporting `Button` from `button/button.tsx`.
   *   3. External imports (no resolvedPath) resolve to nothing.
   */
  resolveImportedNodes(imp: { names: string[]; resolvedPath?: string }): Component[] {
    if (!imp.resolvedPath) return [];
    const exact = this.getByPath(imp.resolvedPath);
    if (exact.length) return exact;

    const dirKey = CacheManager.normalizeModulePath(imp.resolvedPath);
    const out = new Map<string, Component>();
    for (const name of imp.names) {
      for (const c of this.getByName(name)) {
        const k = CacheManager.normalizeModulePath(c.relativePath);
        if (k === dirKey || k.startsWith(`${dirKey}/`)) out.set(c.relativePath, c);
      }
    }
    return [...out.values()];
  }

  /** Forward slashes, no extension — the canonical key for module-path lookups. */
  static normalizeModulePath(p: string): string {
    return p
      .split("\\")
      .join("/")
      .replace(/\.(vue|tsx|ts|jsx|js)$/, "")
      .toLowerCase();
  }

  /**
   * Get cached props for a file
   */
  async getProps(
    filePath: string,
    content: string
  ): Promise<ComponentProps | null | undefined> {
    const hash = this.hashContent(content);
    const cached = this.propCache.get(filePath);

    if (cached && cached.hash === hash) {
      return cached.props;
    }

    return undefined; // Cache miss
  }

  /**
   * Set props cache for a file
   */
  setProps(
    filePath: string,
    content: string,
    props: ComponentProps | null
  ): void {
    const hash = this.hashContent(content);
    this.propCache.set(filePath, { hash, props });
  }

  private addToIndex(index: Map<string, Component[]>, key: string, component: Component): void {
    if (!index.has(key)) {
      index.set(key, []);
    }
    index.get(key)!.push(component);
  }

  private clearIndexes(): void {
    this.nameIndex.clear();
    this.importIndex.clear();
    this.childIndex.clear();
    this.fileImportIndex.clear();
    this.pathIndex.clear();
    this.exportIndex.clear();
  }

  private rebuildIndexes(catalog: ComponentCatalog): void {
    this.clearIndexes();

    for (const component of catalog.components) {
      this.addToIndex(this.nameIndex, component.name.toLowerCase(), component);
      // Also index by fileAlias (when defineComponent name differs from filename)
      if (component.fileAlias) {
        this.addToIndex(this.nameIndex, component.fileAlias.toLowerCase(), component);
      }

      this.addToIndex(
        this.pathIndex,
        CacheManager.normalizeModulePath(component.relativePath),
        component
      );

      for (const exportName of component.exportedNames || []) {
        this.addToIndex(this.exportIndex, exportName.toLowerCase(), component);
      }

      const importedNames = (component.imports || []).flatMap((imp) => imp.names);
      for (const name of importedNames) {
        this.addToIndex(this.importIndex, name.toLowerCase(), component);
      }

      for (const imp of component.imports || []) {
        if (!imp.resolvedPath) continue;
        this.addToIndex(
          this.fileImportIndex,
          CacheManager.normalizeModulePath(imp.resolvedPath),
          component
        );
      }

      for (const child of component.childComponents || []) {
        this.addToIndex(this.childIndex, child.toLowerCase(), component);
      }
    }
  }

  /**
   * Hash file content for cache key
   */
  private hashContent(content: string): string {
    return crypto.createHash("md5").update(content).digest("hex");
  }
}
