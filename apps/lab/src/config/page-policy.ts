import { useEffect, useState } from "react";
import { connectAllowed, readPagePolicy } from "./network-policy.ts";

// The policy the page was served with, read once (F4 M3/M4): Settings and the minds table both say whether an address may be called.

/** The `connect-src` tokens of the policy the page was served with; undefined while unknown (or when it cannot be read). */
export function usePagePolicy(): readonly string[] | undefined {
  const [tokens, setTokens] = useState<readonly string[] | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void readPagePolicy((u, i) => fetch(u, i), window.location.href).then((t) => live && setTokens(t));
    return () => {
      live = false;
    };
  }, []);
  return tokens;
}

/** Whether this address would be allowed (undefined when the policy could not be read: the call is then tried). */
export function allowedBy(tokens: readonly string[] | undefined, url: string): boolean | undefined {
  return tokens === undefined ? undefined : connectAllowed(url, tokens, window.location.origin);
}
