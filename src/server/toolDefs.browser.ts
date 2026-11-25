/**
 * MCP tool definitions for the browser-driven (runtime verification) tools.
 * Static-analysis tools live in toolDefs.catalog.ts.
 */

// One action of a browser flow (shared by capture_flow steps, verify_data_flow).
const ACTION_ITEM_SCHEMA = {
  type: "object",
  properties: {
    type: {
      type: "string",
      enum: ["click", "fill", "press", "select", "check", "uncheck", "hover", "waitFor", "scroll", "wait", "measure", "drag", "upload"],
      description:
        "Interaction kind. `scroll`: with selector, into view (or by x/y inside that element); without, the page by x/y (neither = to the bottom). `wait`: pause `ms`. `measure` (read-only): bounding box, scroll/client sizes, overflow and computed `properties` of up to 10 matches of `selector`, plus page scroll/overflow — returned in the step's `measurements`. " +
        "`drag`: real pointer drag (press, move in `steps`, release) from `selector` onto `toSelector` (its centre, or `to` as an offset from its top-left) or by `to` {x,y} from the source's centre — works for pointer-driven widgets (sliders, sortable lists) and native HTML5 drag-and-drop. " +
        "`upload`: set `files` on an <input type=file> (hidden inputs work), or click any other element and answer the file chooser it opens; without `files`, a bundled tiny fixture is picked by the input's `accept` (JPEG, PNG or MP4).",
    },
    selector: {
      type: "string",
      description:
        'CSS or Playwright selector, e.g. "#email", "text=Submit", "role=button[name=\\"Save\\"]". ' +
        "Visible matches are preferred automatically — hidden duplicates (responsive variants) are skipped, so no `:visible` suffix is needed. " +
        'A click/fill/select/check that times out on a disabled target says so: for `aria-disabled="true"` the error names the alternative ' +
        '({"type": "press", "selector": …, "key": "Space"} — press does not wait for enabled), or the control is disabled by design and that is the finding.',
    },
    within: {
      type: "string",
      description:
        'Optional row/card scoping: restrict `selector` to the innermost container that also contains this TEXT — e.g. selector "button:has-text(\\"Open Kit\\")" with within "RK-003" clicks that row\'s button, no container CSS needed. ' +
        '`selector` may be any CSS or Playwright selector here ("text=Open Kit", "role=button[name=\\"Delete\\"]", "button >> nth=0"). ' +
        '`within` is text, not a selector ("text=RK-003" is read as the text RK-003); to scope by a container selector instead, write it with an engine prefix or a >> chain: "css=tr.selected", "tr:has-text(\\"RK-003\\") >> nth=0".',
    },
    text: { type: "string", description: "Value to type (fill) or option to choose (select)." },
    key: { type: "string", description: 'Key for press, e.g. "Enter".' },
    timeoutMs: { type: "number", description: "Per-action timeout (default 10000)." },
    x: { type: "number", description: "scroll: horizontal pixels." },
    y: { type: "number", description: "scroll: vertical pixels." },
    ms: { type: "number", description: "wait: milliseconds (default 1000)." },
    properties: {
      type: "array",
      items: { type: "string" },
      description: 'measure: computed-style properties to read (default display, position, overflow-x/y, z-index, font-size), e.g. ["padding-left", "grid-template-columns"].',
    },
    toSelector: { type: "string", description: "drag: the element to drop onto (its centre, or `to` as an offset from its top-left corner)." },
    to: {
      type: "object",
      description: "drag: with toSelector, the drop point inside the target (from its top-left); without, the offset from the source's centre, e.g. {\"x\": 120, \"y\": 0}.",
      properties: { x: { type: "number" }, y: { type: "number" } },
      required: ["x", "y"],
    },
    steps: { type: "number", description: "drag: pointer-move steps between pick-up and drop (default 12)." },
    files: {
      type: "array",
      items: { type: "string" },
      description: "upload: file paths (absolute, or relative to the workspace root). Omit to use a bundled fixture chosen by the input's `accept` (JPEG, PNG, MP4).",
    },
  },
  required: ["type"],
};

