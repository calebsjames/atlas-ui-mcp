#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import path from "path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "url";
import { loadConfig } from "./config/configLoader.js";
import { ComponentScanner } from "./scanner/componentScanner.js";
import { PropParser } from "./parser/propParser.js";
import { CacheManager } from "./cache/cacheManager.js";
import { RouteAnalyzer } from "./analyzer/routeAnalyzer.js";
import { listAllComponents } from "./tools/listAllComponents.js";
import { searchComponents } from "./tools/searchComponents.js";
import { getComponentProps } from "./tools/getComponentProps.js";
import { findSimilarComponents } from "./tools/findSimilarComponents.js";
import { getComponentDetail } from "./tools/getComponentDetail.js";
import { findComponentUsages } from "./tools/findComponentUsages.js";
import { getArchitectureOverview } from "./tools/getArchitectureOverview.js";
import { getDependencyChain } from "./tools/getDependencyChain.js";
import { getRouteMap } from "./tools/getRouteMap.js";
import { getHookDetail } from "./tools/getHookDetail.js";
import { findDeadCode } from "./tools/findDeadCode.js";
import { getDataFlow } from "./tools/getDataFlow.js";
import { BrowserSession } from "./browser/session.js";
import { checkPage } from "./tools/checkPage.js";
import { renderComponent } from "./tools/renderComponent.js";
import { resetLogin } from "./tools/resetLogin.js";
import { findDanglingListeners } from "./tools/findDanglingListeners.js";
import { auditTemplatePatterns } from "./tools/auditTemplatePatterns.js";
import { verifyDataFlow } from "./tools/verifyDataFlow.js";
import { captureFlow } from "./tools/captureFlow.js";
import { inspectRenderedPage } from "./tools/inspectRenderedPage.js";
import { whatsAffected } from "./tools/whatsAffected.js";
import { intelStatus } from "./tools/intelStatus.js";
import type { ArchitectureLayer } from "./types.js";

// Get workspace root from env, CLI arg, or fall back to parent of mcp-server directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(
  process.env.WORKSPACE_ROOT || process.argv[2] || path.resolve(__dirname, "../../")
);

/**
 * Populate process.env from the workspace's .env so `${ENV_VAR}` references in
 * `.atlas-ui.json` (e.g. browser.login credentials) resolve
 * without inlining secrets anywhere git-tracked. Secrets stay solely in the
 * (gitignored) .env; the committed config only names the vars. Existing env
 * vars are never overridden, and a missing/unreadable .env is a no-op.
 */
function loadWorkspaceDotEnv(workspaceRoot: string): void {
  let raw: string;
  try {
    raw = readFileSync(path.join(workspaceRoot, ".env"), "utf-8");
  } catch {
    return; // no .env — nothing to load
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const withoutExport = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length)
      : trimmed;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!key || key in process.env) continue; // never override a real env var
    let value = withoutExport.slice(eq + 1).trim();
    // Strip a single layer of matching surrounding quotes; leave the rest of the
    // value intact so credentials containing #, =, etc. are preserved verbatim.
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadWorkspaceDotEnv(WORKSPACE_ROOT);

// Load configuration
const config = await loadConfig(WORKSPACE_ROOT);

// Initialize services with config
const scanner = new ComponentScanner(WORKSPACE_ROOT, config);
const parser = new PropParser();
const cache = new CacheManager();
const routeAnalyzer = new RouteAnalyzer(WORKSPACE_ROOT, config);
const browserConfig = config.browser || {};
const browser = new BrowserSession(WORKSPACE_ROOT, browserConfig);

const LAYER_ENUM = [
  "component", "page", "hook", "service", "adapter", "context", "store", "dto", "type", "util", "root",
];

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

