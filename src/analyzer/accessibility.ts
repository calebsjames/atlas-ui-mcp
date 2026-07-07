/**
 * Accessibility signal extraction. Regex over the raw content is fine here —
 * it's scanning HTML-like markup (JSX or Vue template) for attributes/tags.
 */

function uniqueSortedMatches(
  content: string,
  regex: RegExp,
  transform: (m: RegExpMatchArray) => string
): string[] {
  return Array.from(new Set(Array.from(content.matchAll(regex)).map(transform))).sort();
}

export function extractAccessibility(content: string) {
  const ariaAttributes = uniqueSortedMatches(content, /aria-(\w+)=/g, (m) => `aria-${m[1]}`);
  const roles = uniqueSortedMatches(content, /role="([^"]+)"/g, (m) => m[1]);

  const semanticTags = [
    "nav", "main", "section", "article", "aside",
    "header", "footer", "button", "form", "label",
    "fieldset", "legend",
  ];
  const semanticElements = semanticTags
    .filter((tag) => new RegExp(`<${tag}[\\s>]`, "gi").test(content))
    .sort();

  const keyboardChecks: [string, string][] = [
    ["onKeyDown", "onKeyDown"], ["onKeyPress", "onKeyPress"],
    ["onKeyUp", "onKeyUp"], ["tabIndex", "tabIndex="],
  ];
  const keyboardHandlers = keyboardChecks
    .filter(([, search]) => content.includes(search))
    .map(([name]) => name)
    .sort();

  const hasTestId = /data-testid=/.test(content);
  const hasScreenReaderSupport =
    /sr-only|visually-hidden|screen-reader/i.test(content) ||
    ariaAttributes.some(
      (attr) => attr.includes("aria-label") || attr.includes("aria-describedby")
    );

  return {
    ariaAttributes,
    roles,
    semanticElements,
    keyboardHandlers,
    hasTestId,
    hasScreenReaderSupport,
  };
}
