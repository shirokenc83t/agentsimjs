import "../panels.css";
import { validateMindProfile, validatePromptTemplate } from "@agentsim/minds";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProviders } from "../../config/providers.ts";
import { useServices } from "../../services.tsx";
import { LazyTemplateEditor } from "../../workspaces/registry.tsx";
import { diffDocs, listItems, profileLines, storeOf, usedBy, versionsOf, type LibItem, type LibKind, type LibVersion, type UsedBy } from "./library-model.ts";
import { bumpLibraryRevision } from "./library-revision.ts";
import type { TemplateEditorHandle } from "./template-editor.tsx";
import { lintTemplateText, sectionTokens, SLOT_NAMES, templateToText, textToTemplate, type TemplateDoc } from "./template-text.ts";

// The Library (F4 M4, T-124, the designer's LibraryMinds board): mind profiles and prompt templates of this browser, versioned. A version is never changed: editing makes a new one (`edit as v4`), and a run keeps the
// version it used, so a re-run is the same mind. A profile is its table, an edit form and the diff between two versions; a template is its text in the editor (fixed slots read-only, only the text around them is
// edited), with the size of each section in tokens and the issues the validator would raise marked in the text. Import and export are JSON. The editor (CodeMirror) loads when a template is opened.

const download = (name: string, text: string) => {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
};

interface ProfileDraft {
  provider: string;
  model: string;
  template: string;
  temperature: string;
  calls: string;
  tokens: string;
  costUsd: string;
  retries: string;
  toolCalls: string;
  decisions: string;
}

function draftOf(doc: unknown): ProfileDraft {
  const s2 = ((doc as { s2?: Record<string, Record<string, unknown> | string | undefined> } | undefined)?.s2 ?? {}) as Record<string, unknown>;
  const g = (o: unknown, k: string) => (typeof o === "object" && o !== null && (o as Record<string, unknown>)[k] !== undefined ? String((o as Record<string, unknown>)[k]) : "");
  const t = s2["promptTemplate"] as { id?: string; version?: number } | undefined;
  return { provider: String(s2["provider"] ?? ""), model: String(s2["model"] ?? ""), template: t === undefined ? "default@1" : `${t.id}@${t.version}`, temperature: g(s2["params"], "temperature"), calls: g(s2["limits"], "calls"), tokens: g(s2["limits"], "tokens"), costUsd: g(s2["limits"], "costUsd"), retries: g(s2["limits"], "retries"), toolCalls: g(s2["tools"], "maxCallsPerDecision"), decisions: g(s2["context"], "decisions") };
}

/** The document a form stands for; a field left empty is left out of the document (the default applies). */
function docOf(d: ProfileDraft, base: unknown): unknown {
  const n = (v: string) => (v.trim() === "" ? undefined : Number(v));
  const prune = <T extends Record<string, unknown>>(o: T): Partial<T> | undefined => {
    const e = Object.entries(o).filter(([, v]) => v !== undefined);
    return e.length === 0 ? undefined : (Object.fromEntries(e) as Partial<T>);
  };
  const [tid, tver] = d.template.split("@");
  const old = ((base as { s2?: { tools?: { allow?: unknown } } } | undefined)?.s2 ?? {}) as { tools?: { allow?: unknown } };
  return {
    schemaVersion: 1,
    kind: "mind-profile",
    shape: "s2",
    s2: {
      provider: d.provider,
      model: d.model,
      promptTemplate: { id: tid, version: Number(tver) },
      ...(prune({ temperature: n(d.temperature) }) === undefined ? {} : { params: prune({ temperature: n(d.temperature) }) }),
      ...(prune({ calls: n(d.calls), tokens: n(d.tokens), costUsd: n(d.costUsd), retries: n(d.retries) }) === undefined ? {} : { limits: prune({ calls: n(d.calls), tokens: n(d.tokens), costUsd: n(d.costUsd), retries: n(d.retries) }) }),
      ...(prune({ maxCallsPerDecision: n(d.toolCalls), allow: old.tools?.allow }) === undefined ? {} : { tools: prune({ maxCallsPerDecision: n(d.toolCalls), allow: old.tools?.allow }) }),
      ...(prune({ decisions: n(d.decisions) }) === undefined ? {} : { context: prune({ decisions: n(d.decisions) }) }),
    },
  };
}

const EMPTY_VERSIONS: LibVersion[] = [];

