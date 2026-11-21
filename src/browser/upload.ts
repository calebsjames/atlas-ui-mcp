/**
 * Files for the `upload` action. Explicit paths resolve against the workspace
 * root; with none, a bundled fixture is picked by the input's `accept` — so a
 * flow can get past an upload gate ("add two swing videos") without the agent
 * having a file to hand.
 */
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

/** <install root>/fixtures/upload — this module sits at <root>/<outDir>/browser/. */
export const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures/upload");

/** Bundled fixtures, in preference order for a wildcard accept ("image/*" → JPEG). */
export const UPLOAD_FIXTURES = [
  { file: "sample.jpg", mime: "image/jpeg", exts: [".jpg", ".jpeg"] },
  { file: "sample.png", mime: "image/png", exts: [".png"] },
  { file: "sample.mp4", mime: "video/mp4", exts: [".mp4"] },
] as const;

/**
 * The first bundled fixture an `accept` value allows, trying its tokens in the
 * order the app lists them. An empty accept takes anything (the JPEG).
 */
export function pickFixture(accept: string): { file: string; mime: string; matched: string } | undefined {
  const tokens = accept.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (!tokens.length) return { file: UPLOAD_FIXTURES[0].file, mime: UPLOAD_FIXTURES[0].mime, matched: "(no accept)" };
  for (const t of tokens) {
    const f = UPLOAD_FIXTURES.find((fx) =>
      t.startsWith(".")
        ? (fx.exts as readonly string[]).includes(t)
        : t.endsWith("/*")
          ? fx.mime.startsWith(t.slice(0, -1))
          : fx.mime === t || (t === "image/jpg" && fx.mime === "image/jpeg")
    );
    if (f) return { file: f.file, mime: f.mime, matched: t };
  }
  return undefined;
}

/** Resolve the files for one upload, and a secret-safe line describing them. */
export async function resolveUploadFiles(
  files: string[] | undefined,
  accept: string,
  baseDir?: string
): Promise<{ paths: string[]; detail: string }> {
  if (files && !Array.isArray(files)) throw new Error('Action "upload": "files" must be an array of paths.');
  if (files?.length) {
    const paths = files.map((f) => path.resolve(baseDir ?? process.cwd(), f));
    const missing: string[] = [];
    for (const p of paths) {
      try {
        if (!(await fs.stat(p)).isFile()) missing.push(p);
      } catch {
        missing.push(p);
      }
    }
    if (missing.length) {
      throw new Error(
        `Action "upload": file(s) not found: ${missing.join(", ")}` +
          (baseDir ? ` (relative paths resolve against ${baseDir}).` : ".")
      );
    }
    return { paths, detail: paths.map((p) => path.basename(p)).join(", ") };
  }
  const fx = pickFixture(accept);
  if (!fx) {
    throw new Error(
      `Action "upload": no bundled fixture matches accept "${accept}" — bundled: ` +
        UPLOAD_FIXTURES.map((f) => `${f.file} (${f.mime})`).join(", ") +
        '. Pass "files": ["path/to/file"].'
    );
  }
  return {
    paths: [path.join(FIXTURE_DIR, fx.file)],
    detail: `${fx.file} (bundled fixture; accept ${accept ? `"${accept}" matched ${fx.matched}` : "not set"})`,
  };
}
