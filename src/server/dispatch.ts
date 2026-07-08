import type { ComponentScanner } from "../scanner/componentScanner.js";
import type { PropParser } from "../parser/propParser.js";
import type { CacheManager } from "../cache/cacheManager.js";
import type { RouteAnalyzer } from "../analyzer/routeAnalyzer.js";
import type { BrowserSession } from "../browser/session.js";
import type { ArchitectureLayer, BrowserConfig, ProjectConfig } from "../types.js";
import { listAllComponents } from "../tools/listAllComponents.js";
import { searchComponents } from "../tools/searchComponents.js";
import { getComponentProps } from "../tools/getComponentProps.js";
import { findSimilarComponents } from "../tools/findSimilarComponents.js";
import { getComponentDetail } from "../tools/getComponentDetail.js";
import { findComponentUsages } from "../tools/findComponentUsages.js";
import { getArchitectureOverview } from "../tools/getArchitectureOverview.js";
import { getDependencyChain } from "../tools/getDependencyChain.js";
import { getRouteMap } from "../tools/getRouteMap.js";
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
}

type ToolArgs = Record<string, unknown> | undefined;
type ToolHandler = (args: ToolArgs, ctx: ToolContext) => Promise<unknown>;

function requireStringArg(args: ToolArgs, key: string): string {
  if (!args || typeof args[key] !== "string") {
    throw new Error(`Missing required argument: ${key} (string)`);
  }
  return args[key] as string;
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

  get_component_detail: (args, ctx) =>
    getComponentDetail(
      { name: requireStringArg(args, "name"), file: args?.file as string | undefined },
      ctx.scanner, ctx.parser, ctx.cache
    ),

  find_component_usages: (args, ctx) =>
    findComponentUsages(
      { name: requireStringArg(args, "name") },
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
        params: args?.params as Record<string, string> | undefined,
        fullPage: args?.fullPage as boolean | undefined,
        settleMs: args?.settleMs as number | undefined,
        public: args?.public as boolean | undefined,
      },
      ctx.browser, ctx.routeAnalyzer, ctx.scanner, ctx.cache, ctx.browserConfig
    ),

  check_page: (args, ctx) =>
    checkPage(
      {
        url: requireStringArg(args, "url"),
        fullPage: args?.fullPage as boolean | undefined,
        settleMs: args?.settleMs as number | undefined,
        waitUntil: args?.waitUntil as "load" | "domcontentloaded" | "networkidle" | undefined,
        public: args?.public as boolean | undefined,
      },
      ctx.browser
    ),

  verify_data_flow: (args, ctx) =>
    verifyDataFlow(
      {
        name: requireStringArg(args, "name"),
        file: args?.file as string | undefined,
        params: args?.params as Record<string, string> | undefined,
        settleMs: args?.settleMs as number | undefined,
        depth: args?.depth as number | undefined,
        actions: args?.actions as any[] | undefined,
      },
      ctx.browser, ctx.routeAnalyzer, ctx.scanner, ctx.cache, ctx.browserConfig
    ),

  capture_flow: (args, ctx) =>
    captureFlow(
      {
        steps: (args?.steps as any[]) || [],
        settleMs: args?.settleMs as number | undefined,
        public: args?.public as boolean | undefined,
      },
      ctx.browser, ctx.routeAnalyzer, ctx.scanner, ctx.cache, ctx.browserConfig
    ),

  reset_login: (args, ctx) =>
    resetLogin({ relogin: args?.relogin as boolean | undefined }, ctx),

  inspect_rendered_page: (args, ctx) =>
    inspectRenderedPage(
      {
        component: args?.component as string | undefined,
        route: args?.route as string | undefined,
        url: args?.url as string | undefined,
        params: args?.params as Record<string, string> | undefined,
        settleMs: args?.settleMs as number | undefined,
      },
      ctx.browser, ctx.routeAnalyzer, ctx.scanner, ctx.cache, ctx.browserConfig
    ),

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

function jsonResponse(data: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/**
 * Run one tool call and shape the result for MCP. Browser tools return MCP
 * content directly (text + screenshot image); everything else returns plain
 * data we JSON-wrap. Errors come back as an isError text payload.
 */
export async function dispatchToolCall(name: string, args: ToolArgs, ctx: ToolContext) {
  const handler = HANDLERS[name];
  try {
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    const result = await handler(args, ctx);
    if (result && typeof result === "object" && Array.isArray((result as any).content)) {
      return result as { content: unknown[] };
    }
    return jsonResponse(result);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
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
}
