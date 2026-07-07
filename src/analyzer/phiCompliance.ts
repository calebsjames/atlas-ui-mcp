import ts from "typescript";
import type { PhiComplianceInfo } from "../types.js";

/**
 * PHI-compliance heuristics (opt-in via config.phiCompliance.enabled):
 * uncached queries, PHI-adjacent console logging, and web-storage usage.
 */

function findZeroValuedProperties(
  callNode: ts.CallExpression,
  sourceFile: ts.SourceFile,
  propNames: string[]
): Set<string> {
  const found = new Set<string>();
  for (const arg of callNode.arguments) {
    if (!ts.isObjectLiteralExpression(arg)) continue;
    for (const prop of arg.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
      if (propNames.includes(prop.name.text) && prop.initializer.getText(sourceFile) === "0") {
        found.add(prop.name.text);
      }
    }
  }
  return found;
}

function isConsoleCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "console"
  );
}

export function checkPhiCompliance(sourceFile: ts.SourceFile): PhiComplianceInfo {
  const violations: string[] = [];
  let hasUseQuery = false;
  let hasZeroCacheTime = false;
  let hasZeroStaleTime = false;
  let hasConsoleLogNearPhi = false;
  let hasLocalStorageUsage = false;
  let hasSessionStorageUsage = false;

  const visit = (node: ts.Node) => {
    // Detect useQuery calls and check their options
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useQuery") {
      hasUseQuery = true;
      const zeroPropNames = findZeroValuedProperties(node, sourceFile, ["gcTime", "staleTime"]);
      if (zeroPropNames.has("gcTime")) hasZeroCacheTime = true;
      if (zeroPropNames.has("staleTime")) hasZeroStaleTime = true;
    }

    // Detect console.log with PHI-related variables
    if (isConsoleCall(node)) {
      const argsText = node.arguments.map((a) => a.getText(sourceFile).toLowerCase()).join(" ");
      if (/patient|phi|mrn|ssn|dob/.test(argsText)) {
        hasConsoleLogNearPhi = true;
      }
    }

    // Detect localStorage/sessionStorage usage
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "localStorage") hasLocalStorageUsage = true;
      if (node.expression.text === "sessionStorage") hasSessionStorageUsage = true;
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (hasUseQuery && !hasZeroCacheTime) {
    violations.push("useQuery without gcTime: 0 - PHI may be cached");
  }
  if (hasUseQuery && !hasZeroStaleTime) {
    violations.push("useQuery without staleTime: 0 - PHI may be stale-cached");
  }
  if (hasConsoleLogNearPhi) {
    violations.push("console.log may contain PHI data");
  }
  if (hasLocalStorageUsage) {
    violations.push("localStorage usage detected - PHI must not be stored in localStorage");
  }
  if (hasSessionStorageUsage) {
    violations.push("sessionStorage usage detected - PHI must not be stored in sessionStorage");
  }

  return {
    hasZeroCacheTime: hasZeroCacheTime || !hasUseQuery,
    hasZeroStaleTime: hasZeroStaleTime || !hasUseQuery,
    hasConsoleLogNearPhi,
    hasLocalStorageUsage,
    hasSessionStorageUsage,
    violations,
  };
}
