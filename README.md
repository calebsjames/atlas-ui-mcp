# Atlas UI

MCP server that gives Claude deep awareness of your frontend codebase — components, hooks, services, routes, data flow, the whole thing. Point it at a React or Vue project and it builds a catalog that Claude can query while it works.

## TLDR: Quick Start

1. **Configure VS Code** (via your MCP extension settings, e.g. `.vscode/mcp.json`):
   ```json
   {
     "mcpServers": {
       "atlas-ui": {
         "command": "node",
         "args": ["/absolute/path/to/atlas-ui/dist/server.js"],
         "env": {
           "WORKSPACE_ROOT": "/absolute/path/to/your/target/project"
         }
       }
     }
   }
   ```
2. **Restart VS Code and try these prompts:**
   - *"List all the components in my project."* (`list_all_components`)
   - *"What are the props for the Button component?"* (`get_component_props`)
   - *"Show me the data flow for the UserProfile component."* (`get_data_flow`)
   - *"Are there any dead components we can delete?"* (`find_dead_code`)

## What it does

Instead of Claude grep-ing around your codebase every time it needs to understand how things fit together, this server scans your project up front and exposes a set of tools for navigating the architecture. It understands:

- **Components, pages, hooks, services, adapters, contexts, stores** — categorized by architecture layer (stores cover Pinia, Zustand, and Redux Toolkit)
- **Props and interfaces** — parsed from TypeScript definitions
- **Dependency chains** — what uses what, upstream and downstream
- **Route maps** — React Router and Vue Router, plus file-based routing (Next.js App/Pages Router, Nuxt), including protected routes and nested layouts
- **Data flow** — traces the full path from component → hook/store → service → adapter → API endpoint
- **Dead code** — finds exported items that nothing imports (entry points like `App.tsx`/`main.tsx` count as usage, so root-mounted components aren't false-flagged)
- **Drivable selectors** — each component's `data-testid` values and form fields with ready-to-use selectors, so flows can be scripted without reading source

It auto-detects whether your project is React, Vue and sets up sensible scan targets accordingly. File watching keeps the cache fresh as you work.

Catalog-wide listings and search results return compact summaries to keep token cost down; `get_component_detail` has the full metadata, and `list_all_components` accepts `verbose: true` when you really want everything. Every result is one-line JSON with empty nested arrays and absolute file paths dropped (each node keeps its `relativePath`). When a name matches multiple files, name-based tools pick an exact-case primary name (or, in component tools, the single renderable candidate) and list the rest under `alsoMatched`; otherwise they return an `ambiguous` result with candidates — re-call with `file` (a path substring) to pick one.

## Setup

**From npm** (no clone needed):

```bash
npx atlas-ui-mcp /path/to/your/app
```

or in an MCP config, `"command": "npx", "args": ["-y", "atlas-ui-mcp", "/path/to/your/app"]`.

**From source:**

```bash
npm install
npm run build
```

### Claude Code

Add to your project's `.mcp.json` (or `~/.claude/mcp.json` for global):

```json
{
  "mcpServers": {
    "atlas-ui": {
      "command": "node",
      "args": ["/path/to/atlas-ui/dist/server.js"],
      "env": {
        "WORKSPACE_ROOT": "/path/to/your/project"
      }
    }
  }
}
```

### Claude Desktop

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "atlas-ui": {
      "command": "node",
      "args": ["/path/to/atlas-ui/dist/server.js"],
      "env": {
        "WORKSPACE_ROOT": "/path/to/your/project"
      }
    }
  }
}
```

`WORKSPACE_ROOT` tells the server where your project lives. You can also pass it as a CLI arg (`node dist/server.js /path/to/project`). If neither is set, it defaults to two directories up from the server because that's where mine lives. Feel free to update if you have a common folder for MCPs.

## Configuration

Drop a `.atlas-ui.json` in your project root to customize scanning. If you don't create one, the server auto-detects your framework and uses defaults based on what it finds.

```json
{
  "scanTargets": [
    { "dir": "src/components", "extensions": [".tsx"], "type": "component" },
    { "dir": "src/pages", "extensions": [".tsx"], "type": "page" },
    { "dir": "src/hooks", "extensions": [".ts", ".tsx"], "type": "hook" },
    { "dir": "src/services", "extensions": [".ts"], "type": "service" },
    { "dir": "src/adapters", "extensions": [".ts"], "type": "adapter" },
    { "dir": "src/contexts", "extensions": [".tsx"], "type": "context" }
  ],
  "routeFiles": ["src/App.tsx"],
  "aliases": {
    "@/": "src/"
  },
  "exclude": ["node_modules", "dist", "build", "__tests__", "*.test.*", "*.spec.*"]
}
```

| Field | What it does |
|-------|-------------|
| `scanTargets` | Directories to scan, what extensions to look for, and what architecture layer they belong to. Valid types: `component`, `page`, `hook`, `service`, `adapter`, `context`, `store`, `dto`, `type` |
| `routeFiles` | Entry points for route parsing (React Router or Vue Router). Next.js / Nuxt file-based routes are discovered automatically alongside these |
| `aliases` | Path aliases so the server can resolve imports like `@/components/Button` |
| `exclude` | Glob patterns to skip |
| `phiCompliance` | `{ "enabled": true }` turns on PHI/HIPAA heuristics (query cache settings, console.log near patient data, web-storage use). Off by default — non-healthcare projects get zero PHI noise |

### Defaults by framework

**React** — scans `src/components` (.tsx), `src/pages` (.tsx), `src/hooks` (.ts/.tsx), `src/services` (.ts), `src/adapters` (.ts), `src/contexts` (.tsx), `src/stores` + `src/store` (.ts). Routes from `src/App.tsx`, plus Next.js `app/`/`pages/` file routes when `next` is a dependency.

**Next.js** (when `next` is a dependency) — the React defaults widen to the layouts Next sanctions: shared code colocated inside the App Router dir (`app/`- and `src/app/`-nested `components`, `hooks`, `contexts`, `providers`, `services`, `lib`, `stores`), the `src`-level `src/lib` + `src/providers`, and root-level dirs next to `app/` or `pages/` (`components`, `hooks`, `lib`, `pages`, ...). Directories that don't exist are skipped, so this costs nothing on plain `src/*` layouts.

**Vue** — scans `src/components` (.vue), `src/views` + `src/pages` (.vue), `src/composables` (.ts), `src/services` (.ts), `src/adapters` (.ts), `src/stores` + `src/store` (.ts). Routes from `src/router/index.ts`, plus Nuxt `pages/` file routes when `nuxt` is a dependency.

**Nuxt** (when `nuxt` is a dependency) — the Vue defaults widen to Nuxt's root-level dirs (`components`, `layouts`, `pages`, `composables`, `stores`, `utils`) and their Nuxt 4 `app/`-nested equivalents.

### Util fallback layer

Beyond the scan targets, every `src/**/*.ts` module no target covers is indexed as layer `util` (`hook` when its primary export is `use*`) — so `src/constants`, `src/config`, `src/realtime`, `src/navigation` and friends are visible to every tool. Declarations, tests, barrel-only `index.ts` files and test scaffolding (`setup-tests`, `test/`, `testing/`, `__mocks__/`, `fixtures/`) are skipped. Set `"fallbackScan": false` to turn it off. The catalog always reports `unscannedDirs` — directories under `src/` with source files it does **not** index — on `list_all_components`, `get_architecture_overview` and `server_info`.

### Scan coverage warning

Layout conventions are unbounded, so no default list can cover them all — but a scan that misses the app should say so instead of returning a near-empty catalog that reads as "this app has no components". After every scan, the server checks for UI source files (`.tsx`/`.jsx`/`.vue`) that no scan target covers. When the misses outweigh the catalog (or the catalog is empty), `list_all_components` and `get_architecture_overview` include a `coverageWarning` naming the heaviest uncovered directories, so the fix is a copy-paste `scanTargets` entry in `.atlas-ui.json`. Files owned by file-based routing (Next App Router special files, `pages/` routes) don't count as missed.

## Tools

### `list_all_components`
Compact catalog listing: `{ totalCount, lastScanned, byLayer, components }` where each entry is a summary (name, layer, category, path, description, route). Filter with `layer`; pass `verbose: true` for full metadata objects.

### `search_components`
Fuzzy search across the whole codebase by name, path, or keywords. Multi-token scoring, ranked by relevance. Returns compact summaries with `_score`; `limit` caps results (default 20).

### `get_component_props`
Returns the TypeScript prop interface for a component — prop names, types, required/optional, defaults, and JSDoc descriptions. Accepts a catalog `name` or a `componentPath`; failures come back as `{ error }` with the reason.

### `find_similar_components`
Describe what you're looking for in plain English and it finds matching components using keyword + structural matching (hooks used, child components, data fetching patterns, layer). Returns compact summaries.

### `compare_implementations`
The reuse **guardrail**. `find_similar_components` / `search_components` score on structural metadata, so they rank near-duplicates to the top — exactly the ones whose subtle behavioral differences matter most — with no signal that the bodies diverge. Before unifying two look-alikes, this tool compares them at **sub-file granularity** and tells you whether that's safe.

Give it two symbol references `{ file, symbol, enclosingSymbol? }`. Each resolves a function, arrow, class/static method, object getter/method, or a `computed()` / `useMemo()` / `useCallback()` (compared by its callback body). It normalizes away comments, formatting, quote style, numeric form, and semicolon/trailing-comma noise, then diffs the token streams and returns:

- `verdict` — `equivalent` (byte-equal after normalization → safe to unify) or `diverges`
- `divergences[]` — each classified (`literal`, `callee-changed`, `guard-changed`, `operator-changed`, `added-block`, `removed-block`, `changed`) with the original source snippet on each side and file line spans (`locA` / `locB`)

Works for **both Vue and React** off the same engine — a `.vue` `<script>` is extracted to TS and its lines mapped back, so a Vue composable/computed and a React hook/memo compare on equal footing (you can even compare one against the other). `b.file` may be omitted to compare two symbols in the same file. Identifiers and type annotations are preserved (no alpha-renaming); Options-API `this.x` vs composable `x.value` access styles are not normalized in v1.

### `get_component_detail`
Full metadata dump for any item — props, hooks, state, children, event handlers, data fetching, `testIds` and `formFields` (drivable selectors for `capture_flow`), accessibility info, API endpoints, architecture layer.

It is **symbol-honest** (so are `get_dependency_chain`, `get_data_flow` and `get_component_props`): asking for a module's *secondary* export (`isOrderItemSettled` in a file whose catalog name is `OUTSTANDING_ORDER_ITEM_STATUSES`) answers about that symbol — its own `name`, `line` and JSDoc `description` — with `isPrimaryExport: false`, `matchedExport`, `modulePrimaryName`, `siblingExports`, and a `caveat` naming which fields are file-level. `get_dependency_chain` scopes `usedBy` to files importing that symbol.

### `find_component_usages`
Find everywhere **any exported symbol** is used — a component mounted in a template/JSX, a composable called, or a plain exported function (DTO predicates, utils) called. Works for symbols that aren't their file's primary export. Also scans entry points (`App.tsx`, `main.tsx`, layouts) and route files that live outside scan targets.

Returns `{ symbol, resolution, externalUsageCount, selfModuleUsageCount, usages, siblingExports?, suggestions?, caveats }`:

- **`resolution.status`** separates the two things an empty result can mean. `indexed` / `indexed-as-export` — the symbol exists, so zero usages is a real *unused*. `not-in-catalog` — the lookup missed; `suggestions` lists near-matches (including matches on other modules' exported symbols). Conflating these is what makes a wrong answer look like a right one.
- **`usages[].usageType`** — `template` | `jsx` | `import` | `call`. Call sites are matched for every non-PascalCase name, so a helper reports where it is *called*, not just where it is imported. Hits inside the declaring module are marked `scope: "self-module"` and counted separately.
- **`siblingExports`** — the declaring module's other exports with an import count each. A zero-usage symbol next to a heavily-used sibling is a different fact from a dead one.
- **Same name in two files** — every usage carries `resolvesTo` (the declaring file its import points at); pass `file` to scope the report to one declaration.
- **Methods** — `ProjectService.createProject`, or a bare method name no module exports (`createProject`), resolves at method level (`resolution.status: "indexed-as-member"`): `Owner.method` call sites (`usageType` `call` or `reference`) in importers of the owner, each tagged with the member it `resolvesTo`.

**Props at the mount site.** For Vue SFCs the mount sites come from the compiler AST, not a line regex, so each `template` usage also carries what is actually passed there:

- `staticProps` — `scope="all"`: literal **values**, facts about that site
- `boundProps` / `vModelProps` — `:scope="activeScope"`: the expression **source**. A pointer into that file's script, never presented as a value
- `flagProps` — valueless attributes (`<Panel embedded />`); Vue passes `""`, which a Boolean-declared prop casts to `true`
- `spreadProps` — `v-bind="obj"`: an unknown set of props
- `renderedWhen` — the v-if/v-show/v-for governing that site

This is the question `get_component_props` structurally cannot answer: it reports the *declared* interface, this reports the *traffic*. (Using the AST also drops the regex's false positives — a `<Tag>` inside a comment or a `ref<CustomerInfo | null>` type annotation is no longer a usage.)

### `whats_affected`
The edit→verify glue. Give it changed files (or let it read `git status`) and it walks the dependency graph upstream to every affected component and page, maps those to routes, and returns concrete `check_page` / `render_component` suggestions. Edit → `whats_affected` → check exactly what matters.

### `get_architecture_overview`
High-level view of the whole app — counts by layer, category breakdown, data flow chains, and the route map.

### `get_dependency_chain`
Traces upstream (what uses it) and downstream (what it depends on) for any item. Supports recursive depth 1-3.

### `get_route_map`
Full route → page → component mapping with protection status, hooks used, child components, dynamic segments, and nested routes. Covers React Router, Vue Router, and file-based routing (Next.js App/Pages Router, Nuxt).

### `get_section_map`
The companion to `get_route_map` for SPAs that multiplex **one route** into several in-app sections — a role shell / tabbed page / sidebar switch where the lists are section switches, not routes (so `get_route_map` can't point at them). For each routed page (and each page/root shell) it detects a **view multiplexer**: a single state variable gating sibling sub-views. Works for both frameworks off their own constructs — Vue `v-if="view === 'x'"` + `@click="view = 'x'"`, React `{tab === 'x' && <X/>}` + `onClick={() => setTab('x')}` — never off app-specific names.

Returns `{ containers, note? }`. Each container carries its `route` (when routed), its `selector` (the state variable), and `sections[]`. Each section has:
- `id` — the literal the selector takes for this section (e.g. `"prescriptions"`)
- `child` — the component rendered for it
- `reachedBy` — `query` (the view syncs to a URL param), `click` (a control switches it), or `unknown` (statically unprovable — e.g. a store/reducer or non-literal condition; drive the UI to explore)
- `queryParam` — `{ key, value }` when URL-reachable
- `activator` — `{ selector, label }`, the drivable control that switches to the section (a `[data-testid]` or `text=` selector), when statically identifiable

`note` (present only on an empty result) explains why nothing was found. A fully route-based app returns no containers — this tool adds signal exactly where the route map goes quiet.

Gates are parsed as expressions (TypeScript AST), not matched by regex: `view === 'a' || view === 'b'` — including multi-line `||` chains — yields one section per literal; an `&&` compound (`section === 'Projects' && tab === 'Club Fittings'`) yields a section whose `conditions` lists every `{var: value}` it needs (non-equality conjuncts land in `alsoRequires`; a second element rendered for the same section in `alsoRenders`). `queryParam` is reported only when the URL value actually **flows into** the variable (initialiser, `watch` callback, a local function — including a validating identity like `resolveSection(v)`); a value mapped through a lookup table is not URL-reachable by its literal. The ids are the exact literals the app compares (case-sensitive in the app); the runtime tools' `section` argument matches them case-, whitespace-, `-`/`_`-insensitively and errors with the valid ids when nothing matches.

**Driving to a section.** The runtime tools consume this map so you don't have to wire the click yourself. `render_component`, `verify_data_flow`, `inspect_rendered_page`, and each `capture_flow` step take a `section` argument (or you can just name the section's `child` component) — the tool navigates to the container's route and then reveals the section automatically: it appends the query param for a `query` section, or clicks the `activator` for a `click` section, *before* it screenshots and reads the network. So a section's own render, console, and API calls (with Phase-1 row counts) are what get captured — no guessed sidebar clicks.

### `get_hook_detail`
Deep dive on a hook/composable — parameters, return type, query keys, adapter calls, data fetching pattern, and which components use it.

Resolution is **by symbol name, not by directory**: a `use*`-named export is found whether it lives in `src/composables/`, `src/services/`, or anywhere else, and whether or not it is its file's primary export (the catalog indexes one node per file under a single name, so `useImpersonation` out of `impersonationService.ts` is reached through that module's exports). The answer stays honest about where the code actually sits: `architectureLayer` reports the **file's** layer as indexed (`service`, not a relabelled `hook`), `isPrimaryExport` / `modulePrimaryName` / `siblingExports` say what else shares the file, and `caveat` flags which fields are file-level rather than scoped to the symbol you asked about.

### `find_dead_code`
Finds exported items that are never imported anywhere. Optionally filter by layer. Components referenced only from entry points or route files are correctly treated as live. Also reports `unusedMethods` — static class methods, object-literal adapter methods and in-module instance methods that nothing calls or references (an instance method of a class instantiated elsewhere is never judged; read `methodCaveat`).

### `get_data_flow`
Traces the full data path: component → composable/hook/store → service → adapter → API endpoint — **including endpoints fetched by child components** (a page rarely fetches everything itself). Store-mediated flows (Pinia/Zustand) surface in a `stores` step per chain. Walks the child render tree (bounded by `depth`, default 3, plus a cycle-guard). Each chain is tagged with the `via` render path that reached it, and `allEndpoints` gives the union of everything the rendered route hits. Saves you from manually chaining `get_component_detail` + `get_hook_detail` calls.

A whole shell page traces to hundreds of chains, so a result above ~20k characters comes back as `mode: "summary"` — `allEndpoints` (complete), `chainCount`, per-owner counts and the services/adapters on the path; pass `summary: false` for every chain. An empty trace carries `resolved: true` and a `reason`, so "traced, nothing fetched" never looks like "not found" (`found: false`).

### `server_info`
Which code is answering, against what: version, git sha + dirty flag of the atlas-ui install, build time vs this process's start (`build.stale` means the running server is older than the build on disk — reconnect the MCP), the workspace and effective config, catalog size / `lastScanned` / `unscannedDirs`, login state per profile with **who each profile signs in as** (`account`: the login email resolved from config/env, and the app's own user, roles and impersonation as last read from storage, with `observedAt`), and a dev-server probe (status + `<title>`). `refresh: true` reloads the **whole** `.atlas-ui.json` and rescans without a restart.

> **Name collisions:** `get_component_detail`, `get_component_props`, `get_hook_detail`, `get_dependency_chain`, and `get_data_flow` resolve a name that matches several files only when one candidate is clearly meant — an exact-case primary name beats a camelCase file alias, and the component tools prefer the single renderable candidate — and then list the others under `alsoMatched`. Otherwise they return `{ ambiguous: true, candidates: [...] }`; re-call with `file` (a path substring). The same node reached twice (name + case-only alias) is never reported as ambiguous.
>
> **Names that resolve to nothing** never come back bare. The same tools return `{ found: false, message, suggestions: [...] }`, and the suggestion scan covers **every module's exported symbols**, not just catalog node names — so a symbol that exists only as a file's secondary export comes back as a pointer (`matchedExport`) instead of a dead end. A silent miss is the most expensive answer this server can give.

## Runtime browser tools — let agents check their work

The tools above understand your code statically. These drive a real (headless) browser against your **running app**, so an agent can *see* the result of a change instead of guessing. They reuse the static catalog — the route map resolves a component to its URL automatically, so you name the component you changed and the browser knows where to go.

Powered by Playwright/Chromium. They require your dev server to be running and degrade gracefully — the static tools work even if the browser binaries aren't installed.

- **Preflight.** Each runtime call first GETs `devServerUrl`; an unreachable server or a 5xx fails fast without launching Chromium, and every runtime error ends with what the dev server answered (`[dev server GET http://… → 200 "My App"]`).
- **Navigation settles on a quiet window**, not `networkidle`: `load`, then a bounded window (≤10 s) with no short-lived request in flight. SSE / websocket streams, long-polls and `browser.idleIgnore` URLs never hold it open, so an app with a realtime stream doesn't burn a 30 s timeout per call. `waitUntil` (`quiet` | `load` | `domcontentloaded` | `networkidle`) overrides it; a stalled wait lists the requests still in flight.
- **A fresh page per call**, in the same browser context: cookies, localStorage and IndexedDB carry over, `sessionStorage` (where many SPAs keep their token) is carried from one page to the next, and a previous call's open modal can't swallow this call's clicks.
- **Per call:** `viewport {width,height}` (that call only), `loginAs` (a `browser.profiles` role, own context), on `check_page` / `render_component` a read-only `measure: [selectors]`, and on `check_page` / `render_component` / `verify_data_flow` / `capture_flow` **`mockApi`** — API stubs for that call only (see [Stubbing the API](#stubbing-the-api-mockapi)).
- **Response bodies on request:** `captureBodies: [path patterns]` on the same four tools puts the response body of the API calls you name on their `apiCalls` entry (see [Reading response bodies](#reading-response-bodies-capturebodies)). Off unless passed.
- **Every result says who the browser was signed in as** (`signedInAs`, see [below](#who-the-browser-is-signed-in-as-signedinas)), so "I see different data than the preview" can be ruled in or out as a different account.
- **An expired session signs itself in again.** When an authenticated call's first navigation finds the session signed out, the call signs in again once, retries once, and reports `reloggedIn: true` (see [Automatic re-login](#automatic-re-login)).

### `render_component`
Render a catalog component in the live app and return a **screenshot plus runtime diagnostics** (console errors, uncaught exceptions, failed network requests). Resolves `component` → URL via the route map; or pass a raw `route`. Pass `params` for dynamic segments (e.g. `{"id": "123"}`). The screenshot comes back as an image the agent can look at. For a component that lives inside a one-route shell, pass `section` (see `get_section_map`) — or just name the section's child `component` — and it auto-reveals that section (query-append or activator click) before the shot, reporting how under `viewSection`.

A component **no route renders** — a modal, a tab, a composable (through the components that consume it) — is reached through its nearest routed ancestor. `mountPath` lists each hop with the guard that mounts it; URL-query and section-click reveals are applied. When a hop sits behind app state (a modal's `v-if="showNew"`, or `:is-open="x"`), `targetMounted` is `false` and `captureFlowSteps` is a ready-to-run `capture_flow` plan whose click uses the template's own activator when it can find one (`<TODO>` otherwise). `verify_data_flow` returns verdict `gated` with the same plan rather than reporting the ancestor's traffic as drift.

### `check_page`
The "did my change break anything" workhorse. Navigate to any `url` (absolute, or a path relative to the dev server) and get back a screenshot + console errors + uncaught exceptions + failed network calls. Call it after an edit to confirm the page still renders clean.

### `verify_data_flow`
Source-vs-runtime check. Renders a component's route, watches the **real network traffic**, and checks it against the endpoints `get_data_flow` predicts (child tree and stores included). Matching is method-aware — a predicted `GET /users` no longer "confirms" an observed `DELETE /users`. The key output is **`unexpectedApiCalls`** — observed calls that map to *no* predicted endpoint. That's the real drift signal: dynamic/template-literal URLs, app-level bootstrap fetches outside the component's tree, or genuine divergence. `verdict` is `confirmed` when every observed call is accounted for. (Predicted-but-unobserved endpoints are expected — a render exercises only a slice of what the subtree *could* call — so those are reported as a count, not a list.) Each observed call (matched or unexpected) also carries the response-body summary — `bytes`, `rowCount`, `rowsFrom`, `totalCount` — so drift and payload-shape can be read from one result.

Pass `actions` (same shape as `capture_flow` actions) to drive the page after load and before the network is read — fill the form, click Save, and the resulting `POST` gets verified too. Without actions, only render-time calls (typically GETs) are observable. With `mockApi`, a stubbed call is still matched against the predictions and carries `mocked: true` — so a screen can be verified against an endpoint the server doesn't serve yet.

### `inspect_rendered_page`
The reverse bridge. Opens a live page and reports which **catalog components are actually mounted** on it, mapped back to source files — "what do I edit to change the thing I'm looking at?" without grepping. Works by walking React/Vue dev internals, so it needs the dev build (not prod). Takes a catalog `component`, a `route`, or a raw `url`; returns `{ framework, mounted: [{name, count, relativePath, architectureLayer}], unmatched }`, text-only.

### `capture_flow`
Drive a multi-step user flow against **one page** (fresh for each call) and screenshot each step. A step can navigate (`component`/`route`/`url`), reveal a `section` of the page the flow is on, run **interactions**, or do none of these (settle and screenshot) — so an agent can log in, fill a form, submit, and verify the next screen as one flow. Page state (cookies, form values, SPA route) carries across steps. Each step reports the **API calls it triggered** (`{method, path, status, bytes, rowCount, rowsFrom, totalCount}`), so "did clicking Save actually POST?" *and* "how many rows did that list return?" are answered in the same call. Aggregates diagnostics into a single pass/fail; on a failed action it screenshots the broken state and stops.

> **Response-body summary:** for JSON API responses, each call also carries a payload summary alongside `{method, path, status}` — `bytes` (response size), `rowCount` (rows in the primary collection), `rowsFrom` (which JSON key was counted: `$` for a top-level array, or a key path like `data` / `data.items`), and `totalCount` (a server-reported pagination total, when the body has one). Count-level assertions — "the projects call returned 1578 scoped rows" — no longer need a drop to `curl`. The row heuristic is framework- and app-agnostic: it counts a top-level array, a well-known envelope key (`data`/`results`/`items`/`records`/`content`/`edges`/…), or an object's sole array property, and always reports `rowsFrom` so a wrong guess is visible rather than silent. Bodies are read only for xhr/fetch or `/api/` responses, and only their shape — never their contents — is reported.

Tip: `get_component_detail` exposes each component's `testIds` and `formFields` (with ready-made selectors) — build your steps from those instead of reading source.

Each step's `actions` run in order. Supported action `type`s: `click`, `fill`, `select`, `check`, `uncheck`, `hover`, `press`, `waitFor`, `scroll` (into view, or by `x`/`y`), `wait` (`ms`), the read-only `measure` (bounding box, scroll/client sizes, overflow and computed `properties` → the step's `measurements`), `drag` and `upload` (below). Selectors accept CSS or Playwright engines (`#email`, `text=Submit`, `role=button[name="Save"]`). `fill`/`select` use `text`; `press` uses `key`. A step's `viewport` resizes the page mid-flow.

**`within`** scopes `selector` to one row or card: `{ "type": "click", "selector": "text=Open Kit", "within": "RK-003" }` clicks the Open Kit control in the innermost element that contains both the text `RK-003` and a match for the selector. `selector` may be CSS or any Playwright selector (`text=…`, `role=button[name="Delete"]`, `button >> nth=0`). `within` is **text** (case-insensitive substring; `text=RK-003` is read as that text). To scope by a container selector instead, write `within` with an engine prefix or a `>>` chain: `"css=tr.selected"`, `"tr:has-text(\"RK-003\") >> nth=0"`. When no element holds both, the timeout error says so and shows that form.

**Disabled targets.** Playwright waits for a control to be enabled before `click` / `fill` / `select` / `check` / `uncheck`, and it honours `aria-disabled="true"` (on the element or an ancestor) as well as the native `disabled` attribute. When one of those actions times out on a disabled target the error says which kind it is. For `aria-disabled` it also names the alternative: the control is disabled by design (a precondition is not met — that is the finding), or, if the app still handles activation on it, `{ "type": "press", "selector": "…", "key": "Space" }` (or `"Enter"`), which does not wait for enabled. A natively disabled control cannot be activated at all.

**`drag`** — `{ "type": "drag", "selector": "#chip-3", "toSelector": "#chip-1" }` drops on the target's centre; add `"to": {"x", "y"}` to drop at that offset from the target's top-left, or give only `"to"` to drag by an offset from the source's centre (`{ "type": "drag", "selector": "#thumb", "to": {"x": 120, "y": 0} }` scrubs a slider). It is real pointer input — press, move in `steps` (default 12), release — so it works for pointer-driven widgets (sliders, sortable lists) **and** native HTML5 drag-and-drop (`draggable` + `dragstart`/`drop` with `dataTransfer`). The source is scrolled into view; a drop point outside the viewport is an error, not a silent miss. `within` scopes the source.

**`upload`** — `{ "type": "upload", "selector": "#photo" }` sets files on an `<input type="file">` (hidden inputs behind a styled label work), or, when the selector is any other element, clicks it and answers the **file chooser** it opens (apps that build the input on the fly, e.g. an "Upload video" button). `"files": ["a.png", "/abs/b.mp4"]` (relative paths resolve against the workspace root; several only on a `multiple` input). Without `files` a bundled fixture is picked by the input's `accept`, trying its tokens in order: a 64×48 JPEG (`image/*`, `image/jpeg`, `.jpg`), PNG (`image/png`, `.png`) or a 1-second H.264 MP4 (`video/*`, `video/mp4`, `.mp4`) — all decodable by the browser. Anything else (`.csv`, `.pdf`, `video/quicktime` only, …) needs explicit `files`. `performed` names the files set and how.

**Visible matches are preferred automatically.** Responsive layouts often render the same control twice (a desktop and a hidden mobile variant); actions and `waitFor` target the first *visible* match of the selector, so hidden duplicates never pin a click or wait until timeout, and no `:visible` suffix is needed. If every match stays hidden, the timeout error says so (`N match(es) but none visible`) instead of surfacing a generic retry log. This applies to all action runners: `capture_flow` steps, `verify_data_flow` actions, and the `browser.login` pre-step.

```jsonc
{
  "steps": [
    { "label": "open login", "route": "/login" },
    { "label": "sign in", "actions": [
      { "type": "fill", "selector": "#email", "text": "demo@acme.dev" },
      { "type": "fill", "selector": "#password", "text": "••••••" },
      { "type": "click", "selector": "text=Log in" },
      { "type": "waitFor", "selector": "#dashboard" }
    ]},
    { "label": "verify dashboard", "component": "Dashboard" }
  ]
}
```

Filled values are reported by length, not content, so passwords/tokens don't leak into the transcript.

### Stubbing the API (`mockApi`)

A screen built before its server part exists can't be seen with data: the endpoint 404s, or a new field isn't served yet. `mockApi` on `check_page`, `render_component`, `verify_data_flow` and `capture_flow` (whole flow) answers matching requests with a stub for **that call only**; everything else reaches the real API. The route is installed after login (login traffic is real) and removed when the call ends, **even if it fails** — the shared browser is never left stubbed.

```jsonc
"mockApi": [
  { "path": "/orders/catalog", "json": { "data": [{ "id": 1, "irons": ["5i", "6i"] }] } },
  { "method": "POST", "path": "/orders/*", "status": 201, "json": { "id": 9 } },
  { "path": "**/reports/summary", "query": { "range": "30d" }, "status": 500, "body": "boom" }
]
```

| Field | What it does |
|-------|-------------|
| `path` | Required. The pathname as `apiCalls` shows it, on any origin, case-insensitive, trailing slash ignored. Exact (`/orders/catalog`), glob (`*` = one segment, `**` = any depth — `**/orders/catalog` also matches `/api/v1/orders/catalog`), or regex with a `re:` prefix (`"re:^/orders/\\d+$"` as a JSON string). A full URL also pins the origin; a `?a=b` suffix becomes `query`. |
| `method` | Default `GET`; `"*"` matches any. |
| `query` | Params that must be present with these values (others may be too). |
| `status` | Default 200. |
| `json` / `body` | JSON body (content-type `application/json`) or raw string (`text/plain` unless `headers` sets one). |
| `jsonFile` / `bodyFile` | The same, read from a file: a path relative to the workspace root (e.g. `".atlas-ui/mocks/catalog.json"`). `jsonFile` is parsed and must be valid JSON; `bodyFile` is served as-is with a content-type by extension (`.json`, `.html`, `.xml`, `.csv`, else `text/plain`). Give one of the four body fields per stub. |
| `headers` | Extra response headers. |

Only the requests `apiCalls` counts are matched (xhr/fetch, or a URL under `/api/`), so a stub never intercepts the page, its scripts or images. The result carries `mockApi: { mocks: [{method, path, status, hits}], unmatched?, warning? }`; stubbed calls carry **`mocked: true`** in `apiCalls` (on `check_page` / `render_component`, `apiCalls` is added to the result whenever `mockApi` is passed) and in `verify_data_flow`'s matched/unexpected lists, with the same body summary (`rowCount`, …) as a real response. A stub **no request matched** is listed under `unmatched` with `nearMisses` — observed calls that look like what it meant (same path with another method or query, or the same last segment under another prefix). Bad stubs fail before the browser starts, naming every problem; an unknown key gets a did-you-mean (`url` → `path`, `response` → `json`). Arguments `mocks` / `stubs` are accepted as aliases.

**A body from a file.** A large payload doesn't have to be pasted into every call: write it once under the workspace and name it — `{ "path": "/orders/catalog", "jsonFile": ".atlas-ui/mocks/catalog.json" }`. The path resolves against the workspace root and is **refused if it resolves outside it** (lexically, or through a symlink), so a stub can't serve an arbitrary file from the machine to the page. A missing file, invalid JSON in a `jsonFile`, a file over 5 MB, or two body fields on one stub are reported with the other stub problems before the browser starts. The `mockApi.mocks[]` entry of such a stub carries `file`.

Cross-origin APIs work: while any stub is installed, Playwright answers every CORS preflight itself and adds the allow-origin headers to a stubbed response. Two side effects for that call only: the HTTP cache is off, and a real CORS misconfiguration on the live API won't show (its preflights are answered too).

### Reading response bodies (`captureBodies`)

`apiCalls` reports each call's status, size and row count, not its body. To build a stub shaped like the real response (plus the field the server doesn't serve yet), ask for the body instead of guessing it: `captureBodies` on `check_page`, `render_component`, `verify_data_flow` and `capture_flow` (whole flow) takes path patterns in the same forms as a `mockApi` `path`, each optionally prefixed with a method.

```jsonc
"captureBodies": ["/orders/catalog", "**/customers/*", "POST /orders"]
```

Each matching API call's `apiCalls` entry then carries `responseBody` (on `check_page` / `render_component` / `verify_data_flow`, `apiCalls` is added to the result whenever `captureBodies` is passed; on `capture_flow` it is on each step):

```jsonc
{ "method": "GET", "path": "/orders/catalog", "status": 200, "bytes": 184211, "rowCount": 1578, "rowsFrom": "items",
  "responseBody": {
    "json": { "total": 1578, "items": [ { "id": 0, "sku": "SKU-0" }, { "id": 1, "sku": "SKU-1" } /* …3 more rows */ ] },
    "contentType": "application/json",
    "truncated": true, "originalBytes": 184211,
    "truncation": ["$.items: kept 5 of 1578 rows"] } }
```

| `responseBody` field | Meaning |
|-------|-------------|
| `json` | The parsed body, when it is JSON. |
| `text` | The body as text, when it is not JSON (or JSON that could not be shortened under the cap). |
| `contentType` | The response's content-type, without parameters. |
| `truncated`, `originalBytes`, `truncation` | Present when the body was shortened: `true`, the full size in bytes, and what was cut by JSON path. |
| `redacted` | How many credential-looking values were replaced with `"[redacted]"`. |
| `omitted` | Why there is no body: binary content-type, empty body, over the 5 MB read limit, or the call's budget is used up. |

- **Off unless passed.** Without `captureBodies` no body is read beyond the existing shape summary and the output is unchanged.
- **Bounded.** 16,000 characters per body, 48,000 per call, 20 bodies per call. A JSON body over the cap is shortened structurally — long arrays keep their first rows (5, then 3, 2, 1 as needed), long strings their head — so it is still valid JSON with the real shape, never cut mid-token. Only if that is not enough is the serialized text cut (`text`, with a `truncation` note saying it is not parseable).
- **Not lost to the list's limits.** `apiCalls` dedupes by method + path and stops at 30 calls; a body-carrying entry is kept apart from both, dedupes by method + path + query (its `query` field holds the query string), and a repeat of the same URL is listed again only when its body differs.
- **Secrets stay out.** String values under keys that look like credentials (`token`, `password`, `secret`, `authorization`, `apiKey`, `cookie`, …) and any JWT are replaced with `"[redacted]"`. The login pre-step's traffic is never captured. Bodies can still hold personal data — name only the calls you need.
- The result carries `captureBodies: { patterns: [{pattern, matched}], bodies, chars, limits, truncated?, unmatched?, warning? }`; a pattern no API call matched is listed under `unmatched` with `nearMisses`, like an unmatched stub. Aliases `bodies` / `responseBodies`.

### Who the browser is signed in as (`signedInAs`)

Every runtime result (`check_page`, `render_component`, `verify_data_flow`, `capture_flow`, `inspect_rendered_page`) carries `signedInAs`, and `server_info` carries the same per profile under `login.account` / `login.profiles[].account`:

```jsonc
"signedInAs": {
  "profile": "default", "loginConfigured": true, "loggedIn": true,
  "loginEmail": "qa@acme.dev", "loginEmailFrom": "env APP_EMAIL",
  "app": { "email": "qa@acme.dev", "id": "u-1", "name": "Q A", "roles": ["admin"], "source": "sessionStorage.app_user" },
  "impersonating": { "active": true, "phase": "active", "as": { "email": "coach@acme.dev", "roles": ["coach"], "…": "…" }, "original": { "…": "…" }, "source": "sessionStorage.app_impersonation" },
  "summary": "login: qa@acme.dev (env APP_EMAIL); app user: qa@acme.dev [admin]; impersonating: coach@acme.dev [coach]"
}
```

- **`loginEmail`** is resolved from the login flow's `fill` actions and the env vars they reference — env vars that may exist only in this server's process. Only a value that is an email is reported; a fill whose selector looks like a secret (`password`, `otp`, `token`, …) or whose env var does (`*PASSWORD*`, `*SECRET*`, `*TOKEN*`, …) is never read. An unset env var is named (`env APP_EMAIL — not set in atlas-ui's environment`).
- **`app`** is the app's own signed-in user, read from `localStorage` / `sessionStorage` on the page the call ended on: user-shaped JSON objects (email and/or roles, plus id/name) and JWT claims, ranked by the key they live under, reduced to email / id / name / roles — tokens never appear. No storage key names are configured or hard-coded; `source` names the key it came from and `alsoFound` lists other distinct users found, so a wrong guess is visible. `mismatch: true` when it differs from `loginEmail`.
- **`impersonating`** reads any storage key naming impersonation: the stored phase/flag decides `active`, the user inside it is `as` and one under an `original`/`admin` path is `original`. `false` when a user was found and no such key exists.
- On a public call (`public: true`) `loginSkipped` is set — the context may still hold an earlier session, and `app` says whether it does. When the page ended on another origin, `appUnread` says so.

### Browser configuration

Add a `browser` block to `.atlas-ui.json` (all fields optional — these are the defaults):

```json
{
  "browser": {
    "devServerUrl": "http://localhost:5173",
    "headless": true,
    "viewport": { "width": 1280, "height": 800 },
    "outputDir": ".atlas-ui/captures",
    "routeParams": { "id": "1" }
  }
}
```

| Field | What it does |
|-------|-------------|
| `devServerUrl` | Base URL of your running app. The MCP assumes the dev server is already up. |
| `headless` | Run Chromium headless (default `true`). Set `false` to watch it drive. |
| `viewport` | Screenshot dimensions. |
| `outputDir` | Where screenshots/videos are written (relative to your project, git-ignored). |
| `routeParams` | Default values for dynamic route segments; per-call `params` override them. |
| `idleIgnore` | URL patterns (substring, or glob with `*`) that never hold a navigation's quiet window open. |
| `quietMs` / `quietMaxMs` / `longPollMs` / `navigationTimeoutMs` | Quiet-window tunables (defaults 500 / 10000 / 8000 / 30000). |
| `profiles` | Named extra logins (`{ "coach": { …login block… } }`) selected per call with `loginAs`. |
| `autoRelogin` | Sign in again when an authenticated call finds the session signed out (default `true`; see [Automatic re-login](#automatic-re-login)). |

First-time setup downloads the browser binary:

```bash
npx playwright install chromium
```

### Login pre-step (authenticated routes)

If your app is behind a login, add a `login` block. The session authenticates **once** on first browser use and the login carries over to every later call's fresh page (context storage, plus a `sessionStorage` snapshot) — so protected routes render logged-in. For other roles add `browser.profiles` entries of the same shape and pass `loginAs`. Put **credentials in env vars** and reference them with `${VAR}`; never inline secrets (the config is committed).

```jsonc
{
  "browser": {
    "devServerUrl": "http://localhost:5173",
    "login": {
      "url": "/login",
      "actions": [
        { "type": "fill", "selector": "#email", "text": "${APP_EMAIL}" },
        { "type": "fill", "selector": "#password", "text": "${APP_PASSWORD}" },
        { "type": "click", "selector": "button[type=submit]" }
      ],
      "successSelector": "text=Logout"
    }
  }
}
```

| Field | What it does |
|-------|-------------|
| `url` | Where the login form lives (absolute or dev-server-relative). |
| `actions` | The same action types as `capture_flow` (`fill`, `click`, …). `text` supports `${ENV_VAR}`. |
| `successSelector` | Wait for this to confirm login succeeded (e.g. a "Logout" link). |
| `successUrlIncludes` | Or confirm the URL changed to include this substring. |

The env vars must be visible to the MCP server process (set them in the `env` block of your `mcp.json` server entry). On login failure the session tears down and the next call retries, rather than silently running unauthenticated. Filled values are reported by length, so credentials never appear in tool output.

#### Automatic re-login

Sessions expire during a long agent turn, and a logged-out browser used to show only as a failed click until someone called `reset_login`. Now every authenticated call (`check_page`, `render_component`, `verify_data_flow`, `capture_flow`, `inspect_rendered_page`) checks its **first navigation** once for a signed-out session:

- the page ended on the login page (`login.url`) although the call asked for another URL, or
- the navigation's real API calls answered **401** — all of them, or two or more that are at least half of them (calls a `mockApi` stub answered don't count).

On either signal the profile's browser context is dropped (as `reset_login` does, so no stale cookie or token survives), the login flow runs again, and the call is retried **once** from the start. The result then carries `reloggedIn: true` and `reloginReason` (e.g. `"/orders ended on the login page (/login)"`); a flow restarts from its first step, before any of its actions ran.

It never loops. If the retry is still signed out the call fails with `Still signed out after an automatic re-login: …`; if the login flow itself cannot complete it fails with `The session was signed out and the automatic re-login failed: …`. It does not run for public calls (`"public": true`), for a call that asked for the login page itself, or right after the same call created the session; `loginAs` signs in again only that profile. The check needs the page's requests to have finished, so it is reliable with the default `waitUntil: "quiet"`; a session that expires in the middle of a flow (after its first navigation) is not retried. Set `browser.autoRelogin` to `false` to turn it off.

> **SPA note:** each call gets a fresh page, but `sessionStorage` is snapshotted when a page is retired (and right after login) and seeded into the next page on the app's origin, so a token kept there survives. A failed login reports the URL and `<title>` it stopped on and saves a screenshot.

## License

[MIT](LICENSE) — free for any use, modification, and redistribution. Contributions welcome.
