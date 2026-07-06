import type { BrowserSession } from "../browser/session.js";

/**
 * Recover the browser's authenticated session in-place. Clears cookies/storage
 * and any stuck login error, then (by default) re-runs the configured login
 * flow immediately. This is the in-session equivalent of restarting the MCP
 * server to fix a broken/expired login — without losing the browser process.
 *
 * Public routes never need this (they skip login via `public: true`); it exists
 * for authed tools that started failing once a credential broke or a session
 * expired mid-run.
 */
export async function resetLogin(
  args: { relogin?: boolean },
  session: BrowserSession
): Promise<{
  reset: true;
  loginConfigured: boolean;
  reloginAttempted: boolean;
  loggedIn: boolean;
  error?: string;
  note?: string;
}> {
  const relogin = args.relogin !== false; // default: re-login immediately

  if (!session.loginConfigured) {
    // Nothing to reset toward — surface that plainly rather than silently no-op.
    await session.resetLogin({ relogin: false });
    return {
      reset: true,
      loginConfigured: false,
      reloginAttempted: false,
      loggedIn: false,
      note: "No browser.login is configured, so there is no session to log in to. Runtime tools run unauthenticated.",
    };
  }

  const result = await session.resetLogin({ relogin });
  return {
    reset: true,
    loginConfigured: true,
    reloginAttempted: relogin,
    loggedIn: result.loggedIn,
    ...(result.error ? { error: result.error } : {}),
  };
}
