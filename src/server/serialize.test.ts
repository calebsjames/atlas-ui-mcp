import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeResult } from "./serialize.js";

/**
 * F10: every result was pretty-printed (`JSON.stringify(data, null, 2)`) with
 * empty arrays and the absolute `path` of every node — ~38% of a
 * get_component_detail payload was whitespace, `[]` and a path the caller
 * already has as `relativePath`.
 */

test("compact: no indentation, nested empty arrays and absolute workspace paths dropped", () => {
  const root = "/ws/app";
  const out = serializeResult(
    {
      name: "Card",
      path: "/ws/app/src/components/Card.vue",
      relativePath: "src/components/Card.vue",
      hooks: [],
      imports: [{ source: "vue", names: [] }],
      apiCalls: [{ method: "GET", path: "/api/cards" }],
      screenshotPath: "/ws/app/.atlas-ui/captures/x.png",
    },
    { workspaceRoot: root }
  );
  assert.ok(!out.includes("\n"), "single line");
  const parsed = JSON.parse(out);
  assert.equal(parsed.path, undefined, "absolute node path dropped");
  assert.equal(parsed.relativePath, "src/components/Card.vue");
  assert.equal(parsed.hooks, undefined);
  assert.deepEqual(parsed.imports, [{ source: "vue" }]);
  assert.equal(parsed.apiCalls[0].path, "/api/cards", "a URL path is not a workspace path");
  assert.ok(parsed.screenshotPath, "screenshot paths are kept — the caller opens them");
});

test("top-level answer arrays survive when empty — emptiness is the answer", () => {
  const parsed = JSON.parse(serializeResult({ usages: [], chains: [], unexpectedApiCalls: [], hooks: [] }));
  assert.deepEqual(parsed.usages, []);
  assert.deepEqual(parsed.chains, []);
  assert.deepEqual(parsed.unexpectedApiCalls, []);
  assert.equal(parsed.hooks, undefined);
});
