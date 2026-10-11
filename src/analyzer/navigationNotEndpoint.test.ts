import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { analyzeServiceOrAdapter } from "./layerAnalyzers.js";

/**
 * F15: inside service/adapter files the wrapper heuristic treated ANY
 * path-shaped string argument as an endpoint, so
 * get_hook_detail("useImpersonation") reported apiEndpoints ["/home"] — the
 * `router.push("/home")` in stopImpersonation.
 */

const SOURCE = `
import router from "@/router";
import { useRouter } from "vue-router";
export function stopImpersonation() {
  router.push("/home");
  router.replace({ path: "/landing" });
  window.location.assign("/login");
  location.replace("/bye");
  window.open("/docs/help");
  return apiClient.post("/auth/stop-impersonation", {});
}
export function useImpersonation() {
  const r = useRouter();
  r.push({ path: "/home", query: { view: "x" } });
  this.$router.push("/elsewhere");
  return authedJson("GET", "/auth/impersonation");
}
`;

test("router navigation and location changes are not API endpoints", () => {
  const sf = ts.createSourceFile("impersonationService.ts", SOURCE, ts.ScriptTarget.Latest, true);
  const result = analyzeServiceOrAdapter(sf, SOURCE);
  assert.deepEqual(
    [...(result.apiEndpoints ?? [])].sort(),
    ["GET /auth/impersonation", "POST /auth/stop-impersonation"]
  );
  assert.deepEqual(result.endpointsByMethod?.stopImpersonation, ["POST /auth/stop-impersonation"]);
});
