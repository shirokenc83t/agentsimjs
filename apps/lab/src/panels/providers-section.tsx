import type { StorageClient } from "@agentsim/storage";
import { useCallback, useEffect, useState } from "react";
import { connectSrcLine, originOf } from "../config/network-policy.ts";
import { allowedBy, usePagePolicy } from "../config/page-policy.ts";
import { probeProvider, type ProbeResult } from "../config/provider-probe.ts";
import { cleanAddress, PROVIDER_ID, providerStore, useProviders, type ProviderEntry } from "../config/providers.ts";

// Settings → Providers and keys, and the endpoints beside this computer (F4 M3, the designer's Providers board, ADR-0044 sections 2 to 4). A provider is an address, the models the server lists, an optional key
// and optional prices. The key is typed into a masked field, is never rendered back (the table says `●●●● set` and whether it is remembered on this device), and leaves the page only in the header of a call to its
// own address. The page's policy decides which addresses it may call: this panel reads it and says so, address by address; it does not pretend to widen it.

const EXTRA_NAMESPACE = "providers";
const EXTRA_KEY = "extraEndpoints";

async function reachable(baseUrl: string): Promise<boolean> {
  try {
    // An opaque answer: the page cannot read it, which is the point (the server is there; only CORS stands in the way). `no-cors` allows no other redirect mode.
    await fetch(baseUrl, { mode: "no-cors" });
    return true;
  } catch {
    return false;
  }
}

/** The profiles of the library that name a provider (their latest version), as `scout-llm v3`. */
async function profilesUsing(storage: StorageClient, providerId: string): Promise<string[]> {
  try {
    const out: string[] = [];
    for (const s of await storage.ports.mindProfiles.list()) {
      const doc = await storage.ports.mindProfiles.get(s.id);
      const s2 = (doc?.document as { s2?: { provider?: unknown } } | undefined)?.s2;
      if (s2?.provider === providerId) out.push(`${s.id} v${s.latestVersion}`);
    }
    return out;
  } catch {
    return [];
  }
}

const clock = (ms: number): string => new Date(ms).toTimeString().slice(0, 5);

interface Draft {
  readonly editing: string | undefined;
  readonly name: string;
  readonly address: string;
  readonly key: string;
  readonly remember: boolean;
  readonly priceIn: string;
  readonly priceOut: string;
}
const EMPTY: Draft = { editing: undefined, name: "", address: "", key: "", remember: false, priceIn: "", priceOut: "" };

