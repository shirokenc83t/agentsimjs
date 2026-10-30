import { normalizeBaseUrl } from "@agentsim/minds";
import { PROVIDER_KEYS_NAMESPACE, type UserDataStore } from "@agentsim/storage";
import { useSyncExternalStore } from "react";

// The provider entries of Settings (F4 M3, ADR-0044 sections 2 and 3): where the minds' models are, with the models the server listed, optional prices, and optionally a key. The entries are plain data in
// `user_data` (never a key inside them). A key lives in memory for the session by default; "remember on this device" also puts it in `user_data` under its own namespace, which the SQL console cannot read
// and a database export leaves out. A key is never rendered back: the UI reads `keyState`, never the key. It reaches the sim worker in a message of its own, and the adapter puts it in one header.

export interface ProviderPrices {
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
}

/** What the last test of a provider found, in words (kept with the entry; it holds nothing of the exchange). */
export interface ProviderTested {
  readonly atMs: number;
  readonly ok: boolean;
  readonly summary: string;
}

export interface ProviderEntry {
  readonly id: string;
  readonly kind: "openai-compatible";
  /** Without `/v1`: the adapter adds the paths. */
  readonly baseUrl: string;
  readonly models?: readonly string[];
  readonly prices?: ProviderPrices;
  /** The key is also kept in `user_data` (never exported, unreadable from the SQL console). */
  readonly rememberKey: boolean;
  readonly tested?: ProviderTested;
}

export type KeyState = "none" | "session" | "device";

export const PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;
const NAMESPACE = "providers";
const ENTRIES_KEY = "entries";
const MAX_ENTRIES = 32;

/** The address as the user may type it: `/v1` and a trailing slash are dropped (the adapter adds `/v1/...`), anything that is not an http(s) address is refused (undefined). */
export function cleanAddress(raw: string): string | undefined {
  const base = normalizeBaseUrl(raw.trim().replace(/\/v1\/?$/i, ""));
  return base;
}

/** A well-formed entry from untrusted stored data, or undefined. */
function parseEntry(v: unknown): ProviderEntry | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o["id"] !== "string" || !PROVIDER_ID.test(o["id"]) || o["kind"] !== "openai-compatible" || typeof o["baseUrl"] !== "string") return undefined;
  const baseUrl = normalizeBaseUrl(o["baseUrl"]);
  if (baseUrl === undefined) return undefined;
  const models = Array.isArray(o["models"]) ? (o["models"] as unknown[]).filter((m): m is string => typeof m === "string").slice(0, 256) : undefined;
  const p = o["prices"] as Record<string, unknown> | undefined;
  const prices = p !== undefined && typeof p["inputUsdPerMTok"] === "number" && typeof p["outputUsdPerMTok"] === "number" && p["inputUsdPerMTok"] >= 0 && p["outputUsdPerMTok"] >= 0 ? { inputUsdPerMTok: p["inputUsdPerMTok"], outputUsdPerMTok: p["outputUsdPerMTok"] } : undefined;
  const t = o["tested"] as Record<string, unknown> | undefined;
  const tested = t !== undefined && typeof t["atMs"] === "number" && typeof t["ok"] === "boolean" && typeof t["summary"] === "string" ? { atMs: t["atMs"], ok: t["ok"], summary: t["summary"].slice(0, 500) } : undefined;
  return { id: o["id"], kind: "openai-compatible", baseUrl, ...(models === undefined ? {} : { models }), ...(prices === undefined ? {} : { prices }), rememberKey: o["rememberKey"] === true, ...(tested === undefined ? {} : { tested }) };
}

export interface ProvidersView {
  readonly entries: readonly ProviderEntry[];
  /** Bumped when a key is set or removed (the entries do not change then, but what `keyState` says does). */
  readonly keysVersion: number;
}

type Listener = () => void;

/** The store: entries and keys. One per page; the lab wires `onKeys` to the sim worker. */
export class ProviderStore {
  private entries: readonly ProviderEntry[] = [];
  private readonly keys = new Map<string, string>();
  private readonly remembered = new Set<string>();
  private keysVersion = 0;
  private view: ProvidersView = { entries: [], keysVersion: 0 };
  private readonly listeners = new Set<Listener>();
  private userData: UserDataStore | undefined;
  private onKeys: ((keys: Readonly<Record<string, string>>) => void) | undefined;

