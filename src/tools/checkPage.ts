import type { BrowserSession } from "../browser/session.js";
import { captureResponse, diagnostics, type McpContentResult } from "../browser/response.js";
import { toAbsoluteUrl } from "../util.js";
import type { WaitUntil } from "../browser/quiet.js";

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
    waitUntil?: WaitUntil;
    public?: boolean;
    loginAs?: string;
    viewport?: { width: number; height: number };
    measure?: string[];
  },
  session: BrowserSession
): Promise<McpContentResult> {
  const url = toAbsoluteUrl(session.baseUrl, args.url);

  const capture = await session.capture(url, {
    label: "check",
    fullPage: args.fullPage,
    settleMs: args.settleMs,
    waitUntil: args.waitUntil,
    requireAuth: !args.public,
    loginAs: args.loginAs,
    viewport: args.viewport,
    measure: args.measure,
  });

  return captureResponse({ url, ...diagnostics(capture) }, capture);
}
