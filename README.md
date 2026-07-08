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

Catalog-wide listings and search results return compact summaries to keep token cost down; `get_component_detail` has the full metadata, and `list_all_components` accepts `verbose: true` when you really want everything. When a name matches multiple files, name-based tools return an `ambiguous` result with candidates instead of guessing — re-call with `file` (a path substring) to pick one.

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

**Vue** — scans `src/components` (.vue), `src/views` + `src/pages` (.vue), `src/composables` (.ts), `src/services` (.ts), `src/adapters` (.ts), `src/stores` + `src/store` (.ts). Routes from `src/router/index.ts`, plus Nuxt `pages/` file routes when `nuxt` is a dependency.

## Tools

### `list_all_components`
Compact catalog listing: `{ totalCount, lastScanned, byLayer, components }` where each entry is a summary (name, layer, category, path, description, route). Filter with `layer`; pass `verbose: true` for full metadata objects.

### `search_components`
Fuzzy search across the whole codebase by name, path, or keywords. Multi-token scoring, ranked by relevance. Returns compact summaries with `_score`; `limit` caps results (default 20).

### `get_component_props`
Returns the TypeScript prop interface for a component — prop names, types, required/optional, defaults, and JSDoc descriptions. Accepts a catalog `name` or a `componentPath`; failures come back as `{ error }` with the reason.

### `find_similar_components`
Describe what you're looking for in plain English and it finds matching components using keyword + structural matching (hooks used, child components, data fetching patterns, layer). Returns compact summaries.

### `get_component_detail`
Full metadata dump for any item — props, hooks, state, children, event handlers, data fetching, `testIds` and `formFields` (drivable selectors for `capture_flow`), accessibility info, API endpoints, architecture layer.

### `find_component_usages`
Find everywhere a component/hook/service is imported or rendered. Returns files, parent components, and line numbers. Also scans entry points (`App.tsx`, `main.tsx`, layouts) and route files that live outside scan targets. Good for impact analysis before making changes.

### `whats_affected`
The edit→verify glue. Give it changed files (or let it read `git status`) and it walks the dependency graph upstream to every affected component and page, maps those to routes, and returns concrete `check_page` / `render_component` suggestions. Edit → `whats_affected` → check exactly what matters.

### `get_architecture_overview`
High-level view of the whole app — counts by layer, category breakdown, data flow chains, and the route map.

### `get_dependency_chain`
Traces upstream (what uses it) and downstream (what it depends on) for any item. Supports recursive depth 1-3.

### `get_route_map`
Full route → page → component mapping with protection status, hooks used, child components, dynamic segments, and nested routes. Covers React Router, Vue Router, and file-based routing (Next.js App/Pages Router, Nuxt).

### `get_hook_detail`
Deep dive on a hook/composable — parameters, return type, query keys, adapter calls, data fetching pattern, and which components use it.

### `find_dead_code`
Finds exported items that are never imported anywhere. Optionally filter by layer. Components referenced only from entry points or route files are correctly treated as live.

### `get_data_flow`
Traces the full data path: component → composable/hook/store → service → adapter → API endpoint — **including endpoints fetched by child components** (a page rarely fetches everything itself). Store-mediated flows (Pinia/Zustand) surface in a `stores` step per chain. Walks the child render tree (bounded by `depth`, default 3, plus a cycle-guard). Each chain is tagged with the `via` render path that reached it, and `allEndpoints` gives the union of everything the rendered route hits. Saves you from manually chaining `get_component_detail` + `get_hook_detail` calls.

> **Name collisions:** `get_component_detail`, `get_component_props`, `get_hook_detail`, `get_dependency_chain`, and `get_data_flow` return `{ ambiguous: true, candidates: [...] }` when a name matches multiple files, instead of silently picking one. Re-call with `file` (a path substring) to disambiguate.

## Runtime browser tools — let agents check their work

