import type { LibraryStore, StoragePorts, StoredDocument } from "@agentsim/storage";
import { s2References } from "../../sim/minds-spec.ts";

// The library of mind profiles and prompt templates as the panel reads it (F4 M4, T-124, the designer's LibraryMinds board): what is stored, each version of an item, the difference between two versions, what a version
// is used by, and a profile as the words of its table. Versions are immutable: a change is a new version. Pure apart from the reads of the ports.

export type LibKind = "profile" | "template";
type Ports = Pick<StoragePorts, "mindProfiles" | "promptTemplates" | "runs" | "runConfigs">;

export const storeOf = (ports: Pick<StoragePorts, "mindProfiles" | "promptTemplates">, kind: LibKind): LibraryStore => (kind === "profile" ? ports.mindProfiles : ports.promptTemplates);

export interface LibItem {
  readonly id: string;
  readonly name: string;
  readonly latestVersion: number;
  readonly versionCount: number;
  /** The one-line words of the item's latest version (`s2 · local-ollama`, `9 slots`). */
  readonly summary: string;
}

type Doc = Record<string, unknown>;
const asDoc = (d: unknown): Doc => (typeof d === "object" && d !== null ? (d as Doc) : {});

/** The line the list shows for a document: a profile's shape and provider, a template's number of slots. */
export function summaryOf(kind: LibKind, document: unknown): string {
  const d = asDoc(document);
  if (kind === "template") return `${Array.isArray(d["sections"]) ? (d["sections"] as unknown[]).length : 0} slots`;
  const s2 = asDoc(d["s2"]);
  return typeof s2["provider"] === "string" ? `s2 · ${s2["provider"]}` : String(d["shape"] ?? "profile");
}

