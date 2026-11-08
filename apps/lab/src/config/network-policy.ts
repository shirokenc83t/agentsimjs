// The addresses this page may call (F4 M3, ADR-0044 section 4): the `connect-src` of the Content-Security-Policy the page was served with. Localhost and 127.0.0.1 on any port are in it; another machine is in it only
// if the server that serves the page lists it. A page cannot widen its own policy (a meta element only narrows it, and a worker takes its policy from the headers of its own script), so Settings reads the policy
// it was served with and says, per address, whether a call would be allowed; it does not pretend to apply a list.

/** The tokens of the `connect-src` directive of a policy header, or undefined when it has none. */
export function parseConnectSrc(policy: string): readonly string[] | undefined {
  for (const part of policy.split(";")) {
    const words = part.trim().split(/\s+/);
    if (words[0]?.toLowerCase() === "connect-src") return words.slice(1);
  }
  return undefined;
}

/** The origin of an http(s) address (`http://localhost:11434`), or undefined. */
export function originOf(url: string): { readonly scheme: string; readonly host: string; readonly port: string } | undefined {
  const m = /^(https?):\/\/([^/:?#]+)(?::(\d+|\*))?/i.exec(url.trim());
  if (m === null) return undefined;
  const scheme = (m[1] as string).toLowerCase();
  return { scheme, host: (m[2] as string).toLowerCase(), port: m[3] ?? (scheme === "https" ? "443" : "80") };
}

/** Whether a call to `url` is allowed by these `connect-src` tokens, for a page served from `selfOrigin`. */
export function connectAllowed(url: string, tokens: readonly string[], selfOrigin: string): boolean {
  const target = originOf(url);
  if (target === undefined) return false;
  for (const t of tokens) {
    if (t === "'self'") {
      const self = originOf(selfOrigin);
      if (self !== undefined && self.scheme === target.scheme && self.host === target.host && self.port === target.port) return true;
      continue;
    }
    if (t === "http:" && target.scheme === "http") return true;
    if (t === "https:" && target.scheme === "https") return true;
    const o = originOf(t);
    if (o === undefined) continue;
    if (o.scheme === target.scheme && o.host === target.host && (o.port === "*" || o.port === target.port)) return true;
  }
  return false;
}

/** The policy this page was served with, read from the response headers of the page itself (`connect-src 'self'` allows the request); undefined when it cannot be read. */
export async function readPagePolicy(fetchFn: (url: string, init: { method: string }) => Promise<{ headers: { get(name: string): string | null } }>, href: string): Promise<readonly string[] | undefined> {
  try {
    const r = await fetchFn(href, { method: "HEAD" });
    const p = r.headers.get("content-security-policy");
    return p === null ? undefined : parseConnectSrc(p);
  } catch {
    return undefined;
  }
}

/** The line a server that serves the page would add to its policy to let the page call these addresses: what Settings offers to copy. */
export function connectSrcLine(extra: readonly string[]): string {
  const origins = new Set<string>();
  for (const u of extra) {
    const o = originOf(u);
    if (o !== undefined) origins.add(`${o.scheme}://${o.host}:${o.port}`);
  }
  return ["connect-src 'self' http://localhost:* http://127.0.0.1:*", ...origins].join(" ");
}
