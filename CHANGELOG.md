# Changelog

## 3.1.0 — 2026-10-11

Everything since 3.0.0: the symbol-honest work that shipped uncommitted from
2026-09-15 (committed as `15434b3`) plus fixes from the 2026-10-10 field
review of how agents actually use the tools.

### Added

- **`server_info` tool** — version, git sha + dirty flag, build time vs process
  start (`build.stale` when the running server predates the build on disk),
  workspace, effective config, catalog size / `lastScanned` / `unscannedDirs`,
  login state per profile, dev-server probe. `refresh: true` reloads the whole
  `.atlas-ui.json` and rescans without a restart.
- **Mount paths** — `render_component` / `verify_data_flow` reach a component no
  route renders (modal, tab, composable) through its nearest routed ancestor:
  `mountPath` with each hop's guard, URL/section reveals applied, and for
  app-state gates `targetMounted: false` plus `captureFlowSteps` (activator
  clicks found in the template). `verify_data_flow` returns verdict `gated`
  instead of reporting the ancestor's traffic as drift. `render_component`
  takes `file`.
- **Method-level index** — `find_component_usages` accepts `Owner.method` or a
  bare method name (`resolution.status: "indexed-as-member"`, usages with
  `resolvesTo`, usageType `call` | `reference`); `find_dead_code` reports
  `unusedMethods` (static, object-literal and in-module-instance methods only).
- **Runtime controls** — per-call `viewport`, `browser.profiles` + `loginAs`,
  actions `scroll`, `wait` and the read-only `measure` (also `measure:
  [selectors]` on `check_page` / `render_component`).
- **`find_component_usages` `file`** and per-usage `resolvesTo` for names
  declared in more than one file.
- **`get_data_flow` `summary`** — automatic above ~20k characters (allEndpoints,
  chainCount, per-owner counts); `resolved: true` + `reason` on an empty trace.
- **Util fallback layer** — every `src/**/*.ts` module no scan target covers is
  indexed (`fallbackScan: false` to disable); the catalog reports
  `unscannedDirs`; the coverage warning counts `.ts`.
- **Symbol-honest resolution** — `get_hook_detail`, `find_component_usages`
  (15434b3) and now `get_component_detail`, `get_dependency_chain`,
  `get_data_flow`, `get_component_props`: a secondary export answers as itself
  (`isPrimaryExport`, `matchedExport`, `modulePrimaryName`, `caveat`).
- Template mount-site props on `find_component_usages` (`staticProps`,
  `boundProps`, `vModelProps`, `flagProps`, `spreadProps`, `renderedWhen`) and
  `resolution.status` (15434b3).
- `browser.idleIgnore`, `quietMs`, `quietMaxMs`, `longPollMs`,
  `navigationTimeoutMs`; `capture_flow` `waitUntil` (flow and step).
- Argument aliases (`component` ↔ `name`, `route` → `url`, …).

### Changed

- **Navigation waits for a quiet window**, not `networkidle` (which never
  settles while an SSE/websocket stream is open). A stalled wait lists the
  requests still in flight; a stream aborted by navigation is not a failed
  request.
- **A fresh page per runtime call** (same context; `sessionStorage` carried
  over). A flow whose first step has no target reopens the previous call's URL
  from a clean load.
- **Compact JSON output** — one line, empty nested arrays and absolute
  workspace `path`s dropped.
- **Name resolution** — the same node reached twice is no longer
  `ambiguous`; an exact-case primary name beats an alias; component tools pick
  the single renderable candidate and report `alsoMatched`.
- **`get_section_map`** parses gates with the TypeScript AST: one section per
  `||` disjunct, `&&` compounds as `conditions`; a `queryParam` only when the
  query value flows into the variable. Section ids match case- and
  whitespace-insensitively at runtime; an unknown id is an error listing the
  valid ones. `capture_flow` treats a `section`-only step as navigation and
  allows settle/screenshot-only steps.
- Runtime tools preflight the dev server and quote its status + `<title>` in
  every runtime error; a failed login names the page it stopped on and saves a
  screenshot.
- Router navigation (`router.push`, `location.assign`, …) is no longer
  reported as an API endpoint.
- Resolving a component to a route no longer falls back to a substring match.
- Tests build to `build-test/` (`npm test` no longer rebuilds `dist/`); test
  files are excluded from the package.
- Tool descriptions use neutral examples.

### Fixed

- Services/adapters named like `InventoryService` in `inventoryService.ts`
  were unresolvable by name (two identical candidates; `file` could not help).
