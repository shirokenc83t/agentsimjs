import type { MindProfileDocument, PromptTemplateDocument } from "@agentsim/minds";
import { DEFAULT_PROMPT_TEMPLATE } from "@agentsim/minds";
import type { MindLibrary, ProviderInfo } from "@agentsim/scenarios";
import { useEffect, useMemo, useState } from "react";
import { providerStore, useProviders } from "../../config/providers.ts";
import { useServices, useStorageStatus } from "../../services.tsx";
import { useLibraryRevision } from "../library/library-revision.ts";

// The library of mind profiles and prompt templates and the providers of Settings, as the resolution of a run configuration needs them (F4 M4, T-125): every stored version read once into maps, so that
// the form validates a draft with an `s2` entry as a run would, and the minds table can offer what exists. Re-read when the library changes (`refresh`).

export interface MindLibraryView {
  readonly library: MindLibrary;
  readonly providers: (id: string) => ProviderInfo | undefined;
  /** The profiles of the library with their versions, for the select of a row. */
  readonly profiles: readonly { readonly id: string; readonly versions: readonly number[] }[];
  readonly templates: readonly { readonly id: string; readonly versions: readonly number[] }[];
  readonly loaded: boolean;
}

export function useMindLibrary(): MindLibraryView {
  const { storage } = useServices();
  const status = useStorageStatus(storage);
  const { entries } = useProviders();
  const [docs, setDocs] = useState<{ profiles: Map<string, MindProfileDocument>; templates: Map<string, PromptTemplateDocument>; profileList: MindLibraryView["profiles"]; templateList: MindLibraryView["templates"]; loaded: boolean }>({ profiles: new Map(), templates: new Map(), profileList: [], templateList: [], loaded: false });
  const ready = status.state === "ready";
  const revision = useLibraryRevision();
  useEffect(() => {
    if (!ready) return;
    let live = true;
    void (async () => {
      const read = async (store: typeof storage.ports.mindProfiles) => {
        const map = new Map<string, unknown>();
        const list: { id: string; versions: number[] }[] = [];
        for (const s of await store.list()) {
          const versions: number[] = [];
          for (let v = 1; v <= s.latestVersion; v++) {
            const d = await store.get(s.id, v);
            if (d?.document !== undefined && d.document !== null) {
              map.set(`${s.id}@${v}`, d.document);
              versions.push(v);
            }
          }
          list.push({ id: s.id, versions });
        }
        return { map, list };
      };
      try {
        const [p, t] = await Promise.all([read(storage.ports.mindProfiles), read(storage.ports.promptTemplates)]);
        if (live) setDocs({ profiles: p.map as Map<string, MindProfileDocument>, templates: t.map as Map<string, PromptTemplateDocument>, profileList: p.list, templateList: t.list, loaded: true });
      } catch {
        if (live) setDocs((d) => ({ ...d, loaded: true }));
      }
    })();
    return () => {
      live = false;
    };
  }, [ready, storage, revision]);
  return useMemo<MindLibraryView>(() => {
    const byId = new Map(entries.map((e) => [e.id, e]));
    return {
      library: {
        profile: (id, v) => docs.profiles.get(`${id}@${v}`),
        // The built-in default template is always there; a template of the library with the same name and version would win.
        template: (id, v) => docs.templates.get(`${id}@${v}`) ?? (id === "default" && v === 1 ? DEFAULT_PROMPT_TEMPLATE : undefined),
      },
      providers: (id) => {
        const e = byId.get(id) ?? providerStore.get(id);
        return e === undefined ? undefined : { kind: e.kind, baseUrl: e.baseUrl };
      },
      profiles: docs.profileList,
      templates: docs.templateList,
      loaded: docs.loaded,
    };
  }, [docs, entries]);
}
