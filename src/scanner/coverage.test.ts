import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { computeCoverageWarning } from "./coverage.js";
import type { ScanTarget } from "../types.js";

/**
 * A scan whose targets miss the project's layout used to return a near-empty
 * catalog with no signal — indistinguishable from "this app has no
 * components". The coverage check must name where the UI files actually live,
 * and must stay quiet when the targets caught the app (or when the leftovers
 * are framework route files that file-based routing already consumes).
 */

const EXCLUDE = ["node_modules", "dist", "build", "__tests__", "*.test.*", "*.spec.*"];

async function workspace(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-coverage-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  return dir;
}

function check(
  root: string,
  scanTargets: ScanTarget[],
  scannedUiFileCount: number,
  extraCoveredFiles: string[] = []
) {
  return computeCoverageWarning({
    workspaceRoot: root,
    scanTargets,
    excludePatterns: EXCLUDE,
    extraCoveredFiles,
    scannedUiFileCount,
  });
}

test("empty catalog with UI files elsewhere fires and names the directories", async () => {
  const root = await workspace({
    "package.json": JSON.stringify({ dependencies: { react: "^19" } }),
    "src/app/components/Button.tsx": "export function Button() {}",
    "src/app/components/Card.tsx": "export function Card() {}",
    "src/app/hooks/useThing.tsx": "export function useThing() {}",
  });
  const warning = await check(
    root,
    [{ dir: "src/components", extensions: [".tsx"], type: "component" }],
    0
  );

  assert.ok(warning);
  assert.equal(warning.missedFileCount, 3);
  assert.equal(warning.uncoveredDirs[0].dir, "src/app/components");
  assert.equal(warning.uncoveredDirs[0].count, 2);
  assert.match(warning.message, /src\/app\/components/);
});

test("stays quiet when scan targets caught the app", async () => {
  const root = await workspace({
    "package.json": JSON.stringify({ dependencies: { react: "^19" } }),
    "src/components/Button.tsx": "export function Button() {}",
  });
  const warning = await check(
    root,
    [{ dir: "src/components", extensions: [".tsx"], type: "component" }],
    1
  );
  assert.equal(warning, undefined);
});

test("a handful of stragglers next to a healthy catalog stays quiet", async () => {
  const root = await workspace({
    "package.json": JSON.stringify({ dependencies: { react: "^19" } }),
    "src/testing/MockA.tsx": "export function MockA() {}",
    "src/testing/MockB.tsx": "export function MockB() {}",
    "src/testing/MockC.tsx": "export function MockC() {}",
  });
  const warning = await check(
    root,
    [{ dir: "src/components", extensions: [".tsx"], type: "component" }],
    50
  );
  assert.equal(warning, undefined);
});

test("Next.js route special files are owned by file-routing, not coverage", async () => {
  const root = await workspace({
    "package.json": JSON.stringify({ dependencies: { react: "^19", next: "^15" } }),
    "src/app/page.tsx": "export default function Home() {}",
    "src/app/layout.tsx": "export default function Layout() {}",
    "src/app/dashboard/page.tsx": "export default function Dash() {}",
    "src/app/dashboard/loading.tsx": "export default function Loading() {}",
    "src/pages/legacy.tsx": "export default function Legacy() {}",
  });
  const warning = await check(
    root,
    [{ dir: "src/components", extensions: [".tsx"], type: "component" }],
    0
  );
  assert.equal(warning, undefined);
});

test("colocated non-special files under the app dir still count as missed", async () => {
  const root = await workspace({
    "package.json": JSON.stringify({ dependencies: { react: "^19", next: "^15" } }),
    "src/app/page.tsx": "export default function Home() {}",
    "src/app/sidebar.tsx": "export function Sidebar() {}",
  });
  const warning = await check(
    root,
    [{ dir: "src/components", extensions: [".tsx"], type: "component" }],
    0
  );
  assert.ok(warning);
  assert.deepEqual(warning.uncoveredDirs, [{ dir: "src/app", count: 1 }]);
});

test("root entry files, route files, and excluded names are covered", async () => {
  const root = await workspace({
    "package.json": JSON.stringify({ dependencies: { react: "^19" } }),
    "src/App.tsx": "export default function App() {}",
    "src/router.tsx": "export const router = 1;",
    "src/components/Button.test.tsx": "test",
    "node_modules/pkg/index.tsx": "export {}",
  });
  const warning = await check(
    root,
    [{ dir: "src/components", extensions: [".tsx"], type: "component" }],
    0,
    ["src/App.tsx", "src/router.tsx"]
  );
  assert.equal(warning, undefined);
});
