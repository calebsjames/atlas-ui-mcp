#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import path from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { loadConfig } from "./config/configLoader.js";
import { loadWorkspaceDotEnv } from "./config/dotenv.js";
import { ComponentScanner } from "./scanner/componentScanner.js";
import { PropParser } from "./parser/propParser.js";
import { CacheManager } from "./cache/cacheManager.js";
import { RouteAnalyzer } from "./analyzer/routeAnalyzer.js";
import { BrowserSession } from "./browser/session.js";
import { CATALOG_TOOLS } from "./server/toolDefs.catalog.js";
import { BROWSER_TOOLS } from "./server/toolDefs.browser.js";
import { dispatchToolCall, type ToolContext } from "./server/dispatch.js";

// Get workspace root from env, CLI arg, or fall back to parent of mcp-server directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(
  process.env.WORKSPACE_ROOT || process.argv[2] || path.resolve(__dirname, "../../")
);

loadWorkspaceDotEnv(WORKSPACE_ROOT);

// Load configuration and wire up the services every tool handler shares.
const config = await loadConfig(WORKSPACE_ROOT);
const browserConfig = config.browser || {};
const browser = new BrowserSession(WORKSPACE_ROOT, browserConfig);
const ctx: ToolContext = {
  workspaceRoot: WORKSPACE_ROOT,
  config,
  browserConfig,
  scanner: new ComponentScanner(WORKSPACE_ROOT, config),
  parser: new PropParser(),
  cache: new CacheManager(),
  routeAnalyzer: new RouteAnalyzer(WORKSPACE_ROOT, config),
  browser,
};

const TOOLS = [...CATALOG_TOOLS, ...BROWSER_TOOLS];

// package.json is the single source of truth for the version — it sits one
// level above this module in both the src/ (dev) and dist/ (built) layouts.
const { version: VERSION } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

// Create MCP server
const server = new Server(
  { name: "atlas-ui", version: VERSION },
  { capabilities: { tools: {} } }
);

// Setup file watcher for cache invalidation
let stopWatching: (() => void) | null = null;

ctx.scanner
  .watch(() => {
    console.error("File change detected, invalidating cache...");
    ctx.cache.invalidateCatalog();
  })
  .then((stop: () => void) => {
    stopWatching = stop;
  });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return dispatchToolCall(name, args, ctx);
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Atlas UI MCP Server running on stdio");
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
