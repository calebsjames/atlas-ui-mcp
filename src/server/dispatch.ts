import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { PropParser } from "../parser/propParser.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { RouteAnalyzer } from "../analyzer/routeAnalyzer.js";
import type { BrowserSession } from "../browser/session.js";
import type { ArchitectureLayer, BrowserConfig, ProjectConfig } from "../types.js";
import type { WaitUntil } from "../browser/quiet.js";
import type { ApiMock } from "../browser/types.js";
import { compactContent, serializeResult } from "./serialize.js";
import { describeProbe } from "../browser/preflight.js";
import { listAllComponents } from "../tools/listAllComponents.js";
import { searchComponents } from "../tools/searchComponents.js";
import { getComponentProps } from "../tools/getComponentProps.js";
import { findSimilarComponents } from "../tools/findSimilarComponents.js";
import { compareImplementations, type SymbolRef } from "../tools/compareImplementations.js";
import { getComponentDetail } from "../tools/getComponentDetail.js";
import { findComponentUsages } from "../tools/findComponentUsages.js";
import { getArchitectureOverview } from "../tools/getArchitectureOverview.js";
import { getDependencyChain } from "../tools/getDependencyChain.js";
import { getRouteMap } from "../tools/getRouteMap.js";
import { getSectionMap } from "../tools/getSectionMap.js";
import { getHookDetail } from "../tools/getHookDetail.js";
import { findDeadCode } from "../tools/findDeadCode.js";
import { getDataFlow } from "../tools/getDataFlow.js";
import { checkPage } from "../tools/checkPage.js";
import { renderComponent } from "../tools/renderComponent.js";
import { resetLogin } from "../tools/resetLogin.js";
import { findDanglingListeners } from "../tools/findDanglingListeners.js";
import { auditTemplatePatterns } from "../tools/auditTemplatePatterns.js";
import { verifyDataFlow } from "../tools/verifyDataFlow.js";
import { captureFlow } from "../tools/captureFlow.js";
import { inspectRenderedPage } from "../tools/inspectRenderedPage.js";
import { whatsAffected } from "../tools/whatsAffected.js";
import { serverInfo } from "../tools/serverInfo.js";

/** Everything a tool handler might need, wired up once at startup. */
export interface ToolContext {
  workspaceRoot: string;
  config: ProjectConfig;
  browserConfig: BrowserConfig;
  scanner: ComponentScanner;
  parser: PropParser;
  cache: CacheManager;
  routeAnalyzer: RouteAnalyzer;
  browser: BrowserSession;
  /** Restart the file watcher after a refresh swaps in a new scanner (set by server.ts). */
  restartWatcher?: () => Promise<void>;
}

type ToolArgs = Record<string, unknown> | undefined;
type ToolHandler = (args: ToolArgs, ctx: ToolContext) => Promise<unknown>;

function requireStringArg(args: ToolArgs, key: string): string {
  if (!args || typeof args[key] !== "string") {
    const got = Object.keys(args ?? {});
    throw new Error(
      `Missing required argument: ${key} (string)` + (got.length ? `. Received: ${got.join(", ")}.` : ".")
    );
  }
  return args[key] as string;
}

/**
 * Argument aliases — the tools grew different names for the same thing
 * (`name` vs `component`), and a call with the "other" one failed outright.
 * Each alias fills its canonical argument only when the canonical is absent.
 */
const NAME_ALIASES = ["component", "componentName", "symbol", "hook", "target"];
const MOCK_ALIASES = ["mocks", "mock", "stubs", "apiMocks", "mockApis"];
const ARG_ALIASES: Record<string, Record<string, string[]>> = {
  get_component_detail: { name: NAME_ALIASES, file: ["filePath"] },
  find_component_usages: { name: NAME_ALIASES, file: ["filePath"] },
  get_dependency_chain: { name: NAME_ALIASES, file: ["filePath"] },
  get_hook_detail: { name: NAME_ALIASES, file: ["filePath"] },
  get_data_flow: { name: NAME_ALIASES, file: ["filePath"] },
  verify_data_flow: { name: NAME_ALIASES, file: ["filePath"], mockApi: MOCK_ALIASES },
  get_component_props: { name: NAME_ALIASES, componentPath: ["path", "filePath"] },
  render_component: { component: ["name", "componentName"], mockApi: MOCK_ALIASES },
  inspect_rendered_page: { component: ["name", "componentName"] },
  check_page: { url: ["route", "path", "href"], mockApi: MOCK_ALIASES },
  search_components: { query: ["q", "name", "search", "term"] },
  find_similar_components: { description: ["query", "q", "text"] },
  whats_affected: { files: ["file", "paths"] },
  capture_flow: { steps: ["flow"], mockApi: MOCK_ALIASES },
};

