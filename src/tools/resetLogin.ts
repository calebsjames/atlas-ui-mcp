import { loadConfig } from "../config/configLoader.js";
import type { ToolContext } from "../server/dispatch.js";

/**
 * Recover the browser's authenticated session in-place. Re-reads the workspace
 * config first (so a `browser.login` block added to .atlas-ui.json AFTER server
 * startup is honoured — no restart needed), clears cookies/storage and any
 * stuck login error, then (by default) re-runs the configured login flow
 * immediately. This is the in-session equivalent of restarting the MCP server
 * to fix a broken/expired login — without losing the browser process.
 *
 * Public routes never need this (they skip login via `public: true`); it exists
 * for authed tools that started failing once a credential broke, a session
 * expired mid-run, or login config landed post-startup.
 */
export async function resetLogin(
  args: { relogin?: boolean },
  ctx: ToolContext
): Promise<{
  reset: true;
  configReloaded: boolean;
  loginConfigured: boolean;
  reloginAttempted: boolean;
  loggedIn: boolean;
  error?: string;
  note?: string;
}> {
  const relogin = args.relogin !== false; // default: re-login immediately
  const session = ctx.browser;

  // The server reads config once at startup; the whole point of this tool is
  // recovering without a restart, so pick up config edits (new login block,
  // changed credentials/selectors) made since then. Browser config only — scan
  // targets/aliases feed the scanner, which is deliberately left untouched.
  let configReloaded = false;
  try {
    const fresh = await loadConfig(ctx.workspaceRoot);
    ctx.browserConfig = fresh.browser || {};
    session.updateConfig(ctx.browserConfig);
    configReloaded = true;
  } catch {
    // Unreadable config: keep the startup config rather than failing the reset.
  }

  if (!session.loginConfigured) {
    // Nothing to reset toward — surface that plainly rather than silently no-op.
    await session.resetLogin({ relogin: false });
    return {
      reset: true,
      configReloaded,
      loginConfigured: false,
      reloginAttempted: false,
      loggedIn: false,
      note:
        "No browser.login is configured (config was just re-read from .atlas-ui.json), " +
        "so there is no session to log in to. Runtime tools run unauthenticated. " +
        "Add a browser.login block and call reset_login again — no server restart needed.",
    };
  }

  const result = await session.resetLogin({ relogin });
  return {
    reset: true,
    configReloaded,
    loginConfigured: true,
    reloginAttempted: relogin,
    loggedIn: result.loggedIn,
    ...(result.error ? { error: result.error } : {}),
  };
}
