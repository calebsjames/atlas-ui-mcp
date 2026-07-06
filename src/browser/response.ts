import type { CaptureResult } from "./session.js";

/**
 * An MCP tool result with mixed content. The server detects this shape and
 * passes it through instead of JSON-wrapping, so the screenshot reaches the
 * agent as a real image it can look at.
 */
export interface McpContentResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
}

/** Build a text-summary + screenshot-image result from a capture. */
export function captureResponse(
  summary: Record<string, unknown>,
  capture: CaptureResult
): McpContentResult {
  return {
    content: [
      { type: "text", text: JSON.stringify(summary, null, 2) },
      { type: "image", data: capture.screenshotBase64, mimeType: "image/png" },
    ],
  };
}

/** Trim a capture down to the fields worth showing the agent by default. */
export function diagnostics(capture: CaptureResult) {
  return {
    title: capture.title,
    clean: capture.clean,
    durationMs: capture.durationMs,
    counts: {
      consoleErrors: capture.consoleErrors.length,
      consoleWarnings: capture.consoleWarnings.length,
      pageErrors: capture.pageErrors.length,
      failedRequests: capture.failedRequests.length,
      requests: capture.requests.length,
    },
    consoleErrors: capture.consoleErrors.map((e) => e.text),
    pageErrors: capture.pageErrors,
    failedRequests: capture.failedRequests.map((r) => ({
      method: r.method,
      url: r.url,
      failure: r.failure,
    })),
    screenshotPath: capture.screenshotPath,
  };
}
