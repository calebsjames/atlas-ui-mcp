import { test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import type { AddressInfo, Socket } from "net";
import type { Browser, Page } from "playwright";
import { describeAction, isPlaywrightSyntax, parseWithin, runAction } from "./actions.js";
import type { FlowAction } from "./types.js";

/**
 * Click steps cost Studio repeated runs for two reasons that the error never
 * named. (1) `within` composes `selector` into a CSS `:has(...)`, so a
 * selector in Playwright syntax (`text=Open`, `button >> nth=0`) died with a
 * CSS parse error. (2) A click on an `aria-disabled="true"` control timed out
 * with a retry log and no hint: Playwright's actionability check honours
 * aria-disabled, and `press` (which does not) was the way through.
 */

const PAGE = `<!doctype html><title>idle</title>
<table><tbody>
${["RK-001", "RK-002", "RK-003"]
  .map(
    (id) => `<tr class="row" data-id="${id}"><td>${id}</td><td>
  <button class="open" onclick="document.title='open ${id}'">Open Kit</button>
  <button class="del" onclick="document.title='delete ${id}'">Delete</button></td></tr>`
  )
  .join("\n")}
</tbody></table>
<button id="soft" aria-disabled="true">Save draft</button>
<div aria-disabled="true" id="group"><button id="inherited">Inherited</button></div>
<button id="hard" disabled>Submit</button>
<script>
  const soft = document.getElementById("soft");
  soft.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") document.title = "soft activated by " + (e.key === " " ? "Space" : e.key); });
</script>`;

async function withPage(fn: (page: Page) => Promise<void>): Promise<void> {
  const sockets = new Set<Socket>();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { chromium } = await import("playwright");
  const browser: Browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    await fn(page);
  } finally {
    await browser.close();
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const click = (selector: string, within?: string, timeoutMs = 3000): FlowAction => ({
  type: "click",
  selector,
  ...(within ? { within } : {}),
  timeoutMs,
});

test("within + a Playwright-syntax selector clicks that row's control (no CSS parse error)", async () => {
  await withPage(async (page) => {
    const cases: Array<[string, string, string]> = [
      ["text=Open Kit", "RK-003", "open RK-003"],
      ['role=button[name="Delete"]', "RK-002", "delete RK-002"],
      ["button >> nth=1", "RK-001", "delete RK-001"],
      ["button >> nth=0", "RK-003", "open RK-003"],
      ['"Open Kit"', "RK-002", "open RK-002"],
      ["xpath=.//button[contains(., 'Delete')]", "RK-003", "delete RK-003"],
    ];
    for (const [selector, within, title] of cases) {
      await page.evaluate(() => (document.title = "idle"));
      await runAction(page, click(selector, within));
      assert.equal(await page.title(), title, `${selector} within ${within}`);
    }
  });
});

test("within still scopes a plain CSS selector to the innermost row", async () => {
  await withPage(async (page) => {
    await runAction(page, click('button:has-text("Open Kit")', "RK-002"));
    assert.equal(await page.title(), "open RK-002");
    await runAction(page, click(".del", "rk-003"));
    assert.equal(await page.title(), "delete RK-003", "text is matched case-insensitively, as before");
  });
});

test("within written as text=… is text; written as a selector it is the container", async () => {
  await withPage(async (page) => {
    await runAction(page, click(".open", "text=RK-003"));
    assert.equal(await page.title(), "open RK-003");
    await runAction(page, click(".open", 'text="RK-001"'));
    assert.equal(await page.title(), "open RK-001");
    await runAction(page, click("text=Delete", "text=/rk-00[2]/i"));
    assert.equal(await page.title(), "delete RK-002");

    await runAction(page, click(".del", 'css=tr[data-id="RK-001"]'));
    assert.equal(await page.title(), "delete RK-001");
    await runAction(page, click(".open", "tr.row >> nth=2"));
    assert.equal(await page.title(), "open RK-003");
    await runAction(page, click("text=Delete", 'tr:has-text("RK-002") >> nth=0'));
    assert.equal(await page.title(), "delete RK-002");
  });

  assert.deepEqual(parseWithin("RK-003"), { text: "RK-003" });
  assert.deepEqual(parseWithin("tr.row"), { text: "tr.row" }, "a bare CSS-looking string stays text");
  assert.deepEqual(parseWithin("text=RK-003"), { text: "RK-003" });
  assert.deepEqual(parseWithin("css=tr.row"), { selector: "css=tr.row" });
  assert.ok(isPlaywrightSyntax("text=Save") && isPlaywrightSyntax("a >> nth=0") && isPlaywrightSyntax("//button"));
  assert.ok(!isPlaywrightSyntax('button:has-text("Save")') && !isPlaywrightSyntax("[role=button]"));
});

test("a within that matches no container says so, and how to scope by selector", async () => {
  await withPage(async (page) => {
    await assert.rejects(runAction(page, click(".open", "RK-999", 600)), (err: Error) => {
      assert.match(err.message, /no element contains both that text and a match for \.open/);
      assert.match(err.message, /\.open alone matches 3 element\(s\)/);
      assert.match(err.message, /"within": "css=tr\.selected"/);
      return true;
    });
  });
});

test("a click that times out on an aria-disabled control says so and names press", async () => {
  await withPage(async (page) => {
    await assert.rejects(runAction(page, click("#soft", undefined, 800)), (err: Error) => {
      assert.match(err.message, /aria-disabled="true"/);
      assert.match(err.message, /disabled by\s+design/);
      assert.match(err.message, /\{"type":"press","selector":"#soft","key":"Space"\}/);
      assert.match(err.message, /Timeout/, "the original Playwright message is kept");
      return true;
    });
    // The named alternative works.
    await runAction(page, { type: "press", selector: "#soft", key: "Space" });
    assert.equal(await page.title(), "soft activated by Space");
  });
});

test("aria-disabled on an ancestor is named; a natively disabled control is not offered press", async () => {
  await withPage(async (page) => {
    await assert.rejects(runAction(page, click("#inherited", undefined, 800)), (err: Error) => {
      assert.match(err.message, /aria-disabled="true" on its ancestor <div#group>/);
      return true;
    });
    await assert.rejects(runAction(page, click("#hard", undefined, 800)), (err: Error) => {
      assert.match(err.message, /natively disabled/);
      assert.doesNotMatch(err.message, /"type":"press"/);
      return true;
    });
    await assert.rejects(runAction(page, { type: "fill", selector: "#hard", text: "x", timeoutMs: 800 }), /natively disabled/);
  });
});

test("an enabled click still reports nothing extra", async () => {
  await withPage(async (page) => {
    await runAction(page, click(".open"));
    assert.equal(await page.title(), "open RK-001");
    assert.equal(describeAction(click("text=Open Kit", "RK-003")), 'click text=Open Kit within "RK-003"');
  });
});