export async function listItems(ports: Pick<StoragePorts, "mindProfiles" | "promptTemplates">, kind: LibKind): Promise<LibItem[]> {
  const store = storeOf(ports, kind);
  const out: LibItem[] = [];
  for (const s of await store.list()) {
    const latest = await store.get(s.id, s.latestVersion);
    out.push({ id: s.id, name: s.name, latestVersion: s.latestVersion, versionCount: s.versionCount, summary: summaryOf(kind, latest?.document) });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

export interface LibVersion {
  readonly version: number;
  readonly document: unknown;
}

/** Every version of an item that still exists (a deleted one leaves a gap), oldest first. */
export async function versionsOf(store: LibraryStore, id: string, latest: number): Promise<LibVersion[]> {
  const out: LibVersion[] = [];
  for (let v = 1; v <= latest; v++) {
    const d: StoredDocument | undefined = await store.get(id, v);
    if (d !== undefined && d.document !== undefined && d.document !== null) out.push({ version: v, document: d.document });
  }
  return out;
}

// ---- the difference of two versions ----------------------------------------------------------------------------------------------------------------

export interface DiffLine {
  readonly path: string;
  readonly change: "same" | "changed" | "added" | "removed";
  readonly before?: string;
  readonly after?: string;
}

/** The leaves of a document by path (`s2.limits.calls`), each as its JSON text; an array is one leaf (a list is read whole). */
export function flatten(doc: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (v: unknown, path: string) => {
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      const entries = Object.entries(v as Doc);
      if (entries.length === 0 && path !== "") out.set(path, "{}");
      for (const [k, x] of entries) walk(x, path === "" ? k : `${path}.${k}`);
    } else out.set(path, JSON.stringify(v));
  };
  walk(doc, prefix);
  return out;
}

/** The lines of a diff between two documents, in the order of the paths of the newer one then the removed ones; `same` lines are kept so that the table can show them dimmed. */
export function diffDocs(before: unknown, after: unknown): DiffLine[] {
  const a = flatten(before);
  const b = flatten(after);
  const out: DiffLine[] = [];
  for (const [path, v] of b) {
    const old = a.get(path);
    if (old === undefined) out.push({ path, change: "added", after: v });
    else if (old === v) out.push({ path, change: "same", after: v });
    else out.push({ path, change: "changed", before: old, after: v });
  }
  for (const [path, v] of a) if (!b.has(path)) out.push({ path, change: "removed", before: v });
  return out;
}

// ---- what a version is used by ---------------------------------------------------------------------------------------------------------------------

export interface UsedBy {
  /** Runs whose configuration names the version (by ID). */
  readonly runs: readonly string[];
  /** Run configuration presets that name it, as `id vN`. */
  readonly configurations: readonly string[];
  /** For a template: the profiles (any version) that name it, as `id vN`. */
  readonly profiles: readonly string[];
}

/** Where a version of a profile or a template is used. A used version is never changed: that is what the library keeps (an edit is a new version). */
export async function usedBy(ports: Ports, kind: LibKind, id: string, version: number): Promise<UsedBy> {
  const names = (refs: { id: string; version: number }[]) => refs.some((r) => r.id === id && r.version === version);
  const profileDocs = async (): Promise<{ id: string; version: number; templateOf: { id: string; version: number } | undefined }[]> => {
    const out: { id: string; version: number; templateOf: { id: string; version: number } | undefined }[] = [];
    for (const s of await ports.mindProfiles.list()) {
      for (let v = 1; v <= s.latestVersion; v++) {
        const d = await ports.mindProfiles.get(s.id, v);
        const t = asDoc(asDoc(d?.document)["s2"])["promptTemplate"] as { id?: unknown; version?: unknown } | undefined;
        if (d !== undefined) out.push({ id: s.id, version: v, templateOf: typeof t?.id === "string" && typeof t.version === "number" ? { id: t.id, version: t.version } : undefined });
      }
    }
    return out;
  };
  const refsOf = async (runConfig: unknown): Promise<{ id: string; version: number }[]> => {
    const r = s2References(runConfig);
    if (kind === "profile") return [...r.profiles];
    const direct = [...r.templates];
    const inProfiles = (await profileDocs()).filter((p) => r.profiles.some((x) => x.id === p.id && x.version === p.version) && p.templateOf !== undefined).map((p) => p.templateOf as { id: string; version: number });
    return [...direct, ...inProfiles];
  };
  const runs: string[] = [];
  for (const h of await ports.runs.list()) if (h.runConfig !== undefined && names(await refsOf(h.runConfig))) runs.push(h.runId);
  const configurations: string[] = [];
  for (const s of await ports.runConfigs.list()) {
    const d = await ports.runConfigs.get(s.id, s.latestVersion);
    if (d !== undefined && names(await refsOf(d.document))) configurations.push(`${s.id} v${s.latestVersion}`);
  }
  const profiles = kind === "template" ? (await profileDocs()).filter((p) => p.templateOf?.id === id && p.templateOf.version === version).map((p) => `${p.id} v${p.version}`) : [];
  return { runs, configurations, profiles };
}

/** The words a profile's table shows: the fields of its `s2` part, one line each. */
export function profileLines(document: unknown): { readonly label: string; readonly value: string }[] {
  const s2 = asDoc(asDoc(document)["s2"]);
  const params = asDoc(s2["params"]);
  const limits = asDoc(s2["limits"]);
  const tools = asDoc(s2["tools"]);
  const context = asDoc(s2["context"]);
  const latency = asDoc(s2["latency"]);
  const tpl = asDoc(s2["promptTemplate"]);
  const num = (v: unknown, unit: string) => (typeof v === "number" ? `${v}${unit}` : undefined);
  const limitWords = [num(limits["calls"], " calls"), num(limits["tokens"], " tok"), num(limits["costUsd"], " USD")].filter((x): x is string => x !== undefined).join(" · ");
  return [
    { label: "provider", value: String(s2["provider"] ?? "—") },
    { label: "model", value: String(s2["model"] ?? "—") },
    { label: "template", value: tpl["id"] === undefined ? "—" : `${String(tpl["id"])} v${String(tpl["version"])}` },
    { label: "temperature", value: String(params["temperature"] ?? "provider default") },
    { label: "tools", value: Array.isArray(tools["allow"]) ? (tools["allow"] as string[]).join(", ") : "all of them" },
    { label: "tool calls", value: `${String(tools["maxCallsPerDecision"] ?? "default (8)")} a decision` },
    { label: "retries", value: String(limits["retries"] ?? "default (1)") },
    { label: "limits", value: limitWords === "" ? "defaults (20 calls · 40 000 tok · 0.05 USD)" : limitWords },
    { label: "last N", value: `${String(context["decisions"] ?? "default (5)")} decisions` },
    { label: "latency", value: latency["model"] === "fixed" ? `fixed ${String(latency["fixedMs"] ?? "?")} ms` : "measured" },
  ];
}
