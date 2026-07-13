import { test } from "node:test";
import assert from "node:assert/strict";
import { isApiRequest, summarizeJson, summarizeJsonBody } from "./network.js";

/**
 * The body summarizer must count rows without knowing any app's field names —
 * only universal JSON structure plus a fixed set of ecosystem envelope keys —
 * and must always report `rowsFrom` so a wrong guess is visible, not silent.
 */

test("top-level array counts directly, tagged '$'", () => {
  assert.deepEqual(summarizeJson([1, 2, 3]), { rowCount: 3, rowsFrom: "$" });
  assert.deepEqual(summarizeJson([]), { rowCount: 0, rowsFrom: "$" });
});

test("envelope keys are counted in precedence order", () => {
  assert.deepEqual(summarizeJson({ data: [1, 2] }), { rowCount: 2, rowsFrom: "data" });
  assert.deepEqual(summarizeJson({ results: [1, 2, 3] }), { rowCount: 3, rowsFrom: "results" });
  assert.deepEqual(summarizeJson({ content: [1] }), { rowCount: 1, rowsFrom: "content" });
  // Spring/GraphQL flavours.
  assert.deepEqual(summarizeJson({ edges: [1, 2] }), { rowCount: 2, rowsFrom: "edges" });
  // `data` wins over `results` when both are arrays.
  assert.deepEqual(summarizeJson({ data: [1], results: [1, 2] }), { rowCount: 1, rowsFrom: "data" });
});

test("sole array property is used even under an unknown key", () => {
  assert.deepEqual(summarizeJson({ scopedProjects: [1, 2, 3, 4] }), {
    rowCount: 4,
    rowsFrom: "scopedProjects",
  });
});

test("ambiguous multi-array object without an envelope key yields no rowCount", () => {
  // Two arrays, neither a known envelope key — refuse to guess.
  assert.equal(summarizeJson({ foo: [1], bar: [1, 2] }), null);
});

test("pagination total is reported alongside the page's row count", () => {
  assert.deepEqual(summarizeJson({ total: 1578, data: [1, 2, 3] }), {
    rowCount: 3,
    rowsFrom: "data",
    totalCount: 1578,
  });
  // Django-style { count, results }.
  assert.deepEqual(summarizeJson({ count: 1910, results: [1, 2] }), {
    rowCount: 2,
    rowsFrom: "results",
    totalCount: 1910,
  });
});

test("single-level object wrapper is unwrapped, key path preserved", () => {
  assert.deepEqual(summarizeJson({ data: { items: [1, 2, 3] } }), {
    rowCount: 3,
    rowsFrom: "data.items",
  });
  // A total outside the wrapper is carried up.
  assert.deepEqual(summarizeJson({ total: 9, data: { items: [1, 2] } }), {
    rowCount: 2,
    rowsFrom: "data.items",
    totalCount: 9,
  });
});

test("a total with no collection still reports (rowCount stays absent)", () => {
  assert.deepEqual(summarizeJson({ totalElements: 42 }), { totalCount: 42 });
});

test("scalars, objects with no arrays, and non-JSON return null", () => {
  assert.equal(summarizeJson(5), null);
  assert.equal(summarizeJson("hi"), null);
  assert.equal(summarizeJson(null), null);
  assert.equal(summarizeJson({ id: 1, name: "x" }), null);
  assert.equal(summarizeJsonBody(Buffer.from("not json")), null);
});

test("summarizeJsonBody parses a buffer", () => {
  assert.deepEqual(summarizeJsonBody(Buffer.from(JSON.stringify({ data: [1, 2] }))), {
    rowCount: 2,
    rowsFrom: "data",
  });
});

test("isApiRequest classifies xhr/fetch and /api/ URLs only", () => {
  assert.equal(isApiRequest({ resourceType: "xhr", url: "https://x/y" }), true);
  assert.equal(isApiRequest({ resourceType: "fetch", url: "https://x/y" }), true);
  assert.equal(isApiRequest({ resourceType: "document", url: "https://x/api/projects" }), true);
  assert.equal(isApiRequest({ resourceType: "image", url: "https://x/logo.png" }), false);
  assert.equal(isApiRequest({ resourceType: "stylesheet", url: "https://x/app.css" }), false);
});
