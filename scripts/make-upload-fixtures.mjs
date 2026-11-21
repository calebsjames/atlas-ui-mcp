#!/usr/bin/env node
/**
 * Regenerate the bundled `upload` action fixtures in fixtures/upload/ —
 * a tiny PNG, JPEG and MP4 — with nothing but Playwright's Chromium (no
 * ffmpeg): canvas.toBlob for the images, MediaRecorder for the video
 * (H.264 in MP4, which Chromium 126+ can record). Each file is then loaded
 * back into an <img>/<video> to prove it decodes.
 *
 *   node scripts/make-upload-fixtures.mjs
 */
import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/upload");
const VIDEO_TYPE = "video/mp4;codecs=avc1.42E01E";

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<canvas id="c" width="64" height="48"></canvas>');
  const made = await page.evaluate(async (videoType) => {
    const c = document.getElementById("c");
    const g = c.getContext("2d");
    const draw = (t) => {
      g.fillStyle = "#1d4ed8";
      g.fillRect(0, 0, 64, 48);
      g.fillStyle = "#facc15";
      g.fillRect(4 + (t % 40), 16, 16, 16);
    };
    draw(0);
    const toB64 = async (blob) => {
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (const b of buf) s += String.fromCharCode(b);
      return btoa(s);
    };
    const png = await new Promise((r) => c.toBlob(r, "image/png"));
    const jpg = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.8));
    if (!MediaRecorder.isTypeSupported(videoType)) throw new Error(`MediaRecorder cannot record ${videoType}`);
    const stream = c.captureStream(15);
    const rec = new MediaRecorder(stream, { mimeType: videoType, videoBitsPerSecond: 50_000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise((r) => (rec.onstop = r));
    rec.start();
    let t = 0;
    const timer = setInterval(() => draw((t += 3)), 66);
    await new Promise((r) => setTimeout(r, 1000));
    clearInterval(timer);
    rec.stop();
    await done;
    const mp4 = new Blob(chunks, { type: "video/mp4" });
    return { png: await toB64(png), jpg: await toB64(jpg), mp4: await toB64(mp4) };
  }, VIDEO_TYPE);

  await fs.mkdir(OUT, { recursive: true });
  for (const [name, b64] of [["sample.png", made.png], ["sample.jpg", made.jpg], ["sample.mp4", made.mp4]]) {
    await fs.writeFile(path.join(OUT, name), Buffer.from(b64, "base64"));
  }

  // Decode check: every fixture must load back in the browser.
  const check = await page.evaluate(async (files) => {
    const out = {};
    for (const [name, mime, b64] of files) {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      if (mime.startsWith("image/")) {
        const img = new Image();
        img.src = url;
        await img.decode();
        out[name] = { width: img.naturalWidth, height: img.naturalHeight, bytes: bytes.length };
      } else {
        const v = document.createElement("video");
        v.muted = true;
        v.src = url;
        await new Promise((res, rej) => {
          v.onloadeddata = res;
          v.onerror = () => rej(new Error(`video decode failed: ${v.error?.message}`));
        });
        out[name] = { width: v.videoWidth, height: v.videoHeight, duration: v.duration, bytes: bytes.length };
      }
    }
    return out;
  }, [["sample.png", "image/png", made.png], ["sample.jpg", "image/jpeg", made.jpg], ["sample.mp4", "video/mp4", made.mp4]]);
  console.log(JSON.stringify(check, null, 2));
} finally {
  await browser.close();
}
