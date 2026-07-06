import type { BrowserSession } from "../browser/session.js";
import { captureResponse, diagnostics, type McpContentResult } from "../browser/response.js";

/**
 * The "did my change break anything" workhorse. Navigate to a URL (absolute,
 * or a path relative to the dev server) and return a screenshot plus runtime
 * diagnostics: console errors, uncaught exceptions, and failed network calls.
 */
export async function checkPage(
  args: {
    url: string;
    fullPage?: boolean;
    settleMs?: number;
    waitUntil?: "load" | "domcontentloaded" | "networkidle";
    public?: boolean;
  },
  session: BrowserSession
): Promise<McpContentResult> {
  const url = args.url.startsWith("http")
    ? args.url
    : session.baseUrl.replace(/\/$/, "") + (args.url.startsWith("/") ? args.url : `/${args.url}`);

  const capture = await session.capture(url, {
    label: "check",
    fullPage: args.fullPage,
    settleMs: args.settleMs,
    waitUntil: args.waitUntil,
    requireAuth: !args.public,
  });

  return captureResponse({ url, ...diagnostics(capture) }, capture);
}
