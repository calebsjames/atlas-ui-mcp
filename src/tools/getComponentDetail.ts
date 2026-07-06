import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { PropParser } from "../parser/propParser.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { AmbiguousMatch, Component, ComponentProps } from "../types.js";
import { ensureCatalog, isAmbiguousMatch, resolveByName } from "./shared.js";

export interface ComponentDetail extends Component {
  props?: ComponentProps;
}

/**
 * Get detailed information about a specific component.
 * Uses indexed cache for O(1) lookup. When a name matches multiple files and
 * `file` fails to narrow to one, returns an AmbiguousMatch rather than silently
 * picking the first candidate.
 */
export async function getComponentDetail(
  args: { name: string; file?: string },
  scanner: ComponentScanner,
  parser: PropParser,
  cache: CacheManager
): Promise<ComponentDetail | AmbiguousMatch | null> {
  const { name, file } = args;
  await ensureCatalog(scanner, cache);

  const resolved = resolveByName(cache.getByName(name), name, file);
  if (resolved === null) return null;
  if (isAmbiguousMatch(resolved)) return resolved;

  const component = resolved;

  try {
    const props = await parser.parseFile(component.path);
    return {
      ...component,
      props: props || undefined,
    };
  } catch {
    return component;
  }
}