function normalizeArgs(tool: string, args: ToolArgs): ToolArgs {
  const aliases = ARG_ALIASES[tool];
  if (!aliases || !args) return args;
  const out: Record<string, unknown> = { ...args };
  for (const [canonical, alts] of Object.entries(aliases)) {
    if (out[canonical] !== undefined) continue;
    const alt = alts.find((a) => out[a] !== undefined);
    if (!alt) continue;
    out[canonical] = out[alt];
    delete out[alt];
  }
  // `whats_affected({ file: "x.ts" })` — a single path where a list is expected.
  if (tool === "whats_affected" && typeof out.files === "string") out.files = [out.files];
  return out;
}

const HANDLERS: Record<string, ToolHandler> = {
  list_all_components: (args, ctx) =>
    listAllComponents(ctx.scanner, ctx.cache, {
      layer: args?.layer as ArchitectureLayer | undefined,
      verbose: args?.verbose as boolean | undefined,
    }),

  search_components: (args, ctx) =>
    searchComponents(requireStringArg(args, "query"), ctx.scanner, ctx.cache, {
      layer: args?.layer as ArchitectureLayer | undefined,
      limit: args?.limit as number | undefined,
    }),

  get_component_props: async (args, ctx) => {
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
      ctx.workspaceRoot, ctx.parser, ctx.cache, ctx.scanner
    );
  },

  find_similar_components: (args, ctx) =>
    findSimilarComponents(requireStringArg(args, "description"), ctx.scanner, ctx.cache),

  compare_implementations: (args, ctx) =>
    compareImplementations(
      {
        a: (args?.a ?? {}) as SymbolRef,
        b: (args?.b ?? {}) as SymbolRef,
        maxDivergences: args?.maxDivergences as number | undefined,
      },
      ctx.scanner,
      ctx.cache,
      ctx.workspaceRoot
    ),

  get_component_detail: (args, ctx) =>
    getComponentDetail(
      { name: requireStringArg(args, "name"), file: args?.file as string | undefined },
      ctx.scanner, ctx.parser, ctx.cache
    ),

  find_component_usages: (args, ctx) =>
    findComponentUsages(
      { name: requireStringArg(args, "name"), file: args?.file as string | undefined },
      ctx.scanner, ctx.cache, ctx.workspaceRoot, ctx.config
    ),

  get_architecture_overview: (_args, ctx) =>
    getArchitectureOverview(ctx.scanner, ctx.cache, ctx.routeAnalyzer),

  get_dependency_chain: (args, ctx) =>
    getDependencyChain(
      {
        name: requireStringArg(args, "name"),
        depth: args?.depth as number | undefined,
        file: args?.file as string | undefined,
      },
      ctx.scanner, ctx.cache
    ),

  get_route_map: (_args, ctx) => getRouteMap(ctx.routeAnalyzer, ctx.scanner, ctx.cache),

  get_section_map: (_args, ctx) => getSectionMap(ctx.routeAnalyzer, ctx.scanner, ctx.cache),

  get_hook_detail: (args, ctx) =>
    getHookDetail(
      { name: requireStringArg(args, "name"), file: args?.file as string | undefined },
      ctx.scanner, ctx.cache
    ),

  find_dead_code: (args, ctx) =>
    findDeadCode(
      ctx.scanner, ctx.cache, ctx.workspaceRoot,
      { layer: args?.layer as string | undefined },
      ctx.routeAnalyzer, ctx.config
    ),

  get_data_flow: (args, ctx) =>
    getDataFlow(
      {
        name: requireStringArg(args, "name"),
        depth: args?.depth as number | undefined,
        file: args?.file as string | undefined,
        summary: args?.summary as boolean | undefined,
      },
      ctx.scanner, ctx.cache
    ),

  find_dangling_listeners: (args, ctx) =>
    findDanglingListeners({ file: args?.file as string | undefined }, ctx.scanner, ctx.cache),

  audit_template_patterns: (args, ctx) =>
    auditTemplatePatterns(
      { file: args?.file as string | undefined },
      ctx.scanner, ctx.cache, ctx.config
    ),

  render_component: (args, ctx) =>
    renderComponent(
      {
        component: args?.component as string | undefined,
        route: args?.route as string | undefined,
        section: args?.section as string | undefined,
        params: args?.params as Record<string, string> | undefined,
        fullPage: args?.fullPage as boolean | undefined,
        settleMs: args?.settleMs as number | undefined,
        public: args?.public as boolean | undefined,
        file: args?.file as string | undefined,
        loginAs: args?.loginAs as string | undefined,
        viewport: args?.viewport as { width: number; height: number } | undefined,
        measure: args?.measure as string[] | undefined,
        mockApi: args?.mockApi as ApiMock[] | undefined,
      },
      ctx.browser, ctx.routeAnalyzer, ctx.scanner, ctx.cache, ctx.browserConfig
    ),

  check_page: (args, ctx) =>
    checkPage(
      {
        url: requireStringArg(args, "url"),
        fullPage: args?.fullPage as boolean | undefined,
        settleMs: args?.settleMs as number | undefined,
        waitUntil: args?.waitUntil as WaitUntil | undefined,
        public: args?.public as boolean | undefined,
        loginAs: args?.loginAs as string | undefined,
        viewport: args?.viewport as { width: number; height: number } | undefined,
        measure: args?.measure as string[] | undefined,
        mockApi: args?.mockApi as ApiMock[] | undefined,
      },
      ctx.browser
    ),

  verify_data_flow: (args, ctx) =>
    verifyDataFlow(
      {
        name: requireStringArg(args, "name"),
        file: args?.file as string | undefined,
        section: args?.section as string | undefined,
        params: args?.params as Record<string, string> | undefined,
        settleMs: args?.settleMs as number | undefined,
        depth: args?.depth as number | undefined,
        actions: args?.actions as any[] | undefined,
        loginAs: args?.loginAs as string | undefined,
        viewport: args?.viewport as { width: number; height: number } | undefined,
        mockApi: args?.mockApi as ApiMock[] | undefined,
      },
      ctx.browser, ctx.routeAnalyzer, ctx.scanner, ctx.cache, ctx.browserConfig
    ),

  capture_flow: (args, ctx) =>
    captureFlow(
      {
        steps: (args?.steps as any[]) || [],
        settleMs: args?.settleMs as number | undefined,
        waitUntil: args?.waitUntil as WaitUntil | undefined,
        public: args?.public as boolean | undefined,
        loginAs: args?.loginAs as string | undefined,
        viewport: args?.viewport as { width: number; height: number } | undefined,
        mockApi: args?.mockApi as ApiMock[] | undefined,
      },
      ctx.browser, ctx.routeAnalyzer, ctx.scanner, ctx.cache, ctx.browserConfig
    ),

  reset_login: (args, ctx) =>
    resetLogin(
      { relogin: args?.relogin as boolean | undefined, loginAs: args?.loginAs as string | undefined },
      ctx
    ),

  inspect_rendered_page: (args, ctx) =>
    inspectRenderedPage(
      {
        component: args?.component as string | undefined,
        route: args?.route as string | undefined,
        section: args?.section as string | undefined,
        url: args?.url as string | undefined,
        params: args?.params as Record<string, string> | undefined,
        settleMs: args?.settleMs as number | undefined,
        loginAs: args?.loginAs as string | undefined,
        viewport: args?.viewport as { width: number; height: number } | undefined,
      },
      ctx.browser, ctx.routeAnalyzer, ctx.scanner, ctx.cache, ctx.browserConfig
    ),

  server_info: (args, ctx) => serverInfo({ refresh: args?.refresh as boolean | undefined }, ctx),

  whats_affected: (args, ctx) =>
    whatsAffected(
      {
        files: args?.files as string[] | undefined,
        offset: args?.offset as number | undefined,
        maxItems: args?.maxItems as number | undefined,
        maxDistance: args?.maxDistance as number | undefined,
      },
      ctx.scanner, ctx.cache, ctx.routeAnalyzer, ctx.workspaceRoot, ctx.browserConfig
    ),
};

