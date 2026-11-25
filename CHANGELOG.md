# Changelog

## Unreleased

### ECS-715 — response bodies, mocks from a file, automatic re-login, click failures that explain themselves

From an audit of the Studio agent's self-reviews: it guessed the shape of
real responses when writing mocks (developers later found data bugs), pasted
an 11 KB mock into every `capture_flow` call, ran logged out after the session
expired mid-turn with only a failed click to show for it, and spent repeated
runs on two click failures whose errors named no cause.

#### Added

- **`captureBodies`** on `check_page`, `render_component`, `verify_data_flow`
  and `capture_flow` (whole flow): an array of path patterns in the `mockApi`
  path forms (exact, `*`/`**` glob, `re:` regex, full URL), each optionally
  prefixed with a method. A matching API call's `apiCalls` entry carries
  `responseBody: {json | text, contentType, truncated?, originalBytes?,
  truncation?, redacted?, omitted?}`. Off unless passed. Bounded at 16,000
  chars per body, 48,000 per call and 20 bodies per call; a JSON body over the
  cap is shortened structurally (first rows of long arrays, head of long
  strings) and stays valid JSON, with `truncated: true`, `originalBytes` and
  `truncation` (what was cut, by JSON path). Values under credential-looking
  keys and JWTs become `"[redacted]"`; login traffic is never captured.
  Body-carrying entries are kept apart from the method + path dedupe and the
  30-call cap (deduped by method + path + query, with `query` on the entry).
  The result carries a `captureBodies` report (`patterns`, `bodies`, `chars`,
  `limits`, `unmatched` with `nearMisses`); `check_page` / `render_component`
  / `verify_data_flow` include `apiCalls` when `captureBodies` is passed.
  Aliases `bodies` / `responseBodies`.
- **`jsonFile` / `bodyFile`** on a `mockApi` stub: the body is read from a
  file relative to the workspace root, and refused when the path resolves
  outside it (lexically or through a symlink). `jsonFile` is parsed and
  validated; `bodyFile` is served as-is with a content-type by extension.
  Missing file, invalid JSON, a file over 5 MB and more than one body field
  are reported with the other stub problems before the browser starts. The
  `mockApi.mocks[]` entry carries `file`.
- **Automatic re-login.** An authenticated call whose first navigation finds
  the session signed out — it ended on `browser.login.url` though another URL
  was asked for, or its real API calls answered 401 (all, or two or more that
  are at least half) — drops that profile's context, signs in again and
  retries once. Results carry `reloggedIn: true` and `reloginReason`
  (`check_page`, `render_component`, `verify_data_flow`, `capture_flow`,
  `inspect_rendered_page`). Never loops: a retry that is still signed out
  fails with `Still signed out after an automatic re-login`, a login flow that
  cannot complete with `the automatic re-login failed`. Not for public calls,
  a call for the login page itself, stubbed 401s, or a session the same call
  just created; `loginAs` re-logs only that profile. `browser.autoRelogin:
  false` turns it off.

#### Fixed

- **`within` with a Playwright-syntax `selector`** (`text=Open`,
  `role=button[name="Delete"]`, `button >> nth=0`, XPath, quoted text) failed
  with a CSS parse error, because the selector was composed into `:has(...)`.
  The innermost-container rule is now built from locator filters for such
  selectors; a plain CSS selector takes the same path as before. `within`
  written as `text=…` is read as text; written with another engine prefix or
  a `>>` chain it is the container selector. A `within` that matches no
  container says so and shows how to scope by selector.
- **A click on a disabled control timed out with no hint.** When `click` /
  `fill` / `select` / `check` / `uncheck` times out on a target that is
  `aria-disabled="true"` (itself or through an ancestor) or natively
  disabled, the error says so; for `aria-disabled` it names the alternative
  (`{"type": "press", "selector": …, "key": "Space"}` or `Enter`), or that
  the control is disabled by design.

#### Changed

- `compileMocks(raw, { baseDir })` takes the workspace root for file bodies;
  `BrowserSession.runFlowDetailed` also returns `captureBodies`, `reloggedIn`
  and `reloginReason`; `BrowserSession.navigate` throws `SignedOutError` when
  an authenticated call's first navigation is signed out (tools that drive a
  page through `withPage` must let it propagate).

### ECS-619 — mockApi, drag, upload, signedInAs

Four runtime capabilities from 36 Studio self-reviews: agents building a
screen before its server part existed, drag and upload controls no flow could
operate, and a preview showing different data than the agent with no way to
rule out a different account.

#### Added

- **`mockApi`** on `check_page`, `render_component`, `verify_data_flow` and
  `capture_flow` (whole flow): `[{method?, path, query?, status?, json? |
  body?, headers?}]`. Matching page requests (the ones `apiCalls` counts:
  xhr/fetch or `/api/` URLs, by pathname on any origin; exact, `*`/`**` glob,
  `re:` regex or full URL) are fulfilled with the stub for that call only;
  the rest reach the real API. Installed after login, removed when the call
  ends even on error. Stubbed calls carry `mocked: true` (in `apiCalls`, which
  `check_page` / `render_component` now include when stubs are passed, and in
  `verify_data_flow`'s matched/unexpected lists); `mockApi.unmatched` lists
  stubs no request matched, with `nearMisses`. Bad stubs fail before the
  browser starts; unknown keys get a did-you-mean. Aliases `mocks` / `stubs`.
- **`drag` action** — `{selector, toSelector?, to?: {x, y}, steps?}`: real
  pointer input (press, move in steps, release), so pointer-driven widgets
  (sliders, sortable lists) and native HTML5 drag-and-drop both work. An
  off-screen drop point is an error.
- **`upload` action** — `{selector, files?}`: sets files on an
  `<input type=file>` (hidden ones included) or clicks any other element and
  answers the file chooser it opens (inputs created on the fly). Without
  `files`, a bundled fixture is chosen by the input's `accept`: a tiny JPEG,
  PNG or H.264 MP4 (`fixtures/upload/`, shipped in the package; regenerate
  with `node scripts/make-upload-fixtures.mjs`, which needs only Playwright's
  Chromium).
- **`signedInAs`** on every runtime result (`check_page`, `render_component`,
  `verify_data_flow`, `capture_flow`, `inspect_rendered_page`) and per profile
  in `server_info` (`login.account`, `login.profiles[].account`): the login
  email resolved from config/env (secret-looking fields and env vars are never
  read), the app's own signed-in user from localStorage/sessionStorage (user
  JSON and JWT claims reduced to email/id/name/roles, `source` key named,
  other users under `alsoFound`), impersonation state (`active`, `phase`,
  `as`, `original`), `mismatch` when the app user is not the login email, and
  a one-line `summary`.

#### Changed

- `runAction` returns `{ measurement?, detail? }` (was a bare Measurement)
  and takes an optional context (the workspace root for relative upload
  paths); `BrowserSession.runFlowDetailed` returns the steps plus the
  flow-level `signedInAs` and `mockApi` report (`runFlow` still returns the
  steps).

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