  /** Where the keys go when they change (the sim worker). Told at once with what is held. */
  connectKeys(f: (keys: Readonly<Record<string, string>>) => void): void {
    this.onKeys = f;
    f(this.keyObject());
  }

  private keyObject(): Record<string, string> {
    return Object.fromEntries([...this.keys].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  }

  private emit(): void {
    this.view = { entries: this.entries, keysVersion: this.keysVersion };
    for (const l of this.listeners) l();
    this.onKeys?.(this.keyObject());
  }

  getView = (): ProvidersView => this.view;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  /** Reads the entries and the keys the user chose to remember. Without storage the store stays empty (nothing is lost: nothing was kept). */
  async load(userData: UserDataStore): Promise<void> {
    this.userData = userData;
    const raw = await userData.get(NAMESPACE, ENTRIES_KEY).catch(() => undefined);
    const entries = Array.isArray(raw) ? (raw as unknown[]).flatMap((e) => parseEntry(e) ?? []).slice(0, MAX_ENTRIES) : [];
    for (const e of entries) {
      if (!e.rememberKey) continue;
      const k = await userData.get(PROVIDER_KEYS_NAMESPACE, e.id).catch(() => undefined);
      if (typeof k === "string" && k !== "") {
        this.keys.set(e.id, k);
        this.remembered.add(e.id);
      }
    }
    this.entries = entries;
    this.keysVersion++;
    this.emit();
  }

  list(): readonly ProviderEntry[] {
    return this.entries;
  }

  get(id: string): ProviderEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  keyState(id: string): KeyState {
    return !this.keys.has(id) ? "none" : this.remembered.has(id) ? "device" : "session";
  }

  /** The key of an entry, for the code that makes the call (the adapter, the probe). The UI never asks for it. */
  keyOf(id: string): string | undefined {
    return this.keys.get(id);
  }

  private async persistEntries(): Promise<void> {
    await this.userData?.set(NAMESPACE, ENTRIES_KEY, this.entries).catch(() => undefined);
  }

  /**
   * Saves an entry. `key`: undefined leaves the key as it is, a string sets it (empty removes it). `remember` says whether the key is also kept in `user_data`; turning it off deletes the kept copy and keeps the
   * one in memory.
   */
  async save(entry: Omit<ProviderEntry, "rememberKey">, key: string | undefined, remember: boolean): Promise<void> {
    const rest = this.entries.filter((e) => e.id !== entry.id);
    const next: ProviderEntry = { ...entry, rememberKey: remember };
    this.entries = [...rest, next].sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, MAX_ENTRIES);
    if (key !== undefined) {
      if (key === "") this.keys.delete(entry.id);
      else this.keys.set(entry.id, key);
    }
    const held = this.keys.get(entry.id);
    if (held !== undefined && remember) {
      this.remembered.add(entry.id);
      await this.userData?.set(PROVIDER_KEYS_NAMESPACE, entry.id, held).catch(() => undefined);
    } else {
      this.remembered.delete(entry.id);
      await this.userData?.delete(PROVIDER_KEYS_NAMESPACE, entry.id).catch(() => undefined);
    }
    this.keysVersion++;
    await this.persistEntries();
    this.emit();
  }

  /** What a test found, kept with the entry. */
  async setTested(id: string, tested: ProviderTested, models?: readonly string[]): Promise<void> {
    const e = this.get(id);
    if (e === undefined) return;
    this.entries = this.entries.map((x) => (x.id === id ? { ...x, tested, ...(models === undefined ? {} : { models }) } : x));
    await this.persistEntries();
    this.emit();
  }

  /** Removes an entry and every copy of its key. */
  async remove(id: string): Promise<void> {
    this.entries = this.entries.filter((e) => e.id !== id);
    this.keys.delete(id);
    this.remembered.delete(id);
    this.keysVersion++;
    await this.userData?.delete(PROVIDER_KEYS_NAMESPACE, id).catch(() => undefined);
    await this.persistEntries();
    this.emit();
  }

  /** Test seam: forget everything held in memory. */
  reset(): void {
    this.entries = [];
    this.keys.clear();
    this.remembered.clear();
    this.userData = undefined;
    this.keysVersion++;
    this.emit();
  }
}

export const providerStore = new ProviderStore();

export function useProviders(): ProvidersView {
  return useSyncExternalStore(providerStore.subscribe, providerStore.getView, providerStore.getView);
}