export function ProvidersSection(props: { storage: StorageClient; ready: boolean }) {
  const { storage, ready } = props;
  const { entries } = useProviders();
  const policy = usePagePolicy();
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const [result, setResult] = useState<ProbeResult | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<{ id: string; used: string[] } | undefined>(undefined);
  const [usedBy, setUsedBy] = useState<Record<string, string[]>>({});
  useEffect(() => {
    if (!ready) return;
    let live = true;
    void Promise.all(entries.map(async (e) => [e.id, await profilesUsing(storage, e.id)] as const)).then((rows) => live && setUsedBy(Object.fromEntries(rows)));
    return () => {
      live = false;
    };
  }, [entries, ready, storage]);

  const base = draft === undefined ? undefined : cleanAddress(draft.address);
  const nameOk = draft !== undefined && PROVIDER_ID.test(draft.name) && (draft.editing === draft.name || providerStore.get(draft.name) === undefined);
  const priceIn = draft?.priceIn === "" ? undefined : Number(draft?.priceIn);
  const priceOut = draft?.priceOut === "" ? undefined : Number(draft?.priceOut);
  const pricesOk = (priceIn === undefined && priceOut === undefined) || (priceIn !== undefined && priceOut !== undefined && priceIn >= 0 && priceOut >= 0);
  const valid = draft !== undefined && nameOk && base !== undefined && pricesOk;

  const test = useCallback(
    async (id: string | undefined, address: string, key: string | undefined, model?: string) => {
      setBusy(true);
      setResult(undefined);
      try {
        const r = await probeProvider(address, key, { fetch: (u, i) => fetch(u, i as never) as never, allowed: (u) => allowedBy(policy, u), reachable, ...(model === undefined ? {} : { model }) });
        setResult(r);
        if (id !== undefined) await providerStore.setTested(id, { atMs: Date.now(), ok: r.ok, summary: r.summary }, r.ok ? r.models : undefined);
        return r;
      } finally {
        setBusy(false);
      }
    },
    [policy],
  );

  const save = async () => {
    if (draft === undefined || base === undefined) return;
    const prior = draft.editing === undefined ? undefined : providerStore.get(draft.editing);
    if (prior !== undefined && prior.id !== draft.name) await providerStore.remove(prior.id);
    await providerStore.save(
      { id: draft.name, kind: "openai-compatible", baseUrl: base, ...(result?.ok === true ? { models: result.models } : prior?.models === undefined ? {} : { models: prior.models }), ...(priceIn !== undefined && priceOut !== undefined ? { prices: { inputUsdPerMTok: priceIn, outputUsdPerMTok: priceOut } } : {}), ...(result === undefined ? {} : { tested: { atMs: Date.now(), ok: result.ok, summary: result.summary } }) },
      draft.key === "" ? undefined : draft.key,
      draft.remember,
    );
    // The key was typed into this field and is gone from the page's state at once.
    setDraft(undefined);
    setResult(undefined);
  };

  const edit = (e: ProviderEntry) => {
    setResult(undefined);
    setDraft({ editing: e.id, name: e.id, address: e.baseUrl, key: "", remember: e.rememberKey, priceIn: e.prices === undefined ? "" : String(e.prices.inputUsdPerMTok), priceOut: e.prices === undefined ? "" : String(e.prices.outputUsdPerMTok) });
  };

  const keyWords = (id: string) => {
    const k = providerStore.keyState(id);
    return k === "none" ? "none" : `●●●● set · ${k === "device" ? "remembered on this device" : "this session"}`;
  };
  const statusOf = (e: ProviderEntry) => {
    if (allowedBy(policy, e.baseUrl) === false) return { mark: "▲", text: "endpoint not allowed yet", cls: "st-warn" };
    if (e.tested === undefined) return { mark: "○", text: "not tested", cls: "" };
    return e.tested.ok ? { mark: "✓", text: `tested ${clock(e.tested.atMs)}`, cls: "st-ok" } : { mark: "✕", text: `test failed ${clock(e.tested.atMs)}`, cls: "st-warn" };
  };

  return (
    <>
      <p className="prose pv-intro">
        A provider is a server that speaks the OpenAI chat API: Ollama, vLLM, SGLang, or a hosted endpoint. Without one the agents here plan with algorithms, not with a language model. Each key is shown only as <span className="keystate mono" data-testid="key-state-set">●●●● set</span> or <span className="keystate mono" data-testid="key-state-unset">○ not set</span>; the value is never rendered.
      </p>
      <div className="pv-bar">
        <button type="button" className="btn" onClick={() => (setResult(undefined), setDraft({ ...EMPTY }))} disabled={draft !== undefined} data-testid="pv-add">
          + Add provider
        </button>
      </div>
      {entries.length === 0 ? (
        <p className="muted rc-note" data-testid="pv-empty">
          No provider yet. Add one to let a profile with a language model run.
        </p>
      ) : (
        <table className="pv-table mono" data-testid="pv-table">
          <thead>
            <tr>
              <th>name</th>
              <th>address</th>
              <th>models</th>
              <th>key</th>
              <th>prices</th>
              <th>status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const s = statusOf(e);
              return (
                <tr key={e.id} data-testid={`pv-row-${e.id}`}>
                  <td>{e.id}</td>
                  <td>{e.baseUrl}</td>
                  <td>{e.models === undefined || e.models.length === 0 ? "—" : `${e.models.length} · ${e.models[0]}${e.models.length > 1 ? " …" : ""}`}</td>
                  <td data-testid={`pv-key-${e.id}`}>{keyWords(e.id)}</td>
                  <td>{e.prices === undefined ? "—" : `${e.prices.inputUsdPerMTok} / ${e.prices.outputUsdPerMTok}`}</td>
                  <td className={s.cls} data-testid={`pv-status-${e.id}`} title={e.tested?.summary}>
                    {s.mark} {s.text}
                  </td>
                  <td className="pv-actions">
                    <button type="button" className="btn" disabled={busy} onClick={() => void test(e.id, e.baseUrl, providerStore.keyOf(e.id), e.models?.[0])} data-testid={`pv-test-${e.id}`}>
                      test
                    </button>
                    <button type="button" className="btn" onClick={() => edit(e)} data-testid={`pv-edit-${e.id}`}>
                      edit
                    </button>
                    <button type="button" className="btn dng" onClick={() => setRemoving({ id: e.id, used: usedBy[e.id] ?? [] })} data-testid={`pv-remove-${e.id}`}>
                      remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {removing !== undefined && (
        <div className="pv-confirm" role="alertdialog" aria-label="Remove the provider" data-testid="pv-confirm">
          <b>Remove {removing.id}?</b>{" "}
          {removing.used.length > 0 ? <span>It is used by {removing.used.join(" · ")}: they will have no provider until you pick another. </span> : <span>No profile uses it. </span>}
          <span className="muted">Its key goes with it, wherever it was kept.</span>
          <span className="pv-actions">
            <button type="button" className="btn dng" onClick={() => void providerStore.remove(removing.id).then(() => setRemoving(undefined))} data-testid="pv-confirm-remove">
              Remove
            </button>
            <button type="button" className="btn" onClick={() => setRemoving(undefined)}>
              Cancel
            </button>
          </span>
        </div>
      )}
      {draft !== undefined && (
        <form className="pv-form" onSubmit={(e) => (e.preventDefault(), valid && void save())} data-testid="pv-form" autoComplete="off">
          <h5>{draft.editing === undefined ? "new provider" : `edit ${draft.editing}`}</h5>
          <div className="st-row">
            <span className="rc-label">kind</span>
            <span className="rc-input">
              <select disabled aria-label="Kind" value="openai-compatible" onChange={() => undefined}>
                <option value="openai-compatible">OpenAI-compatible</option>
              </select>
            </span>
            <span className="muted">Ollama, vLLM, SGLang or a hosted endpoint</span>
          </div>
          <div className="st-row">
            <label className="rc-label" htmlFor="pv-name">
              name
            </label>
            <span className="rc-input">
              <input id="pv-name" className="mono" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value.toLowerCase() })} placeholder="local-sglang" data-testid="pv-name" />
            </span>
            <span className={nameOk || draft.name === "" ? "muted" : "st-warn"}>{nameOk || draft.name === "" ? "profiles refer to a provider by this name" : "lowercase letters, digits and hyphens, starting with a letter, not used yet"}</span>
          </div>
          <div className="st-row">
            <label className="rc-label" htmlFor="pv-address">
              address
            </label>
            <span className="rc-input">
              <input id="pv-address" className="mono" value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} placeholder="http://localhost:30000" data-testid="pv-address" />
            </span>
            <span className={base !== undefined || draft.address === "" ? "muted" : "st-warn"}>{base !== undefined || draft.address === "" ? "/v1 is added for you" : "an http:// or https:// address, without a key in it"}</span>
          </div>
          <div className="st-row">
            <label className="rc-label" htmlFor="pv-key">
              key <small>optional</small>
            </label>
            <span className="rc-input">
              <input id="pv-key" type="password" className="mono" autoComplete="off" spellCheck={false} value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} placeholder={draft.editing !== undefined && providerStore.keyState(draft.editing) !== "none" ? "●●●● set: type to replace" : "paste a key, if the server needs one"} data-testid="pv-key" />
            </span>
            <label className="pv-remember">
              <input type="checkbox" checked={draft.remember} onChange={(e) => setDraft({ ...draft, remember: e.target.checked })} data-testid="pv-remember" /> remember on this device
            </label>
          </div>
          {draft.editing !== undefined && providerStore.keyState(draft.editing) !== "none" && (
            <div className="st-row">
              <span className="rc-label" />
              <button type="button" className="btn dng" onClick={() => void providerStore.save(providerStore.get(draft.editing as string) ?? { id: draft.name, kind: "openai-compatible", baseUrl: base ?? draft.address }, "", false).then(() => setDraft({ ...draft, key: "", remember: false }))} data-testid="pv-key-remove">
                Remove the key
              </button>
            </div>
          )}
          <p className="muted rc-note">
            After saving, a key is shown only as ●●●● set, never again in full. It stays in memory for this session unless you tick "remember"; it is never exported, traced or readable from the SQL console.
          </p>
          <div className="st-row pv-prices">
            <span className="rc-label">prices <small>optional</small></span>
            <span className="rc-input">
              <input aria-label="USD per million input tokens" className="mono" inputMode="decimal" value={draft.priceIn} onChange={(e) => setDraft({ ...draft, priceIn: e.target.value })} placeholder="—" data-testid="pv-price-in" />
              <span className="unit">USD / M input tok</span>
            </span>
            <span className="rc-input">
              <input aria-label="USD per million output tokens" className="mono" inputMode="decimal" value={draft.priceOut} onChange={(e) => setDraft({ ...draft, priceOut: e.target.value })} placeholder="—" data-testid="pv-price-out" />
              <span className="unit">USD / M output tok</span>
            </span>
          </div>
          <p className="muted rc-note">Prices are what you pay your provider per million tokens; with them a run also has a cost limit. Without them there is none.</p>
          <div className="pv-buttons">
            <button type="button" className="btn" disabled={!valid || busy} onClick={() => void test(undefined, base as string, draft.key === "" ? (draft.editing === undefined ? undefined : providerStore.keyOf(draft.editing)) : draft.key)} data-testid="pv-test-new">
              Test connection
            </button>
            <button type="submit" className="btn pri" disabled={!valid} data-testid="pv-save">
              Save
            </button>
            <button type="button" className="btn" onClick={() => (setDraft(undefined), setResult(undefined))} data-testid="pv-cancel">
              Cancel
            </button>
          </div>
        </form>
      )}
      {result !== undefined && (
        <p className={`pv-result ${result.ok ? "st-ok" : "st-warn"}`} role="status" data-testid="pv-result" data-kind={result.kind}>
          {result.ok ? "✓" : "✕"} {result.summary}
          <span className="muted"> · each probe sends about 40 tokens and counts toward no limit</span>
        </p>
      )}
      <p className="muted rc-note" data-testid="pv-note">
        <b>Token counts and cost.</b> Tokens are counted by the server (its usage field); a server that sends none is counted as characters ÷ 4, and the run says so. They may differ from a provider's bill. Cost appears only for a provider with prices. <b>Consumption is your responsibility</b>: every run has limits (default 20 calls, 40 000 tokens, 0.05 USD with prices) and pauses when one is reached.
      </p>
    </>
  );
}

