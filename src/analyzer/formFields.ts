import ts from "typescript";
import type { FormFieldInfo } from "../types.js";

/**
 * Form-control selector extraction shared by the JSX (AST) and Vue template
 * (regex) analyzers.
 */

/** Lowercase intrinsic elements we treat as drivable form controls. */
export const FORM_CONTROL_TAGS = new Set(["input", "select", "textarea", "button"]);

/**
 * Static string value of a JSX attribute, or undefined for dynamic ones.
 * Handles `attr="x"` and `attr={"x"}` / `attr={`x`}`; anything with an
 * expression (variable, call, template with substitutions) is skipped so we
 * never emit a selector we can't actually type into the browser.
 */
export function getJsxAttrStringValue(attr: ts.JsxAttribute): string | undefined {
  const init = attr.initializer;
  if (!init) return undefined; // valueless boolean attribute
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression) {
    const e = init.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  }
  return undefined;
}

export interface FormFieldParts {
  element: string;
  inputType?: string;
  name?: string;
  id?: string;
  testId?: string;
  label?: string;
}

/**
 * Build a FormFieldInfo, choosing the most specific stable selector available:
 * `#id` > `[data-testid="X"]` > `[name="X"]` > `tag[type="T"]` > bare tag.
 * Only fields with static string values reach here, so the selector is real.
 */
export function buildFormField(parts: FormFieldParts): FormFieldInfo {
  const { element, inputType, name, id, testId, label } = parts;

  let selector: string;
  if (id) selector = `#${id}`;
  else if (testId) selector = `[data-testid="${testId}"]`;
  else if (name) selector = `[name="${name}"]`;
  else if (inputType) selector = `${element}[type="${inputType}"]`;
  else selector = element;

  const field: FormFieldInfo = { selector, element };
  if (inputType) field.inputType = inputType;
  if (name) field.name = name;
  if (id) field.id = id;
  if (testId) field.testId = testId;
  if (label) field.label = label;
  return field;
}

/** Extract a form control's static attributes from a JSX element. */
export function extractJsxFormField(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  element: string
): FormFieldInfo {
  const parts: FormFieldParts = { element };
  let ariaLabel: string | undefined;
  let placeholder: string | undefined;

  for (const attr of node.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || !ts.isIdentifier(attr.name)) continue;
    const val = getJsxAttrStringValue(attr);
    if (val === undefined) continue; // skip dynamic attributes
    switch (attr.name.text) {
      case "type": parts.inputType = val; break;
      case "name": parts.name = val; break;
      case "id": parts.id = val; break;
      case "data-testid": parts.testId = val; break;
      case "aria-label": ariaLabel = val; break;
      case "placeholder": placeholder = val; break;
    }
  }

  parts.label = ariaLabel ?? placeholder;
  return buildFormField(parts);
}

/** Keep the first field per unique selector, capped at 25 per component. */
export function dedupeFormFields(fields: FormFieldInfo[]): FormFieldInfo[] {
  const bySelector = new Map<string, FormFieldInfo>();
  for (const f of fields) {
    if (!bySelector.has(f.selector)) bySelector.set(f.selector, f);
  }
  return Array.from(bySelector.values()).slice(0, 25);
}
