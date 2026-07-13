import type { ViewContainer } from "./viewContainer.js";
import { extractVueViewContainer } from "./vueViewContainer.js";
import { extractReactViewContainer } from "./reactViewContainer.js";

/**
 * Run the view-container extractor matching a file's framework, chosen by
 * extension (`.vue` → Vue, `.jsx`/`.tsx`/`.js`/`.ts` → React). The single place
 * that maps a file to its extractor, shared by get_section_map and the runtime
 * section-reveal engine so the two never drift on which framework a file is.
 */
export function extractViewContainer(
  source: string,
  componentName: string,
  filePath: string
): ViewContainer | null {
  if (filePath.endsWith(".vue")) return extractVueViewContainer(source, componentName);
  if (/\.[jt]sx?$/.test(filePath)) return extractReactViewContainer(source, componentName);
  return null;
}