// MCP Tool Definitions
const TOOLS = [
  {
    name: "list_all_components",
    description:
      "List the codebase catalog as compact summaries: { totalCount, lastScanned, byLayer, components } where each entry has name, architecture layer, category, relative path, and description/routePath when present. byLayer counts cover the whole catalog; `layer` filters the components list. Pass verbose:true for full metadata objects (large). Follow up with get_component_detail for one item's full data.",
    inputSchema: {
      type: "object",
      properties: {
        layer: {
          type: "string",
          description: "Optional: filter the components list to one architecture layer",
          enum: LAYER_ENUM,
        },
        verbose: {
          type: "boolean",
          description:
            "Return full Component objects instead of compact summaries (default false; large output)",
        },
      },
      required: [],
    },
  },
  {
    name: "search_components",
    description:
      "Search across the full codebase (components, pages, hooks, services, adapters, stores, DTOs, types) by name, path, description, or keywords. Uses fuzzy matching and multi-token scoring. Returns compact summaries (name, layer, path, _score) ranked by relevance — follow up with get_component_detail / get_component_props for full data.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Search query - component name, keyword, or multi-word phrase (e.g., "patient card", "handoff button")',
        },
        layer: {
          type: "string",
          description:
            "Optional: filter results to a specific architecture layer",
          enum: LAYER_ENUM,
        },
        limit: {
          type: "number",
          description: "Maximum results to return (default 20)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_component_props",
    description:
      "Get TypeScript prop interface for a specific component. Returns prop names, types, required status, default values, and JSDoc descriptions. Supports both interface and type alias prop definitions. Provide either `name` (catalog lookup) or `componentPath` (file path). If the result is `ambiguous`, re-call with `file` to disambiguate.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: 'Catalog component name (e.g., "Button"). Alternative to componentPath.',
        },
        componentPath: {
          type: "string",
          description:
            'Relative path to component file from workspace root (e.g., "src/components/ui/button.tsx")',
        },
        file: {
          type: "string",
          description: "Optional path substring to disambiguate when `name` matches multiple files",
        },
      },
      required: [],
    },
  },
  {
    name: "find_similar_components",
    description:
      "Find components similar to a natural language description using keyword AND structural matching. Scores based on name, hooks, child components, data fetching pattern, and architecture layer. Returns up to 15 results.",
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description:
            'Natural language description (e.g., "button for submitting forms", "hook that fetches patient data")',
        },
      },
      required: ["description"],
    },
  },
  {
    name: "get_component_detail",
    description:
      "Get detailed information about a specific component, page, hook, service, adapter, or store by name. Returns full metadata including props, hooks, state, child components, event handlers, data fetching pattern, test ids, form-field selectors, accessibility, API endpoints, and architecture layer. If the name matches multiple items, returns `ambiguous` with candidates — re-call with `file`.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            'Item name (e.g., "Button", "PatientDetail", "useHandoffState", "patientAdapter")',
        },
        file: {
          type: "string",
          description:
            "Optional file path to disambiguate if multiple items have the same name",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "find_component_usages",
    description:
      "Find where a component, hook, or service is used (imported and rendered in templates/JSX) across the entire codebase. Searches components, pages, hooks, services, etc. Returns files, parent items, and line numbers with usage type (template, jsx, or import). Useful for impact analysis.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            'Name to search for (e.g., "Button", "useHandoffState", "patientService")',
        },
      },
      required: ["name"],
    },
  },
  {
    name: "get_architecture_overview",
    description:
      "Get a high-level overview of the entire application architecture. Returns counts by layer (components, pages, hooks, services, adapters, contexts), category breakdown, data flow chains (page -> hook -> service), and route map.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_dependency_chain",
    description:
      "Get the full dependency chain for any component, hook, or service. Returns both upstream (what uses it) and downstream (what it depends on) relationships. Supports recursive traversal with depth parameter (1-3). Useful for understanding impact of changes and tracing data flow.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            'Item name (e.g., "CompleteHandoffButton", "useHandoffState")',
        },
        depth: {
          type: "number",
          description:
            "Recursion depth (1-3, default 1). Depth 2+ includes nested dependsOn/usedBy on child nodes.",
        },
        file: {
          type: "string",
          description: "Optional path substring to disambiguate when the name matches multiple files",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "get_route_map",
    description:
      "Get the complete route -> page -> component mapping. Returns all routes (React Router or Vue Router) with their page components, protection status, hooks/composables used, child components rendered, dynamic segments, and nested route hierarchy.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_hook_detail",
    description:
      "Get detailed information about a custom hook or Vue composable. Returns parameters, return type, query keys, adapter/service calls, data fetching pattern, and which components use this hook/composable. If the name matches multiple hooks, returns `ambiguous` with candidates — re-call with `file`.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: 'Hook name (e.g., "useHandoffState", "usePatientData")',
        },
        file: {
          type: "string",
          description: "Optional path substring to disambiguate when the name matches multiple files",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "find_dead_code",
    description:
      "Find dead code — exported components, hooks, services, and adapters that are never imported or used anywhere else in the codebase. Returns unused exports with reasons explaining why they appear unused. Useful for codebase cleanup.",
    inputSchema: {
      type: "object",
      properties: {
        layer: {
          type: "string",
          description:
            "Optional: limit dead code search to a specific architecture layer",
          enum: LAYER_ENUM,
        },
      },
      required: [],
    },
  },
  {
    name: "get_data_flow",
    description:
      "Trace the full data path from a component through composables/stores → services → adapters → API endpoints, INCLUDING data fetched by child components. Returns per-chain detail (each tagged with the `via` render path that reached it) plus `allEndpoints` — the union of every endpoint the rendered route hits. Store-mediated flows (Pinia/Zustand) are traced too. If the name matches multiple items, returns `ambiguous` with candidates — re-call with `file`.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            'Component or composable name (e.g., "ProjectModal", "useProjectModal")',
        },
        depth: {
          type: "number",
          description:
            "How deep into the child component tree to trace (default 3). 0 = the target's own calls only.",
        },
        file: {
          type: "string",
          description: "Optional path substring to disambiguate when the name matches multiple files",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "find_dangling_listeners",
    description:
      "Find dead event wiring across the catalog: a parent binds @some-event on a child component that never fires it — either the child DECLARES the event but never emit()s it (dead plumbing), or it neither declares nor emits it (a typo/renamed event). Native DOM events and children with dynamic/undeclared emit APIs are excluded to avoid false positives. This is the cross-component companion to the per-component emitsDead/emitsFired fields (see get_component_detail). Vue only. Pass `file` to scope to parents under a path substring.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Optional path substring — only check parent components whose path matches.",
        },
      },
      required: [],
    },
  },
  {
    name: "audit_template_patterns",
    description:
      "Repo-wide template-layer design-drift audit for Vue overlays/modals — the one-call replacement for grepping overlay classes, backdrop @click handlers, Teleport, z-index, and header markup. Returns per-component signals (overlays + whether the backdrop click uses .self, Teleport target, z-index values, headings) plus synthesized findings: backdrop-click-missing-self, overlay-not-teleported, modal-no-heading, zindex-exceeds-max (only when templatePatterns.maxZIndex is configured), and more. Raw per-component signals are also on get_component_detail.templatePatterns. Vue only. Pass `file` to scope by path substring.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Optional path substring — only audit components whose path matches.",
        },
      },
      required: [],
    },
  },
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
  {
    name: "whats_affected",
    description:
      "The edit→verify glue: given changed files (or auto-detected from git status when omitted), walk the dependency graph UPSTREAM to find every component/page affected by the change, map those to routes, and return concrete verification targets — ready-to-run check_page/render_component suggestions. Call it after editing to know exactly what to re-check in the browser.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description:
            'Workspace-relative changed files (e.g., ["src/hooks/useUsers.ts"]). Omit to auto-detect from git status.',
        },
        offset: {
          type: "number",
          description:
            "Skip this many affected items (for paging past the default 100-item page). Default 0.",
        },
        maxItems: {
          type: "number",
          description: "Page size for affectedItems (max 500). Default 100.",
        },
        maxDistance: {
          type: "number",
          description:
            "Cap the upstream walk at this distance (1 = direct users only). Default 5.",
        },
      },
      required: [],
    },
  },
  {
    name: "intel_status",
    description:
      "Health check for this MCP server: detected framework, scan targets with per-directory file counts, catalog totals by layer, route file/route counts, dev-server reachability, Playwright/login state, and actionable warnings (e.g. an empty catalog with candidate directories to add to .atlas-ui.json). Call this FIRST if any tool returns empty/unexpected results — an empty catalog usually means misconfigured scanTargets, not an empty codebase.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

// Create MCP server
const server = new Server(
  {
    name: "atlas-ui",
    version: "2.2.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Setup file watcher for cache invalidation
let stopWatching: (() => void) | null = null;

scanner
  .watch(() => {
    console.error("File change detected, invalidating cache...");
    cache.invalidateCatalog();
  })
  .then((stop: () => void) => {
    stopWatching = stop;
  });

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

function jsonResponse(data: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function requireStringArg(args: Record<string, unknown> | undefined, key: string): string {
  if (!args || typeof args[key] !== "string") {
    throw new Error(`Missing required argument: ${key} (string)`);
  }
  return args[key] as string;
}

async function handleToolCall(name: string, args?: Record<string, unknown>) {
  switch (name) {
    case "list_all_components":
      return listAllComponents(scanner, cache, {
        layer: args?.layer as ArchitectureLayer | undefined,
        verbose: args?.verbose as boolean | undefined,
      });

    case "search_components":
      return searchComponents(requireStringArg(args, "query"), scanner, cache, {
        layer: args?.layer as ArchitectureLayer | undefined,
        limit: args?.limit as number | undefined,
      });

    case "get_component_props": {
      if (typeof args?.componentPath !== "string" && typeof args?.name !== "string") {
        return {
          error: 'Provide either "name" (catalog lookup) or "componentPath" (file path).',
        };
      }
      return getComponentProps(
        {
          componentPath: args?.componentPath as string | undefined,
          name: args?.name as string | undefined,
          file: args?.file as string | undefined,
        },
        WORKSPACE_ROOT, parser, cache, scanner
      );
    }

    case "find_similar_components":
      return findSimilarComponents(
        requireStringArg(args, "description"), scanner, cache
      );

    case "get_component_detail":
      return getComponentDetail(
        { name: requireStringArg(args, "name"), file: args?.file as string | undefined },
        scanner, parser, cache
      );

    case "find_component_usages":
      return findComponentUsages(
        { name: requireStringArg(args, "name") }, scanner, cache, WORKSPACE_ROOT, config
      );

    case "get_architecture_overview":
      return getArchitectureOverview(scanner, cache, routeAnalyzer);

    case "get_dependency_chain":
      return getDependencyChain(
        {
          name: requireStringArg(args, "name"),
          depth: args?.depth as number | undefined,
          file: args?.file as string | undefined,
        },
        scanner, cache
      );

    case "get_route_map":
      return getRouteMap(routeAnalyzer, scanner, cache);

    case "get_hook_detail":
      return getHookDetail(
        { name: requireStringArg(args, "name"), file: args?.file as string | undefined },
        scanner, cache
      );

    case "find_dead_code":
      return findDeadCode(
        scanner, cache, WORKSPACE_ROOT,
        { layer: args?.layer as string | undefined },
        routeAnalyzer, config
      );

    case "get_data_flow":
      return getDataFlow(
        {
          name: requireStringArg(args, "name"),
          depth: args?.depth as number | undefined,
          file: args?.file as string | undefined,
        },
        scanner, cache
      );

    case "find_dangling_listeners":
      return findDanglingListeners(
        { file: args?.file as string | undefined },
        scanner, cache
      );

    case "audit_template_patterns":
      return auditTemplatePatterns(
        { file: args?.file as string | undefined },
        scanner, cache, config
      );

    case "render_component":
      return renderComponent(
        {
          component: args?.component as string | undefined,
          route: args?.route as string | undefined,
          params: args?.params as Record<string, string> | undefined,
          fullPage: args?.fullPage as boolean | undefined,
          settleMs: args?.settleMs as number | undefined,
          public: args?.public as boolean | undefined,
        },
        browser, routeAnalyzer, scanner, cache, browserConfig
      );

    case "check_page":
      return checkPage(
        {
          url: requireStringArg(args, "url"),
          fullPage: args?.fullPage as boolean | undefined,
          settleMs: args?.settleMs as number | undefined,
          waitUntil: args?.waitUntil as "load" | "domcontentloaded" | "networkidle" | undefined,
          public: args?.public as boolean | undefined,
        },
        browser
      );

    case "verify_data_flow":
      return verifyDataFlow(
        {
          name: requireStringArg(args, "name"),
          file: args?.file as string | undefined,
          params: args?.params as Record<string, string> | undefined,
          settleMs: args?.settleMs as number | undefined,
          depth: args?.depth as number | undefined,
          actions: args?.actions as any[] | undefined,
        },
        browser, routeAnalyzer, scanner, cache, browserConfig
      );

    case "capture_flow":
      return captureFlow(
        {
          steps: (args?.steps as any[]) || [],
          settleMs: args?.settleMs as number | undefined,
          public: args?.public as boolean | undefined,
        },
        browser, routeAnalyzer, scanner, cache, browserConfig
      );

    case "reset_login":
      return resetLogin({ relogin: args?.relogin as boolean | undefined }, browser);

    case "inspect_rendered_page":
      return inspectRenderedPage(
        {
          component: args?.component as string | undefined,
          route: args?.route as string | undefined,
          url: args?.url as string | undefined,
          params: args?.params as Record<string, string> | undefined,
          settleMs: args?.settleMs as number | undefined,
        },
        browser, routeAnalyzer, scanner, cache, browserConfig
      );

    case "whats_affected":
      return whatsAffected(
        {
          files: args?.files as string[] | undefined,
          offset: args?.offset as number | undefined,
          maxItems: args?.maxItems as number | undefined,
          maxDistance: args?.maxDistance as number | undefined,
        },
        scanner, cache, routeAnalyzer, WORKSPACE_ROOT, browserConfig
      );

    case "intel_status":
      return intelStatus(config, WORKSPACE_ROOT, scanner, cache, routeAnalyzer, browser);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const result = await handleToolCall(name, args);
    // Browser tools return MCP content directly (text + screenshot image);
    // everything else returns plain data we JSON-wrap.
    if (result && typeof result === "object" && Array.isArray((result as any).content)) {
      return result as { content: unknown[] };
    }
    return jsonResponse(result);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: errorMessage }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    "Atlas UI MCP Server running on stdio"
  );
  console.error(`Workspace: ${WORKSPACE_ROOT}`);
  console.error(`Config: ${JSON.stringify({
    scanTargets: config.scanTargets?.length,
    routeFiles: config.routeFiles,
    aliases: config.aliases,
    exclude: config.exclude?.length,
  })}`);
  console.error(
    `Browser: devServerUrl=${browser.baseUrl} headless=${browserConfig.headless !== false} ` +
      `login=${browserConfig.login ? "configured" : "none"}`
  );
}

// Cleanup on exit
function shutdown() {
  stopWatching?.();
  browser.close().finally(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
