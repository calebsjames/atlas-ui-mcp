import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { PropParser } from "../parser/propParser.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { AmbiguousMatch, Component, ComponentProps } from "../types.js";
import {
  ensureCatalog,
  isAmbiguousMatch,
  nameNotFound,
  resolveName,
  symbolMatch,
  type AlsoMatched,
  type NameNotFound,
  type SymbolMatch,
} from "./shared.js";
import { findExportDeclaration } from "../analyzer/exportDeclaration.js";

export interface ComponentDetail extends Component, SymbolMatch {
  props?: ComponentProps;
  /** Declaration form of a secondary export (function, variable, class, …). */
  declarationKind?: string;
  /** Other catalog nodes the name matched; this answer auto-picked one (see resolveName). */
  alsoMatched?: AlsoMatched[];
}

const FILE_LEVEL =
  "name, line, description and exportType are this symbol's own; every other field " +
  "(hooks, imports, childComponents, stateVariables, apiEndpoints, adapterCalls, " +
  "dtosUsed, emits, testIds, formFields, accessibility, …) is FILE-level and may " +
  "describe a sibling export. Read the file to attribute them.";

/**
 * Get detailed information about a specific component.
 * Uses indexed cache for O(1) lookup. When a name matches multiple files and
 * `file` fails to narrow to one, returns an AmbiguousMatch rather than silently
 * picking the first candidate; an unknown name returns a NameNotFound with
 * close-match suggestions rather than a bare null.
 */
export async function getComponentDetail(
  args: { name: string; file?: string },
  scanner: ComponentScanner,
  parser: PropParser,
  cache: CacheManager
): Promise<ComponentDetail | AmbiguousMatch | NameNotFound> {
  const { name, file } = args;
  await ensureCatalog(scanner, cache);

  const resolved = resolveName(cache.getByName(name), name, file, { preferRenderable: true });
  if (resolved === null) return nameNotFound(name, cache);
  if (isAmbiguousMatch(resolved)) return resolved;

  const component = resolved.node;
  const also = resolved.alsoMatched ? { alsoMatched: resolved.alsoMatched } : {};
  const sym = { ...symbolMatch(component, name, FILE_LEVEL), ...also };

  if (!sym.isPrimaryExport && sym.matchedExport) {
    // Answer about the SYMBOL: its own line/JSDoc, not the primary export's.
    // Props are the file component's interface — meaningless for this export.
    const decl = await findExportDeclaration(component.path, sym.matchedExport);
    const { line: _line, description: _description, exportType: _exportType, ...fileLevel } = component;
    return {
      ...fileLevel,
      name: sym.matchedExport,
      ...sym,
      ...(decl ? { line: decl.line, declarationKind: decl.kind, exportType: "named" as const } : {}),
      ...(decl?.description ? { description: decl.description } : {}),
    };
  }

  try {
    const props = await parser.parseFile(component.path);
    return {
      ...component,
      ...sym,
      props: props || undefined,
    };
  } catch {
    return { ...component, ...sym };
  }
}
