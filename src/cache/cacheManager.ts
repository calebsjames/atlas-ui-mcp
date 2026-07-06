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
  private layerIndex: Map<string, Component[]> = new Map();
  private importIndex: Map<string, Component[]> = new Map();
  private childIndex: Map<string, Component[]> = new Map();
  // Keyed by imported module PATH (workspace-relative, extensionless) — finds
  // importers even when they import a named export (e.g. `updateClockOffset`
  // from useTokenRefreshTimer) rather than the module's own name.
  private fileImportIndex: Map<string, Component[]> = new Map();

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
    return this.nameIndex.get(name.toLowerCase()) || [];
  }

  /**
   * O(1) lookup by architecture layer
   */
  getByLayer(layer: string): Component[] {
    return this.layerIndex.get(layer) || [];
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

  /** Forward slashes, no extension — the canonical key for module-path lookups. */
  private static normalizeModulePath(p: string): string {
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

  /**
   * Invalidate props cache for a file
   */
  invalidateProps(filePath: string): void {
    this.propCache.delete(filePath);
  }

  /**
   * Clear all caches
   */
  clearAll(): void {
    this.catalogCache = null;
    this.propCache.clear();
    this.clearIndexes();
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    catalogCached: boolean;
    propsCacheSize: number;
    indexSizes: {
      name: number;
      layer: number;
      import: number;
      child: number;
    };
  } {
    return {
      catalogCached: this.catalogCache !== null,
      propsCacheSize: this.propCache.size,
      indexSizes: {
        name: this.nameIndex.size,
        layer: this.layerIndex.size,
        import: this.importIndex.size,
        child: this.childIndex.size,
      },
    };
  }

  /**
   * Rebuild all indexes from catalog
   */
  private addToIndex(index: Map<string, Component[]>, key: string, component: Component): void {
    if (!index.has(key)) {
      index.set(key, []);
    }
    index.get(key)!.push(component);
  }

  private clearIndexes(): void {
    this.nameIndex.clear();
    this.layerIndex.clear();
    this.importIndex.clear();
    this.childIndex.clear();
    this.fileImportIndex.clear();
  }

  private rebuildIndexes(catalog: ComponentCatalog): void {
    this.clearIndexes();

    for (const component of catalog.components) {
      this.addToIndex(this.nameIndex, component.name.toLowerCase(), component);
      // Also index by fileAlias (when defineComponent name differs from filename)
      if (component.fileAlias) {
        this.addToIndex(this.nameIndex, component.fileAlias.toLowerCase(), component);
      }
      this.addToIndex(this.layerIndex, component.architectureLayer, component);

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
