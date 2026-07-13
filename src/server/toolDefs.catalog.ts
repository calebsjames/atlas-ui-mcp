/**
 * MCP tool definitions for the static-analysis (catalog) tools.
 * Browser-driven tools live in toolDefs.browser.ts.
 */

export const LAYER_ENUM = [
  "component", "page", "hook", "service", "adapter", "context", "store", "dto", "type", "util", "root",
];

export const CATALOG_TOOLS = [
  {
    name: "list_all_components",
    description:
      "List the codebase catalog as compact summaries: { totalCount, lastScanned, byLayer, components } where each entry has name, architecture layer, category, relative path, and description/routePath when present. byLayer counts cover the whole catalog; `layer` filters the components list. Pass verbose:true for full metadata objects (large). Follow up with get_component_detail for one item's full data. If a coverageWarning field is present, the scan targets missed most of the app's UI files — read it and fix .atlas-ui.json scanTargets before trusting the catalog.",
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
      "Get a high-level overview of the entire application architecture. Returns counts by layer (components, pages, hooks, services, adapters, contexts), category breakdown, data flow chains (page -> hook -> service), and route map. If a coverageWarning field is present, the scan targets missed most of the app's UI files — read it and fix .atlas-ui.json scanTargets before trusting the catalog.",
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
    name: "get_section_map",
    description:
      "The section-map companion to get_route_map, for SPAs that multiplex ONE route into several in-app sections (a role shell / tabbed page / sidebar switch where the lists are section switches, not routes). For each routed page (and each page/root shell) it detects a view multiplexer — a single state variable gating sibling views (Vue `v-if=\"view === 'x'\"`, React `{tab === 'x' && <X/>}`) — and returns each container's `selector` (the state variable), its `route` when routed, and `sections[]`. Each section has an `id` (the literal value), the `child` component it renders, `reachedBy` (`query` | `click` | `unknown`), a `queryParam` when the view syncs to the URL, and an `activator` ({selector,label}) — the control that switches to it — when statically identifiable. Works for both Vue and React. Returns `{ containers, note? }`; `note` explains an empty result.",
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
    name: "whats_affected",
    description:
      "The edit→verify glue: given changed files (or auto-detected from git status when omitted), walk the dependency graph UPSTREAM to find every component/page affected by the change, map those to routes, and return concrete verification targets — ready-to-run check_page/render_component suggestions. Each changed file gets a risk classification (low/medium/high/critical with a scoring breakdown: layer, blast radius, routes reached, direct dependents) and the result carries an overallRisk; routes and suggested checks are ordered riskiest-first. Affected items carry gatedBy when they mount their dependency behind v-if/v-show/v-for (e.g. a modal) — drive that guard during verification or the change won't be exercised. Call it after editing to know exactly what to re-check in the browser and how carefully.",
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
];
