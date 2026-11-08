// The address of a provider as the main thread cleans it. The same rule as `normalizeBaseUrl` of the adapter (`@agentsim/minds`), kept here because the main thread's initial chunk must not import the minds
// package (it carries the mind documents' schemas, and contract schemas stay out of the initial chunk: ADR-0018 addition of 2026-10-12); a test holds the two to the same answers.

/** The base URL without a trailing slash, or undefined when it is not an http(s) URL with a host. Userinfo is refused: a key does not belong in an address. */
export function normalizeBaseUrl(raw: string): string | undefined {
  const m = /^(https?):\/\/([^/?#@\s]+)(\/[^?#\s]*)?$/i.exec(raw.trim());
  if (m === null) return undefined;
  const path = (m[3] ?? "").replace(/\/+$/, "");
  return `${(m[1] as string).toLowerCase()}://${m[2] as string}${path}`;
}