export function LibraryPanel() {
  const { storage } = useServices();
  const ports = storage.ports;
  const { entries: providers } = useProviders();
  const [kind, setKind] = useState<LibKind>("profile");
  const [items, setItems] = useState<Record<LibKind, LibItem[]>>({ profile: [], template: [] });
  const [templateItems, setTemplateItems] = useState<LibItem[]>([]);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  // The versions read for one item of one kind: what is drawn is only ever the versions of the item and the kind on show (a tab or an import changes both before the read is back).
  const [read, setRead] = useState<{ readonly kind: LibKind; readonly id: string; readonly list: LibVersion[] } | undefined>(undefined);
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [compare, setCompare] = useState(false);
  const [used, setUsed] = useState<UsedBy | undefined>(undefined);
  const [editing, setEditing] = useState<{ draft?: ProfileDraft; text?: string } | undefined>(undefined);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>(undefined);
  const [dupName, setDupName] = useState<string | undefined>(undefined);
  const editor = useRef<TemplateEditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const [p, t] = await Promise.all([listItems(ports, "profile"), listItems(ports, "template")]);
    setItems({ profile: p, template: t });
    setTemplateItems(t);
  }, [ports]);
  useEffect(() => void refresh().catch(() => undefined), [refresh]);

  const item = items[kind].find((i) => i.id === selected);
  const versions = read !== undefined && read.kind === kind && read.id === item?.id ? read.list : EMPTY_VERSIONS;
  useEffect(() => {
    if (item === undefined) {
      setRead(undefined);
      setVersion(undefined);
      return;
    }
    let live = true;
    void versionsOf(storeOf(ports, kind), item.id, item.latestVersion).then((v) => {
      if (!live) return;
      setRead({ kind, id: item.id, list: v });
      setVersion((cur) => (cur !== undefined && v.some((x) => x.version === cur) ? cur : v[v.length - 1]?.version));
    });
    return () => {
      live = false;
    };
  }, [ports, kind, item?.id, item?.latestVersion]);
  useEffect(() => {
    setEditing(undefined);
    setCompare(false);
    setDupName(undefined);
  }, [kind, selected, version]);
  useEffect(() => {
    if (item === undefined || version === undefined) return setUsed(undefined);
    let live = true;
    void usedBy(ports, kind, item.id, version).then((u) => live && setUsed(u));
    return () => {
      live = false;
    };
  }, [ports, kind, item?.id, version, item?.latestVersion]);

  const current = versions.find((v) => v.version === version);
  const previous = versions.filter((v) => version !== undefined && v.version < version).pop();
  const isUsed = used !== undefined && used.runs.length + used.configurations.length + used.profiles.length > 0;
  const diff = useMemo(() => (compare && current !== undefined && previous !== undefined ? diffDocs(previous.document, current.document) : undefined), [compare, current, previous]);
  const draftText = editing?.text ?? (current === undefined || kind !== "template" ? "" : templateToText(current.document as TemplateDoc));
  const issues = useMemo(() => (kind === "template" ? lintTemplateText(draftText) : []), [kind, draftText]);
  const tokens = useMemo(() => (kind === "template" ? sectionTokens(draftText) : []), [kind, draftText]);

  const save = async (id: string, document: unknown, then?: (v: number) => void) => {
    const checked = kind === "profile" ? validateMindProfile(document) : validatePromptTemplate(document);
    if (!checked.ok) return setMessage({ ok: false, text: `${checked.error.code}: ${checked.error.message}` });
    const saved = await storeOf(ports, kind).saveVersion({ id, name: id, document });
    if (!saved.ok) return setMessage({ ok: false, text: `${saved.error.code}: ${saved.error.message}` });
    bumpLibraryRevision();
    await refresh();
    setSelected(id);
    setEditing(undefined);
    setDupName(undefined);
    setMessage({ ok: true, text: `saved as ${id} v${saved.value.version}` });
    then?.(saved.value.version);
    setVersion(saved.value.version);
  };

  const importFile = async (file: File) => {
    try {
      const doc = JSON.parse(await file.text()) as { kind?: unknown };
      const k: LibKind = doc.kind === "prompt-template" ? "template" : "profile";
      const checked = k === "profile" ? validateMindProfile(doc) : validatePromptTemplate(doc);
      if (!checked.ok) return setMessage({ ok: false, text: `${checked.error.code}: ${checked.error.message}` });
      const id = file.name.replace(/\.json$/i, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "imported";
      const saved = await storeOf(ports, k).saveVersion({ id, name: id, document: doc });
      if (!saved.ok) return setMessage({ ok: false, text: `${saved.error.code}: ${saved.error.message}` });
      bumpLibraryRevision();
      await refresh();
      setKind(k);
      setSelected(id);
      setMessage({ ok: true, text: `imported as ${id} v${saved.value.version}` });
    } catch (e) {
      setMessage({ ok: false, text: `the file is not a profile or a template: ${e instanceof Error ? e.message : "not JSON"}` });
    }
  };

  const templateOptions = templateItems.flatMap((t) => Array.from({ length: t.latestVersion }, (_, i) => `${t.id}@${i + 1}`));
  if (!templateOptions.includes("default@1")) templateOptions.unshift("default@1");

  return (
    <div className="panel library" data-testid="library-panel">
      <div className="lib-head">
        <b>Library</b> <span className="muted">· browser-local · versioned</span>
        <span className="sp" />
        <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])} data-testid="lib-import-file" />
        <button type="button" className="btn" onClick={() => fileInput.current?.click()} data-testid="lib-import">
          import JSON
        </button>
      </div>
      <div className="lib-body">
        <div className="lib-list">
          <div className="li-tabs" role="tablist">
            {(["profile", "template"] as const).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={kind === k} className={`kt${kind === k ? " on" : ""}`} onClick={() => (setKind(k), setSelected(undefined), setMessage(undefined))} data-testid={`lib-tab-${k}`}>
                {k === "profile" ? "mind profiles" : "prompt templates"} · {items[k].length}
              </button>
            ))}
          </div>
          <ul>
            {items[kind].length === 0 && <li className="muted lib-empty">{kind === "profile" ? "No profile yet: import one, or save a duplicate of a template-based one." : "No template yet: the built-in default is used by a profile that names default v1."}</li>}
            {items[kind].map((i) => (
              <li key={i.id}>
                <button type="button" className={i.id === selected ? "sel" : undefined} onClick={() => (setSelected(i.id), setMessage(undefined))} data-testid={`lib-item-${i.id}`}>
                  <b>{i.id}</b> <span className="muted">v{i.latestVersion}</span>
                  <br />
                  <span className="muted mono">{i.summary}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="lib-detail">
          {item === undefined || current === undefined || version === undefined ? (
            <p className="muted" data-testid="lib-nothing">
              Pick a {kind === "profile" ? "profile" : "template"} to see its versions.
            </p>
          ) : (
            <>
              <div className="lib-versions" data-testid="lib-versions">
                <b>{item.id}</b>
                <span className="muted"> versions</span>
                {versions.map((v) => (
                  <button key={v.version} type="button" className={`kt${v.version === version ? " on" : ""}`} onClick={() => setVersion(v.version)} data-testid={`lib-version-${v.version}`}>
                    v{v.version}
                  </button>
                ))}
                <span className="muted" data-testid="lib-used">
                  {isUsed ? ` · v${version} used by ${[...used.runs, ...used.configurations, ...used.profiles].join(", ")}` : ` · v${version} not used`}
                </span>
              </div>
              {previous !== undefined && editing === undefined && (
                <label className="lib-compare">
                  <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} data-testid="lib-compare" /> diff v{previous.version} → v{version}
                </label>
              )}
              {diff !== undefined && (
                <table className="lib-diff mono" data-testid="lib-diff">
                  <tbody>
                    {diff.map((l) => (
                      <tr key={l.path} data-change={l.change}>
                        <td>{l.change === "changed" || l.change === "removed" ? "−" : l.change === "added" ? "+" : ""}</td>
                        <td>{l.path}</td>
                        <td>{l.change === "same" ? l.after : l.change === "added" ? l.after : l.before}</td>
                        <td>{l.change === "changed" ? `+ ${l.after}` : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {diff === undefined && kind === "profile" && editing?.draft === undefined && (
                <dl className="compute-kv mono" data-testid="lib-profile-table">
                  {profileLines(current.document).flatMap((l) => [<dt key={`${l.label}-k`}>{l.label}</dt>, <dd key={`${l.label}-v`}>{l.value}</dd>])}
                </dl>
              )}
              {editing?.draft !== undefined && (
                <form className="lib-form" data-testid="lib-profile-form" onSubmit={(e) => e.preventDefault()}>
                  {(
                    [
                      ["provider", "provider", providers.map((p) => p.id)],
                      ["model", "model", undefined],
                      ["template", "template", templateOptions],
                      ["temperature", "temperature", undefined],
                      ["calls", "limit · calls", undefined],
                      ["tokens", "limit · tokens", undefined],
                      ["costUsd", "limit · cost (USD)", undefined],
                      ["retries", "retries", undefined],
                      ["toolCalls", "tool calls a decision", undefined],
                      ["decisions", "last N decisions", undefined],
                    ] as const
                  ).map(([key, label, options]) => (
                    <div className="st-row" key={key}>
                      <label className="rc-label" htmlFor={`lib-f-${key}`}>
                        {label}
                      </label>
                      <span className="rc-input">
                        {options === undefined ? (
                          <input id={`lib-f-${key}`} className="mono" value={editing.draft?.[key] ?? ""} onChange={(e) => setEditing({ draft: { ...(editing.draft as ProfileDraft), [key]: e.target.value } })} data-testid={`lib-f-${key}`} />
                        ) : (
                          <select id={`lib-f-${key}`} value={editing.draft?.[key] ?? ""} onChange={(e) => setEditing({ draft: { ...(editing.draft as ProfileDraft), [key]: e.target.value } })} data-testid={`lib-f-${key}`}>
                            {[...new Set([editing.draft?.[key] ?? "", ...options])].map((o) => (
                              <option key={o} value={o}>
                                {o === "" ? "—" : o}
                              </option>
                            ))}
                          </select>
                        )}
                      </span>
                    </div>
                  ))}
                </form>
              )}
              {kind === "template" && (
                <>
                  <Suspense fallback={<p className="muted">Loading the editor…</p>}>
                    <LazyTemplateEditor key={`${item.id}@${version}:${editing === undefined ? "r" : "w"}`} ref={editor} value={draftText} readOnly={editing === undefined} onChange={(t) => editing !== undefined && setEditing({ text: t })} />
                  </Suspense>
                  <p className="muted mono" data-testid="lib-tokens">
                    {tokens.map((t) => `${t.slot} ${t.tokens} tok`).join(" · ")} · characters / 4, an estimate · {tokens.reduce((n, t) => n + t.tokens, 0)} tok in all
                  </p>
                  {issues.length > 0 && (
                    <ul className="lib-issues" data-testid="lib-issues">
                      {issues.map((i, k) => (
                        <li key={k} className="st-warn">
                          ✕ {i.code}: {i.message}
                        </li>
                      ))}
                    </ul>
                  )}
                  {editing !== undefined && (
                    <div className="lib-slots">
                      <span className="muted">add a slot:</span>
                      {SLOT_NAMES.filter((s) => !draftText.includes(`{{${s}}}`)).map((s) => (
                        <button key={s} type="button" className="kt" onClick={() => editor.current?.insertSlot(s)} data-testid={`lib-slot-${s}`}>
                          {`{{${s}}}`}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
              <div className="lib-actions">
                {editing === undefined ? (
                  <>
                    <button type="button" className="btn pri" onClick={() => setEditing(kind === "profile" ? { draft: draftOf(current.document) } : { text: draftText })} data-testid="lib-edit">
                      edit as v{item.latestVersion + 1}
                    </button>
                    <button type="button" className="btn" onClick={() => setDupName(`${item.id}-copy`)} data-testid="lib-duplicate">
                      duplicate
                    </button>
                    <button type="button" className="btn" onClick={() => download(`${item.id}-v${version}.json`, `${JSON.stringify(current.document, null, 2)}\n`)} data-testid="lib-export">
                      export JSON
                    </button>
                    <span className="muted">a used version is never changed</span>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="btn pri"
                      disabled={kind === "template" && issues.length > 0}
                      onClick={() => void save(item.id, kind === "profile" ? docOf(editing.draft as ProfileDraft, current.document) : textToTemplate(editing.text ?? draftText))}
                      data-testid="lib-save"
                    >
                      save as v{item.latestVersion + 1}
                    </button>
                    <button type="button" className="btn" onClick={() => setEditing(undefined)} data-testid="lib-cancel">
                      cancel
                    </button>
                  </>
                )}
              </div>
              {dupName !== undefined && (
                <div className="lib-dup" data-testid="lib-dup">
                  <span className="rc-input">
                    <input className="mono" aria-label="Name of the copy" value={dupName} onChange={(e) => setDupName(e.target.value.toLowerCase())} data-testid="lib-dup-name" />
                  </span>
                  <button type="button" className="btn pri" disabled={!/^[a-z][a-z0-9-]{0,31}$/.test(dupName) || items[kind].some((i) => i.id === dupName)} onClick={() => void save(dupName, current.document)} data-testid="lib-dup-save">
                    save the copy as v1
                  </button>
                  <button type="button" className="btn" onClick={() => setDupName(undefined)}>
                    cancel
                  </button>
                </div>
              )}
            </>
          )}
          {message !== undefined && (
            <p className={message.ok ? "st-ok" : "st-warn"} role="status" data-testid="lib-message">
              {message.ok ? "✓" : "✕"} {message.text}
            </p>
          )}
          <p className="muted rc-note">Editing a profile makes a new version; runs keep the version they used, so a re-run is the same mind. A template's fixed slots (role, mission, notebook, last decisions, state, beliefs, space, events, allowed actions) are read-only; only the text around them is edited.</p>
        </div>
      </div>
    </div>
  );
}
