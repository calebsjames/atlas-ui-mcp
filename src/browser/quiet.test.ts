import { test } from "node:test";
import assert from "node:assert/strict";
import { blockingRequests, describeInflight, isLongLivedRequest, matchesUrlPattern } from "./quiet.js";

test("streams are long-lived by resource type, Accept or Content-Type", () => {
  assert.ok(isLongLivedRequest({ url: "ws://x/socket", resourceType: "websocket" }));
  assert.ok(isLongLivedRequest({ url: "http://x/e", resourceType: "eventsource" }));
  assert.ok(isLongLivedRequest({ url: "http://x/rt", resourceType: "fetch", accept: "text/event-stream" }));
  assert.ok(isLongLivedRequest({ url: "http://x/rt", resourceType: "fetch", contentType: "text/event-stream; charset=utf-8" }));
  assert.ok(!isLongLivedRequest({ url: "http://x/api/projects", resourceType: "fetch", accept: "application/json" }));
});

test("idleIgnore patterns are substrings, or globs when they contain *", () => {
  assert.ok(matchesUrlPattern("http://h/api/poll?x=1", "/api/poll"));
  assert.ok(matchesUrlPattern("http://h/v2/updates/long", "*/updates/*"));
  assert.ok(!matchesUrlPattern("http://h/api/projects", "*/updates/*"));
  assert.ok(isLongLivedRequest({ url: "http://h/api/poll", resourceType: "fetch" }, ["/api/poll"]));
});

test("a request older than longPollMs stops blocking; the stall report names what is open", () => {
  const now = 100_000;
  const inflight = [
    { method: "GET", url: "http://h/api/a?q=1", resourceType: "fetch", start: now - 200, longLived: false },
    { method: "GET", url: "http://h/api/poll", resourceType: "fetch", start: now - 9_000, longLived: false },
    { method: "GET", url: "http://h/rt", resourceType: "fetch", start: now - 50_000, longLived: true },
  ];
  const blocking = blockingRequests(inflight, now, { longPollMs: 8_000 });
  assert.deepEqual(blocking.map((r) => r.url), ["http://h/api/a?q=1"]);
  const lines = describeInflight(inflight, now);
  assert.equal(lines.length, 3);
  assert.ok(lines.some((l) => l.includes("http://h/rt") && l.includes("stream/ignored")));
  assert.ok(lines.every((l) => !l.includes("?q=1")), "query strings are dropped");
});