// Per-call API stubs, shared by check_page, render_component, verify_data_flow and capture_flow.
const MOCK_API_SCHEMA = {
  type: "array",
  description:
    "API stubs for THIS call only. A page request (xhr/fetch, or a URL under /api/ — the same calls `apiCalls` lists) that matches a stub is " +
    "answered with it; everything else reaches the real API. The stubs are removed when the call ends, even on error. Use it to see a screen " +
    "whose endpoint or field the server doesn't serve yet. Stubbed calls carry `mocked: true` in `apiCalls`; `mockApi.unmatched` lists any stub " +
    "no request matched (with `nearMisses`: observed calls that look like what it meant). Cross-origin calls work (CORS is handled); while stubs are installed every CORS preflight is answered by the browser driver and the HTTP cache is off. " +
    "For a large body, keep it in a file and name it with `jsonFile` instead of pasting it into every call. To get a real response's shape to build a stub from, pass `captureBodies`.",
  items: {
    type: "object",
    properties: {
      method: { type: "string", description: 'HTTP method (default "GET"); "*" matches any.' },
      path: {
        type: "string",
        description:
          'URL pathname as `apiCalls` shows it, on any origin (case-insensitive, trailing slash ignored): exact "/orders/catalog"; glob "/orders/*" (one segment) or "**/orders/catalog" (any prefix, e.g. an API base path); regex "re:^/orders/\\d+$". A full URL also pins the origin; a "?a=b" suffix becomes `query`.',
      },
      query: { type: "object", description: 'Query params that must be present with these values, e.g. {"status": "open"}.' },
      status: { type: "number", description: "Response status (default 200)." },
      json: { description: "JSON response body (any JSON value; content-type application/json)." },
      jsonFile: {
        type: "string",
        description:
          'JSON response body read from a file, instead of `json`: a path relative to the workspace root, e.g. ".atlas-ui/mocks/catalog.json". Refused if it resolves outside the workspace root, is missing, or is not valid JSON (checked before the browser starts).',
      },
      body: { type: "string", description: "Raw response body instead of json (content-type text/plain unless headers set one)." },
      bodyFile: {
        type: "string",
        description:
          "Raw response body read from a file, instead of `body` (same path rule as jsonFile; content-type by extension: .json, .html, .xml, .csv, else text/plain, unless headers set one).",
      },
      headers: { type: "object", description: "Extra response headers." },
    },
    required: ["path"],
  },
};

// Opt-in response bodies, shared by check_page, render_component, verify_data_flow and capture_flow.
const CAPTURE_BODIES_SCHEMA = {
  type: "array",
  items: { type: "string" },
  description:
    "Opt-in RESPONSE BODIES for this call (off unless passed): path patterns, matched like `mockApi` paths — the pathname as `apiCalls` shows it, " +
    'exact "/orders/catalog", glob "/orders/*" or "**/orders/catalog", regex "re:^/orders/\\\\d+$", or a full URL; optionally prefixed with a method ("POST /orders"). ' +
    "Each matching API call's `apiCalls` entry carries `responseBody`: `{json}` (parsed) when the body is JSON, else `{text}`, with `contentType`. " +
    "Use it to copy the real response's shape into a `mockApi` stub instead of guessing it. Bounded: 16000 chars per body, 48000 per call, 20 bodies per call. " +
    "A JSON body over the cap is shortened but stays valid JSON with the real shape (long arrays keep their first rows, long strings their head) and carries " +
    "`truncated: true`, `originalBytes` and `truncation` (what was cut, by JSON path, e.g. \"$.items: kept 3 of 1578 rows\"). Values under token/password/secret-like keys and JWTs " +
    'are replaced with "[redacted]" (`redacted`: how many). A body that is not returned says why in `responseBody.omitted` (binary, empty, budget used up). ' +
    "A body-carrying entry also has `query` when the URL had one, and is never dropped by the 30-call cap on `apiCalls`. The result's `captureBodies` reports what each pattern matched " +
    "and `unmatched` patterns with `nearMisses`. Bodies can hold personal data: name only the calls you need.",
};

// Per-call viewport and login identity, shared by every runtime tool.
const VIEWPORT_SCHEMA = {
  type: "object",
  description:
    'Viewport for THIS call only, e.g. {"width": 375, "height": 812} for a phone breakpoint. The next call gets the configured default.',
  properties: { width: { type: "number" }, height: { type: "number" } },
  required: ["width", "height"],
};
const LOGIN_AS_SCHEMA = {
  type: "string",
  description:
    "Log in as a named browser.profiles entry from .atlas-ui.json (another role) instead of the default browser.login. Each profile has its own browser context and logs in once.",
};
const MEASURE_SCHEMA = {
  type: "array",
  items: { type: "string" },
  description:
    "Selectors to MEASURE (read-only) after the page settles: bounding box, scroll/client sizes, horizontal overflow, default computed styles; plus page-level horizontal overflow. Returned as `measurements`.",
};