The tools above understand your code statically. These five drive a real (headless) browser against your **running app**, so an agent can *see* the result of a change instead of guessing. They reuse the static catalog — the route map resolves a component to its URL automatically, so you name the component you changed and the browser knows where to go.

Powered by Playwright/Chromium. They require your dev server to be running and degrade gracefully — the static tools work even if the browser binaries aren't installed.

### `render_component`
Render a catalog component in the live app and return a **screenshot plus runtime diagnostics** (console errors, uncaught exceptions, failed network requests). Resolves `component` → URL via the route map; or pass a raw `route`. Pass `params` for dynamic segments (e.g. `{"id": "123"}`). The screenshot comes back as an image the agent can look at.

### `check_page`
The "did my change break anything" workhorse. Navigate to any `url` (absolute, or a path relative to the dev server) and get back a screenshot + console errors + uncaught exceptions + failed network calls. Call it after an edit to confirm the page still renders clean.

### `verify_data_flow`
Source-vs-runtime check. Renders a component's route, watches the **real network traffic**, and checks it against the endpoints `get_data_flow` predicts (child tree and stores included). Matching is method-aware — a predicted `GET /users` no longer "confirms" an observed `DELETE /users`. The key output is **`unexpectedApiCalls`** — observed calls that map to *no* predicted endpoint. That's the real drift signal: dynamic/template-literal URLs, app-level bootstrap fetches outside the component's tree, or genuine divergence. `verdict` is `confirmed` when every observed call is accounted for. (Predicted-but-unobserved endpoints are expected — a render exercises only a slice of what the subtree *could* call — so those are reported as a count, not a list.)

Pass `actions` (same shape as `capture_flow` actions) to drive the page after load and before the network is read — fill the form, click Save, and the resulting `POST` gets verified too. Without actions, only render-time calls (typically GETs) are observable.

### `inspect_rendered_page`
The reverse bridge. Opens a live page and reports which **catalog components are actually mounted** on it, mapped back to source files — "what do I edit to change the thing I'm looking at?" without grepping. Works by walking React/Vue dev internals, so it needs the dev build (not prod). Takes a catalog `component`, a `route`, or a raw `url`; returns `{ framework, mounted: [{name, count, relativePath, architectureLayer}], unmatched }`, text-only.

### `capture_flow`
Drive a multi-step user flow against a **single persistent page** and screenshot each step. A step can navigate (`component`/`route`/`url`) and/or run **interactions** — so an agent can log in, fill a form, submit, and verify the next screen as one flow. Page state (cookies, form values, SPA route) carries across steps. Each step reports the **API calls it triggered** (`{method, path, status}`), so "did clicking Save actually POST?" is answered in the same call. Aggregates diagnostics into a single pass/fail; on a failed action it screenshots the broken state and stops.

Tip: `get_component_detail` exposes each component's `testIds` and `formFields` (with ready-made selectors) — build your steps from those instead of reading source.

Each step's `actions` run in order. Supported action `type`s: `click`, `fill`, `select`, `check`, `uncheck`, `hover`, `press`, `waitFor`. Selectors accept CSS or Playwright engines (`#email`, `text=Submit`, `role=button[name="Save"]`). `fill`/`select` use `text`; `press` uses `key`.

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

First-time setup downloads the browser binary:

```bash
npx playwright install chromium
```

### Login pre-step (authenticated routes)

If your app is behind a login, add a `login` block. The session authenticates **once** on first browser use, and because every tool shares a single page, that session persists across all calls — so protected routes render logged-in. Put **credentials in env vars** and reference them with `${VAR}`; never inline secrets (the config is committed).

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

> **SPA note:** all browser tools share one page so in-app/session-storage auth survives navigation. If your app stores its token in `sessionStorage` (common), a per-page approach would lose it — sharing the page is what makes the login pre-step stick.

## License

[MIT](LICENSE) — free for any use, modification, and redistribution. Contributions welcome.