/** The addresses beside this computer: what the page's policy allows, and what a server that serves the page adds to allow more. */
export function EndpointsSection(props: { storage: StorageClient; ready: boolean }) {
  const { storage, ready } = props;
  const policy = usePagePolicy();
  const { entries } = useProviders();
  const [extra, setExtra] = useState<readonly string[]>([]);
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!ready) return;
    void storage.ports.userData.get(EXTRA_NAMESPACE, EXTRA_KEY).then((v) => setExtra(Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === "string") : []), () => undefined);
  }, [ready, storage]);
  const persist = (next: readonly string[]) => {
    setExtra(next);
    void storage.ports.userData.set(EXTRA_NAMESPACE, EXTRA_KEY, next).catch(() => undefined);
  };
  const origin = (u: string) => {
    const o = originOf(u);
    return o === undefined ? undefined : `${o.scheme}://${o.host}:${o.port}`;
  };
  const wanted = [...new Set([...extra, ...entries.map((e) => e.baseUrl).filter((u) => allowedBy(policy, u) === false)])];
  const add = () => {
    const a = cleanAddress(text);
    const o = a === undefined ? undefined : origin(a);
    if (o === undefined || extra.includes(o)) return;
    persist([...extra, o]);
    setText("");
  };
  const line = connectSrcLine(wanted);
  return (
    <>
      <p className="prose">
        localhost and 127.0.0.1 on any port are always allowed. Another address is allowed only if the server that serves this page lists it in its policy: a page cannot widen its own, and the worker that calls the model takes its policy from the server too.
        Addresses added here are remembered and checked against the policy this page was served with.
      </p>
      <ul className="pv-endpoints" data-testid="pv-endpoints">
        {extra.map((u) => {
          const ok = allowedBy(policy, u);
          return (
            <li key={u} data-testid="pv-endpoint">
              <span className="mono">{u}</span>
              <span className={ok === true ? "st-ok" : "st-warn"}> {ok === true ? "✓ allowed by this page's policy" : "▲ the policy this page was served with does not list it yet"}</span>
              <button type="button" className="btn" aria-label={`Remove ${u}`} onClick={() => persist(extra.filter((x) => x !== u))}>
                ✕
              </button>
            </li>
          );
        })}
      </ul>
      <div className="st-row">
        <span className="rc-input">
          <input className="mono" aria-label="Address to add" value={text} onChange={(e) => setText(e.target.value)} placeholder="https://…" onKeyDown={(e) => e.key === "Enter" && add()} data-testid="pv-endpoint-input" />
        </span>
        <button type="button" className="btn" onClick={add} disabled={cleanAddress(text) === undefined} data-testid="pv-endpoint-add">
          add
        </button>
      </div>
      {wanted.length > 0 && (
        <p className="muted rc-note">
          To allow them, the server that serves this page adds this to its Content-Security-Policy (for the Vite server of this repository: <code className="mono">AGENTSIM_CONNECT_SRC</code>):{" "}
          <code className="mono" data-testid="pv-csp-line">
            {line}
          </code>{" "}
          <button
            type="button"
            className="btn"
            onClick={() => void navigator.clipboard?.writeText(line).then(() => setCopied(true), () => undefined)}
            data-testid="pv-csp-copy"
          >
            {copied ? "copied" : "copy"}
          </button>
        </p>
      )}
    </>
  );
}