// How a navigation decides it is done — shared by check_page and capture_flow.
const WAIT_UNTIL_SCHEMA = {
  type: "string",
  enum: ["quiet", "load", "domcontentloaded", "networkidle"],
  description:
    'Navigation wait strategy. Default "quiet": wait for load, then for a bounded window (≤10 s) with no ' +
    "short-lived request in flight — SSE/websocket streams, long-polls and browser.idleIgnore URLs are " +
    'ignored, so an app holding a realtime stream still settles. "networkidle" never settles while such a ' +
    "stream is open. A stalled wait lists the requests still in flight.",
};

export const BROWSER_TOOLS = [
  {
    name: "render_component",
    description:
      "Render a catalog component in the running app and return a screenshot plus runtime diagnostics (console errors, uncaught exceptions, failed network requests). Resolves the component to its URL automatically via the route map — just name the component you changed. A component no route renders (a modal, a tab, a composable via the components that consume it) is reached through its nearest ROUTED ancestor: the result's `mountPath` lists each hop with the guard that mounts it, URL-query and section-click reveals are applied automatically, and when a hop sits behind app state (a modal's `v-if`) `targetMounted` is false and `captureFlowSteps` is a ready-to-run capture_flow plan (activator clicks found in the template; `<TODO>` where none is). Use this to visually confirm a change actually works. `mockApi` stubs API responses for this call (`jsonFile` for a body kept in a file); `captureBodies` (opt-in) returns the response bodies of the API calls you name under `apiCalls[].responseBody`. If the session had expired, the call signs in again once and retries (`reloggedIn: true`). Requires the dev server to be running.",
    inputSchema: {
      type: "object",
      properties: {
        component: {
          type: "string",
          description:
            'Catalog component name to render (e.g., "OrderDetail"). The route map resolves it to a URL — directly, or through the nearest routed ancestor (see mountPath).',
        },
        file: {
          type: "string",
          description: "Optional path substring choosing one file when the component name is declared in several.",
        },
        route: {
          type: "string",
          description:
            'Optional: render a raw route path directly instead (e.g., "/orders/:id"). Use instead of `component`.',
        },
        section: {
          type: "string",
          description:
            'Optional: reveal a specific in-app section of a one-route shell (see get_section_map) — e.g. section "build-sheets" of a tabbed page. Auto-appends the query param or clicks the section\'s activator after load so the screenshot shows that section, not the container default. You can also just name the section\'s child `component`; it is revealed the same way.',
        },
        params: {
          type: "object",
          description:
            'Values for dynamic route segments, e.g. {"id": "123"}. If omitted, sensible placeholders are guessed.',
        },
        fullPage: {
          type: "boolean",
          description: "Capture the full scrollable page instead of just the viewport (default false).",
        },
        settleMs: {
          type: "number",
          description: "Extra milliseconds to wait after load before screenshotting (e.g. for animations).",
        },
        public: {
          type: "boolean",
          description:
            "Skip the configured login pre-step for this call — use for public routes so a broken/missing credential can't block them (default false).",
        },
        viewport: VIEWPORT_SCHEMA,
        loginAs: LOGIN_AS_SCHEMA,
        mockApi: MOCK_API_SCHEMA,
        captureBodies: CAPTURE_BODIES_SCHEMA,
        measure: MEASURE_SCHEMA,
      },
      required: [],
    },
  },
  {
    name: "check_page",
    description:
      "Navigate to any URL (absolute, or a path relative to the dev server) and return a screenshot plus runtime diagnostics: console errors, uncaught exceptions, and failed network calls. Optional per-call `viewport` (responsive checks), `loginAs` (another role from browser.profiles), `measure` (read-only boxes / overflow / computed styles for selectors), `mockApi` (stub API responses for this call; a stub can read its body from a file with `jsonFile`) and `captureBodies` (opt-in: the response bodies of the API calls you name, on `apiCalls[].responseBody`). `signedInAs` reports which account the browser used (login email + the app's own user, roles, impersonation). If the session had expired, the call signs in again once and retries; the result then carries `reloggedIn: true` and `reloginReason`. The 'did my change break anything' workhorse — call it after editing to confirm the page still renders clean. Requires the dev server to be running.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            'URL or path to check (e.g., "http://localhost:5173/login" or "/login").',
        },
        fullPage: {
          type: "boolean",
          description: "Capture the full scrollable page instead of just the viewport (default false).",
        },
        settleMs: {
          type: "number",
          description: "Extra milliseconds to wait after load before screenshotting (e.g. for animations).",
        },
        waitUntil: WAIT_UNTIL_SCHEMA,
        public: {
          type: "boolean",
          description:
            'Skip the configured login pre-step for this call — use for public routes (e.g. "/landing") so a broken/missing credential can\'t block them (default false).',
        },
        viewport: VIEWPORT_SCHEMA,
        loginAs: LOGIN_AS_SCHEMA,
        mockApi: MOCK_API_SCHEMA,
        captureBodies: CAPTURE_BODIES_SCHEMA,
        measure: MEASURE_SCHEMA,
      },
      required: ["url"],
    },
  },
  {
    name: "verify_data_flow",
    description:
      "Render a component's route and check the REAL network traffic against the endpoints that static analysis (get_data_flow, including child components and stores) predicts. Matching is method-aware. The key output is `unexpectedApiCalls` — observed calls that map to NO predicted endpoint, i.e. real source-vs-runtime drift (dynamic URLs, app-level fetches, or genuine divergence). `verdict` is 'confirmed' when every observed call is accounted for. `captureBodies` (opt-in) returns the response bodies of the API calls you name under `apiCalls[].responseBody`. Pass `actions` to drive interactions (fill/click/...) before the network is read — that's how predicted MUTATION endpoints (POST/PUT/DELETE) get exercised and verified. A target no route renders (modal, tab, composable) is reached through its nearest routed ancestor (`mountPath`); the ancestor's own predicted traffic is then expected too, and `targetEndpoints` reports how many of the TARGET's predicted endpoints were observed. When the target sits behind app state and no `actions` are given, it returns verdict `gated` with `captureFlowSteps` instead of navigating — pass those clicks as `actions`. Requires the dev server to be running.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: 'Component or composable name whose data flow to verify (e.g., "OrderDetail").',
        },
        file: {
          type: "string",
          description: "Optional path substring to disambiguate when the name matches multiple files",
        },
        section: {
          type: "string",
          description:
            'Optional: reveal an in-app section of a one-route shell (see get_section_map) before reading the network — its reveal click runs first, so the section\'s OWN fetches are observed too.',
        },
        params: {
          type: "object",
          description: 'Values for dynamic route segments, e.g. {"id": "123"}.',
        },
        depth: {
          type: "number",
          description: "How deep to trace the child component tree for predictions (default 3).",
        },
        settleMs: {
          type: "number",
          description: "Extra milliseconds to wait before reading the observed network traffic (default 500).",
        },
        actions: {
          type: "array",
          description:
            "Optional interactions to run after the route loads and BEFORE network traffic is evaluated (e.g. fill a form and click Save to exercise a POST).",
          items: ACTION_ITEM_SCHEMA,
        },
        viewport: VIEWPORT_SCHEMA,
        loginAs: LOGIN_AS_SCHEMA,
        mockApi: MOCK_API_SCHEMA,
        captureBodies: CAPTURE_BODIES_SCHEMA,
      },
      required: ["name"],
    },
  },
  {
    name: "capture_flow",
    description:
      "Drive a multi-step user flow against a SINGLE persistent page and screenshot each step. Each step can navigate (component/route/url/section) and/or run interactions (click, fill, select, press, check, hover, waitFor, scroll, wait, and the read-only measure) — so you can log in, fill a form, submit, and verify the next screen as one flow. Each call opens a FRESH page (auth carries over; a previous call's open modal does not); `viewport` and `loginAs` (a browser.profiles role) apply to the whole flow, and a step's `viewport` resizes mid-flow. State (cookies, form values, SPA route) carries across steps. Each step reports the API calls it triggered ({method, path, status}) so you can confirm a click actually fired its mutation. Actions include `drag` (real pointer drag: sliders, sortable lists, HTML5 drag-and-drop) and `upload` (file inputs and file-chooser buttons; a bundled JPEG/PNG/MP4 when no `files` are given). `mockApi` stubs API responses for the whole flow (e.g. an endpoint the server doesn't have yet; a stub can read its body from a file with `jsonFile`). `captureBodies` (opt-in) adds the response body of the API calls you name to each step's `apiCalls` (`responseBody`), so a stub can copy the real shape. The result's `signedInAs` says which account the browser used (login email + the app's own user, roles, impersonation). If the session had expired when the flow started, it signs in again once and restarts from its first step (`reloggedIn: true`, `reloginReason`); if it is still signed out after that, the call fails saying so. A click that times out on a disabled control says so and names the alternative; `within` works with Playwright-syntax selectors. Aggregates diagnostics into a single pass/fail; on a failed action it screenshots the broken state and stops. Requires the dev server to be running.",
    inputSchema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description:
            "Ordered list of steps. A step may navigate (component/route/url), reveal a `section` of the page the flow is on, run actions, or do none of these — a step with only label/settleMs just settles and screenshots the current page.",
          items: {
            type: "object",
            properties: {
              component: { type: "string", description: "Catalog component name to navigate to (resolved to a URL via the route map)." },
              route: { type: "string", description: "Route path to navigate to." },
              url: { type: "string", description: "Absolute URL to navigate to." },
              section: {
                type: "string",
                description:
                  "Reveal this in-app section (see get_section_map; matched case- and whitespace-insensitively). With component/route/url it applies to that page; ALONE it navigates within the page the flow is already on (query sections re-navigate with the param set; click sections prepend the activator click). An unknown id is an error listing the valid ones.",
              },
              params: { type: "object", description: "Dynamic route segment values, e.g. {\"id\": \"123\"}." },
              actions: {
                type: "array",
                description: "Interactions to run after navigating (or on the current page if there's no navigation target). Run in order.",
                items: ACTION_ITEM_SCHEMA,
              },
              label: { type: "string", description: "Human label for this step in the report." },
              settleMs: { type: "number", description: "Extra ms to wait after this step before screenshotting." },
              waitUntil: { ...WAIT_UNTIL_SCHEMA, description: "This step's navigation wait strategy (overrides the flow-level waitUntil)." },
              noScreenshot: { type: "boolean", description: "Skip the screenshot for this step." },
              continueOnError: { type: "boolean", description: "Continue the flow even if an action in this step fails." },
              viewport: { ...VIEWPORT_SCHEMA, description: "Resize the flow's page before this step (persists for later steps)." },
            },
          },
        },
        settleMs: {
          type: "number",
          description: "Default extra ms to wait after each step before screenshotting (per-step settleMs overrides).",
        },
        waitUntil: WAIT_UNTIL_SCHEMA,
        public: {
          type: "boolean",
          description:
            "Skip the configured login pre-step for the whole flow — use for flows that stay on public routes so a broken/missing credential can't block them (default false).",
        },
        viewport: VIEWPORT_SCHEMA,
        loginAs: LOGIN_AS_SCHEMA,
        mockApi: MOCK_API_SCHEMA,
        captureBodies: CAPTURE_BODIES_SCHEMA,
      },
      required: ["steps"],
    },
  },
  {
    name: "reset_login",
    description:
      "Recover the browser's authenticated session in-place: re-reads .atlas-ui.json (so a browser.login block added or fixed after server startup takes effect — no restart needed), clears cookies/storage and any stuck login error, then (by default) re-runs the configured login flow immediately. Use this when authed runtime tools (render_component/check_page/capture_flow on protected routes) start failing with a login error, or right after adding/changing browser.login config. An expired session no longer needs it: an authed call that finds the session signed out signs in again once by itself and reports `reloggedIn: true`; call reset_login when that call fails with 'Still signed out after an automatic re-login' or 'the automatic re-login failed'. No-op with a note if no browser.login is configured even after the re-read. Public routes never need this; pass \"public\": true on those tools to skip login entirely.",
    inputSchema: {
      type: "object",
      properties: {
        relogin: {
          type: "boolean",
          description:
            "Re-run the login flow immediately after resetting (default true). Set false to just clear state and let the next authed call trigger login.",
        },
        loginAs: {
          type: "string",
          description: "Reset only this browser.profiles login (default: reset every profile, re-login the default).",
        },
      },
      required: [],
    },
  },
  {
    name: "inspect_rendered_page",
    description:
      "The reverse bridge: open a live page and report which CATALOG components are actually mounted on it, mapped back to their source files. Walks React/Vue dev internals in the running app — use it to go from 'the thing I see on screen' to 'the file I should edit' without grepping. Give a catalog `component`, a `route`, or a raw `url`. Text-only output (use render_component for a screenshot). Requires the dev server (dev build) to be running.",
    inputSchema: {
      type: "object",
      properties: {
        component: {
          type: "string",
          description: "Catalog component name whose route to open (resolved via the route map).",
        },
        route: { type: "string", description: 'Route path to open (e.g., "/orders/:id").' },
        url: { type: "string", description: "Absolute URL or dev-server-relative path to open." },
        section: {
          type: "string",
          description:
            "Optional: reveal an in-app section of a one-route shell (see get_section_map) before inspecting, so its mounted components are what get reported.",
        },
        params: {
          type: "object",
          description: 'Values for dynamic route segments, e.g. {"id": "123"}.',
        },
        settleMs: {
          type: "number",
          description: "Extra milliseconds to wait after load before inspecting.",
        },
        viewport: VIEWPORT_SCHEMA,
        loginAs: LOGIN_AS_SCHEMA,
      },
      required: [],
    },
  },
];
