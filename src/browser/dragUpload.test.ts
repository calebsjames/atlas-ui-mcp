import { test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import type { AddressInfo, Socket } from "net";
import { BrowserSession } from "./session.js";
import { FIXTURE_DIR, pickFixture, UPLOAD_FIXTURES } from "./upload.js";
import type { BrowserConfig } from "../types.js";

/**
 * Drag-reorder chips and a frame-scrubbing slider could not be checked in the
 * signed-in browser, and a fitting step sat behind a "two swing videos"
 * upload gate no agent could pass. `drag` uses real pointer input (so both
 * pointer-driven widgets and native HTML5 drag-and-drop work); `upload` sets
 * files on an input, or answers the file chooser a button opens, with a
 * bundled fixture picked by `accept` when no files are given.
 */

const PAGES: Record<string, string> = {
  // Pointer-driven: pointerdown/move/up with capture. No HTML5 drag events.
  "/slider": `<!doctype html><title>v0</title><body style="margin:0">
<div id="track" style="position:absolute;left:100px;top:100px;width:400px;height:10px;background:#ccc">
  <div id="thumb" style="position:absolute;left:0;top:-10px;width:30px;height:30px;background:#00f;touch-action:none"></div>
</div><script>
const thumb = document.getElementById("thumb"); let sx = null, sl = 0;
thumb.addEventListener("pointerdown", (e) => { sx = e.clientX; sl = thumb.offsetLeft; thumb.setPointerCapture(e.pointerId); });
thumb.addEventListener("pointermove", (e) => { if (sx == null) return; thumb.style.left = Math.max(0, Math.min(370, sl + e.clientX - sx)) + "px"; });
thumb.addEventListener("pointerup", () => { sx = null; document.title = "v" + thumb.offsetLeft; });
</script></body>`,
  // Native HTML5 drag-and-drop: the order changes only on a real drop carrying dataTransfer data.
  "/chips": `<!doctype html><title>abc</title><body style="margin:0"><ul id="list" style="list-style:none;padding:20px">
<li draggable="true" id="a" style="height:40px;background:#eee;margin:4px">A</li>
<li draggable="true" id="b" style="height:40px;background:#eee;margin:4px">B</li>
<li draggable="true" id="c" style="height:40px;background:#eee;margin:4px">C</li></ul><script>
for (const li of document.querySelectorAll("li")) {
  li.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", li.id));
  li.addEventListener("dragover", (e) => e.preventDefault());
  li.addEventListener("drop", (e) => {
    e.preventDefault();
    li.after(document.getElementById(e.dataTransfer.getData("text/plain")));
    document.title = [...document.querySelectorAll("li")].map((x) => x.id).join("");
  });
}
</script></body>`,
  // A hidden <input type=file> behind a styled label, plus a multi-file input.
  "/upload": `<!doctype html><title>none</title><body>
<label for="png" style="padding:8px;border:1px solid">Choose a PNG</label>
<input id="png" type="file" accept="image/png" style="display:none">
<input id="photos" type="file" accept="image/*,.heic,.heif" multiple>
<input id="csv" type="file" accept=".csv,.xlsx">
<script>
const show = (el) => el.addEventListener("change", () => {
  document.title = [...el.files].map((f) => f.name + ":" + f.type + ":" + f.size).join(",");
});
document.querySelectorAll("input").forEach(show);
</script></body>`,
  // The swing-video pattern: the button builds the input on the fly and
  // clicks it, so there is no input in the DOM to target. The page then
  // decodes the chosen video, which a fake .mp4 would fail.
  "/video": `<!doctype html><title>none</title><body>
<button id="add-video">Upload down-the-line video</button><script>
document.getElementById("add-video").addEventListener("click", () => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm";
  input.onchange = () => {
    const f = input.files[0];
    const v = document.createElement("video");
    v.muted = true;
    v.onloadeddata = () => { document.title = f.name + ":" + f.type + ":" + v.videoWidth + "x" + v.videoHeight; };
    v.onerror = () => { document.title = "undecodable:" + f.name; };
    v.src = URL.createObjectURL(f);
  };
  input.click();
});
</script></body>`,
};

async function withSession(fn: (s: BrowserSession, base: string, root: string) => Promise<void>): Promise<void> {
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGES[(req.url || "/").split("?")[0]] ?? "<title>404</title>");
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-dnd-"));
  const session = new BrowserSession(root, { devServerUrl: base, headless: true, outputDir: root } as BrowserConfig);
  try {
    await fn(session, base, root);
  } finally {
    await session.close();
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function step(session: BrowserSession, url: string, actions: unknown[]) {
  const [r] = await session.runFlow([{ label: "s", url, actions, noScreenshot: true }] as any, { requireAuth: false });
  return r;
}

test("drag by an offset moves a pointer-driven slider", async () => {
  await withSession(async (session, base) => {
    const r = await step(session, `${base}/slider`, [{ type: "drag", selector: "#thumb", to: { x: 150, y: 0 } }]);
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.title, "v150");
    assert.match(r.performed.at(-1)!, /^dragged #thumb by \(150, 0\) — from \(\d+, \d+\) to \(\d+, \d+\) in 12 steps$/);
  });
});

test("drag onto another element reorders an HTML5 drag-and-drop list", async () => {
  await withSession(async (session, base) => {
    const r = await step(session, `${base}/chips`, [{ type: "drag", selector: "#a", toSelector: "#c" }]);
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.title, "bca", "A was dropped on C (native drop with dataTransfer)");
    assert.match(r.performed.at(-1)!, /^dragged #a onto #c/);
  });
});

test("drag needs a destination and refuses a drop point off screen", async () => {
  await withSession(async (session, base) => {
    const none = await step(session, `${base}/slider`, [{ type: "drag", selector: "#thumb" }]);
    assert.match(none.error ?? "", /requires "toSelector" or "to"/);
    const far = await step(session, `${base}/slider`, [{ type: "drag", selector: "#thumb", to: { x: 5000, y: 0 } }]);
    assert.match(far.error ?? "", /outside the 1280x800 viewport/);
  });
});

test("upload without files picks the bundled fixture by accept (hidden input)", async () => {
  await withSession(async (session, base) => {
    const size = (await fs.stat(path.join(FIXTURE_DIR, "sample.png"))).size;
    const r = await step(session, `${base}/upload`, [{ type: "upload", selector: "#png" }]);
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.title, `sample.png:image/png:${size}`);
    assert.match(r.performed.at(-1)!, /uploaded sample\.png \(bundled fixture; accept "image\/png" matched image\/png\) via the file input to #png/);

    const photos = await step(session, `${base}/upload`, [{ type: "upload", selector: "#photos" }]);
    assert.match(photos.title, /^sample\.jpg:image\/jpeg:\d+$/, "image/* takes the JPEG");
  });
});

test("upload with explicit files (relative to the workspace root, several on a multiple input)", async () => {
  await withSession(async (session, base, root) => {
    await fs.writeFile(path.join(root, "a.png"), Buffer.from("not really a png"));
    await fs.writeFile(path.join(root, "b.png"), Buffer.from("nor this"));
    const r = await step(session, `${base}/upload`, [{ type: "upload", selector: "#photos", files: ["a.png", path.join(root, "b.png")] }]);
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.title, "a.png:image/png:16,b.png:image/png:8");

    const one = await step(session, `${base}/upload`, [{ type: "upload", selector: "#png", files: ["a.png", "b.png"] }]);
    assert.match(one.error ?? "", /2 files given, but the input takes one/);
    const missing = await step(session, `${base}/upload`, [{ type: "upload", selector: "#png", files: ["nope.png"] }]);
    assert.match(missing.error ?? "", /file\(s\) not found: .*nope\.png/);
  });
});

test("upload answers the file chooser a button opens, with a decodable MP4", async () => {
  await withSession(async (session, base) => {
    const r = await step(session, `${base}/video`, [{ type: "upload", selector: "#add-video" }]);
    assert.equal(r.error, undefined, r.error);
    // Wait for the page's own decode of the chosen file.
    const title = await (session as any).profiles.get("default").page.waitForFunction(
      () => document.title !== "none" && document.title
    ).then((h: any) => h.jsonValue());
    assert.equal(title, "sample.mp4:video/mp4:64x48", "the bundled MP4 is a real, decodable video");
    assert.match(r.performed.at(-1)!, /uploaded sample\.mp4 .* via the file chooser to #add-video/);
  });
});

test("upload with no matching fixture asks for files", async () => {
  await withSession(async (session, base) => {
    const r = await step(session, `${base}/upload`, [{ type: "upload", selector: "#csv" }]);
    assert.match(r.error ?? "", /no bundled fixture matches accept "\.csv,\.xlsx".*Pass "files"/);
  });
});

test("pickFixture follows the accept list in order", () => {
  assert.equal(pickFixture("")?.file, "sample.jpg");
  assert.equal(pickFixture("image/png")?.file, "sample.png");
  assert.equal(pickFixture("image/*,.heic")?.file, "sample.jpg");
  assert.equal(pickFixture(".png,.jpg")?.file, "sample.png");
  assert.equal(pickFixture("video/*")?.file, "sample.mp4");
  assert.equal(pickFixture("image/jpeg,image/heic,image/heif,.jpg,.jpeg,.heic,.heif")?.file, "sample.jpg");
  assert.equal(pickFixture(".csv"), undefined);
});

test("the fixtures exist and ship in the package", async () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const pkg = JSON.parse(await fs.readFile(path.join(repo, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("fixtures"), "package.json files lists fixtures/");
  assert.equal(FIXTURE_DIR, path.join(repo, "fixtures", "upload"));
  for (const f of UPLOAD_FIXTURES) {
    const st = await fs.stat(path.join(FIXTURE_DIR, f.file));
    assert.ok(st.size > 100 && st.size < 10_000, `${f.file}: ${st.size} bytes`);
  }
});