function jsonResponse(data: unknown, workspaceRoot: string) {
  return { content: [{ type: "text", text: serializeResult(data, { workspaceRoot }) }] };
}

/**
 * Run one tool call and shape the result for MCP. Browser tools return MCP
 * content directly (text + screenshot image); everything else returns plain
 * data we JSON-wrap. Errors come back as an isError text payload.
 */
/** Tools that drive the browser against the dev server. */
const RUNTIME_TOOLS = new Set([
  "render_component", "check_page", "verify_data_flow", "capture_flow", "inspect_rendered_page", "reset_login",
]);

export async function dispatchToolCall(name: string, args: ToolArgs, ctx: ToolContext) {
  const handler = HANDLERS[name];
  const runtime = RUNTIME_TOOLS.has(name);
  try {
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    if (runtime) {
      // Preflight: don't launch a browser at a dev server that isn't there,
      // or is answering with a server error.
      const probe = await ctx.browser.preflight();
      if (!probe.reachable || (probe.status ?? 0) >= 500) {
        throw new Error(
          `The dev server is not serving the app — ${describeProbe(probe)}. Start it (or fix ` +
            "browser.devServerUrl in .atlas-ui.json), then retry. Static tools still work."
        );
      }
    }
    const result = await handler(normalizeArgs(name, args), ctx);
    if (result && typeof result === "object" && Array.isArray((result as any).content)) {
      return compactContent(result as { content: unknown[] }, { workspaceRoot: ctx.workspaceRoot });
    }
    return jsonResponse(result, ctx.workspaceRoot);
  } catch (error) {
    let errorMessage = error instanceof Error ? error.message : "Unknown error";
    if (runtime && !errorMessage.includes("dev server GET")) {
      // Every runtime error says what the dev server answered, so a failure is
      // never mistaken for (or blamed on) the environment without evidence.
      const probe = await ctx.browser.preflight().catch(() => undefined);
      if (probe) errorMessage += ` [${describeProbe(probe)}]`;
    }
    return {
      content: [
        {
          type: "text",
          text: serializeResult({ error: errorMessage }),
        },
      ],
      isError: true,
    };
  }
}
