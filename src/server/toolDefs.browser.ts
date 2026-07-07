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
      enum: ["click", "fill", "press", "select", "check", "uncheck", "hover", "waitFor"],
      description: "Interaction kind.",
    },
    selector: {
      type: "string",
      description: 'CSS or Playwright selector, e.g. "#email", "text=Submit", "role=button[name=\\"Save\\"]".',
    },
    within: {
      type: "string",
      description:
        'Optional row/card scoping: restrict `selector` to the innermost container that also contains this text — e.g. selector "button:has-text(\\"Open Kit\\")" with within "RK-003" clicks that row\'s button, no container CSS needed.',
    },
    text: { type: "string", description: "Value to type (fill) or option to choose (select)." },
    key: { type: "string", description: 'Key for press, e.g. "Enter".' },
    timeoutMs: { type: "number", description: "Per-action timeout (default 10000)." },
  },
  required: ["type"],
};

export const BROWSER_TOOLS = [
  {
    name: "render_component",
    description:
      "Render a catalog component in the running app and return a screenshot plus runtime diagnostics (console errors, uncaught exceptions, failed network requests). Resolves the component to its URL automatically via the route map — just name the component you changed. Use this to visually confirm a change actually works. Requires the dev server to be running.",
    inputSchema: {
      type: "object",
      properties: {
        component: {
          type: "string",
          description:
            'Catalog component name to render (e.g., "PatientDetail"). The route map resolves it to a URL.',
        },
        route: {
          type: "string",
          description:
            'Optional: render a raw route path directly instead (e.g., "/patients/:id"). Use instead of `component`.',
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
      },
      required: [],
    },
  },
  {
    name: "check_page",
    description:
      "Navigate to any URL (absolute, or a path relative to the dev server) and return a screenshot plus runtime diagnostics: console errors, uncaught exceptions, and failed network calls. The 'did my change break anything' workhorse — call it after editing to confirm the page still renders clean. Requires the dev server to be running.",
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
        waitUntil: {
          type: "string",
          enum: ["load", "domcontentloaded", "networkidle"],
          description: "Navigation wait strategy (default networkidle).",
        },
        public: {
          type: "boolean",
          description:
            'Skip the configured login pre-step for this call — use for public routes (e.g. "/landing") so a broken/missing credential can\'t block them (default false).',
        },
      },
      required: ["url"],
    },
  },
  {
    name: "verify_data_flow",
    description:
      "Render a component's route and check the REAL network traffic against the endpoints that static analysis (get_data_flow, including child components and stores) predicts. Matching is method-aware. The key output is `unexpectedApiCalls` — observed calls that map to NO predicted endpoint, i.e. real source-vs-runtime drift (dynamic URLs, app-level fetches, or genuine divergence). `verdict` is 'confirmed' when every observed call is accounted for. Pass `actions` to drive interactions (fill/click/...) before the network is read — that's how predicted MUTATION endpoints (POST/PUT/DELETE) get exercised and verified. Requires the dev server to be running.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: 'Component or composable name whose data flow to verify (e.g., "PatientDetail").',
        },
        file: {
          type: "string",
          description: "Optional path substring to disambiguate when the name matches multiple files",
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
      },
      required: ["name"],
    },
  },
  {
    name: "capture_flow",
    description:
      "Drive a multi-step user flow against a SINGLE persistent page and screenshot each step. Each step can navigate (component/route/url) and/or run interactions (click, fill, select, press, check, hover, waitFor) — so you can log in, fill a form, submit, and verify the next screen as one flow. State (cookies, form values, SPA route) carries across steps. Each step reports the API calls it triggered ({method, path, status}) so you can confirm a click actually fired its mutation. Aggregates diagnostics into a single pass/fail; on a failed action it screenshots the broken state and stops. Requires the dev server to be running.",
    inputSchema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: "Ordered list of steps. A step must have a navigation target and/or actions.",
          items: {
            type: "object",
            properties: {
              component: { type: "string", description: "Catalog component name to navigate to (resolved to a URL via the route map)." },
              route: { type: "string", description: "Route path to navigate to." },
              url: { type: "string", description: "Absolute URL to navigate to." },
              params: { type: "object", description: "Dynamic route segment values, e.g. {\"id\": \"123\"}." },
              actions: {
                type: "array",
                description: "Interactions to run after navigating (or on the current page if there's no navigation target). Run in order.",
                items: ACTION_ITEM_SCHEMA,
              },
              label: { type: "string", description: "Human label for this step in the report." },
              settleMs: { type: "number", description: "Extra ms to wait after this step before screenshotting." },
              noScreenshot: { type: "boolean", description: "Skip the screenshot for this step." },
              continueOnError: { type: "boolean", description: "Continue the flow even if an action in this step fails." },
            },
          },
        },
        settleMs: {
          type: "number",
          description: "Default extra ms to wait after each step before screenshotting (per-step settleMs overrides).",
        },
        public: {
          type: "boolean",
          description:
            "Skip the configured login pre-step for the whole flow — use for flows that stay on public routes so a broken/missing credential can't block them (default false).",
        },
      },
      required: ["steps"],
    },
  },
  {
    name: "reset_login",
    description:
      "Recover the browser's authenticated session in-place: clears cookies/storage and any stuck login error, then (by default) re-runs the configured login flow immediately. Use this when authed runtime tools (render_component/check_page/capture_flow on protected routes) start failing with a login error — it's the in-session equivalent of restarting the server, without losing the browser. No-op with a note if no browser.login is configured. Public routes never need this; pass \"public\": true on those tools to skip login entirely.",
    inputSchema: {
      type: "object",
      properties: {
        relogin: {
          type: "boolean",
          description:
            "Re-run the login flow immediately after resetting (default true). Set false to just clear state and let the next authed call trigger login.",
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
        route: { type: "string", description: 'Route path to open (e.g., "/patients/:id").' },
        url: { type: "string", description: "Absolute URL or dev-server-relative path to open." },
        params: {
          type: "object",
          description: 'Values for dynamic route segments, e.g. {"id": "123"}.',
        },
        settleMs: {
          type: "number",
          description: "Extra milliseconds to wait after load before inspecting.",
        },
      },
      required: [],
    },
  },
];
