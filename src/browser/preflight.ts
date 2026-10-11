/**
 * Is the dev server up, and is it serving the app? A runtime error that only
 * says "timeout" sent agents to confident, wrong conclusions ("the stock Vite
 * scaffold is being served"). Every runtime failure now carries this probe:
 * the HTTP status and the page <title> the dev server actually returns.
 */
export interface DevServerProbe {
  url: string;
  reachable: boolean;
  status?: number;
  /** The <title> of the HTML the dev server returned. */
  title?: string;
  error?: string;
  ms: number;
}

export async function probeDevServer(url: string, timeoutMs = 3_000): Promise<DevServerProbe> {
  const start = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    const body = await res.text().catch(() => "");
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.replace(/\s+/g, " ").trim();
    return { url, reachable: true, status: res.status, ...(title ? { title } : {}), ms: Date.now() - start };
  } catch (err) {
    const e = err as { cause?: { code?: string }; name?: string; message?: string };
    const error = e?.cause?.code ?? (e?.name === "TimeoutError" ? `no response in ${timeoutMs}ms` : e?.message ?? String(err));
    return { url, reachable: false, error, ms: Date.now() - start };
  }
}

/** One line for an error message: `GET http://… → 200 "Title"` / `→ unreachable (ECONNREFUSED)`. */
export function describeProbe(p: DevServerProbe): string {
  if (!p.reachable) return `dev server GET ${p.url} → unreachable (${p.error})`;
  return `dev server GET ${p.url} → ${p.status}${p.title ? ` "${p.title}"` : " (no <title>)"}`;
}
