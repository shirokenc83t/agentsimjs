import type { ResolvedRunConfig, RunConfigDocument } from "@agentsim/scenarios";
import { allowedBy, usePagePolicy } from "../../config/page-policy.ts";
import { providerStore } from "../../config/providers.ts";
import type { Validation } from "./model.ts";
import type { MissionAgent } from "./mission-section.tsx";
import {
  estimate,
  estimateWords,
  MISSION_MAX_CHARS,
  RUN_MODES,
  runModeOf,
  s2Of,
  withRunMode,
  withS2,
  type MindsRunMode,
} from "./minds-model.ts";
import type { MindLibraryView } from "./use-mind-library.ts";

// The `minds` table of the run configuration (F4 M4, T-125, the designer's LibraryMinds board): per agent a script mission (the Mission section) or a language-model mind: a profile of the Library (a version),
// overrides of the limits, the mission in plain words (part of the run configuration and its hash), the provider of Settings, the effective configuration as the run will have it, an estimate of its calls and
// tokens against the limits, and the run mode of the minds. A row says what is wrong with it on the row: a profile or a provider that does not exist, an address the page may not call.

type Resolved = ResolvedRunConfig["agents"][number];
const spaced = (n: number): string =>
  Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/** What the validation says about the row of this agent, when it is about it. */
function rowError(v: Validation, key: string): string | undefined {
  if (v.ok) return undefined;
  const p = v.error.path ?? "";
  return p.includes(`/byAgent/${key}/`) || p.endsWith(`/byAgent/${key}`)
    ? `${v.error.code}: ${v.error.message}`
    : undefined;
}

export function MindsSection(props: {
  draft: RunConfigDocument;
  onChange: (d: RunConfigDocument) => void;
  agents: readonly MissionAgent[];
  validation: Validation;
  library: MindLibraryView;
}) {
  const { draft, onChange, agents, validation, library } = props;
  const policy = usePagePolicy();
  const resolved: readonly Resolved[] = validation.ok ? validation.resolved.agents : [];
  const anyS2 = agents.some((a) => s2Of(draft, a.key) !== undefined);
  const mode = runModeOf(draft);
  const first = library.profiles[0];
  const rowFailed = agents.some((a) => rowError(validation, a.key) !== undefined);
  const failed = !validation.ok && (rowFailed || (validation.error.path ?? "").startsWith("/minds"));
  const sectionError =
    !validation.ok &&
    (validation.error.path ?? "").startsWith("/minds") &&
    !agents.some((a) => rowError(validation, a.key) !== undefined)
      ? `${validation.error.code}: ${validation.error.message}`
      : undefined;

  return (
    <section className="fs" data-testid="rc-minds" data-section="minds">
      <h4 className="sec">
        <b>7 · Minds</b>
        <span className="rule" />
        <span data-testid="rc-status-minds" className={`st ${failed ? "st-alm" : "st-ok"}`}>
          {failed ? "✕" : "✓"}
        </span>
      </h4>
      <p className="muted rc-note">
        Each agent has a script mission (the Mission section) or a language-model mind: a profile of the
        Library, with the mission in plain words. Providers come from Settings; a profile is a version, so a
        re-run is the same mind.
      </p>
      <table className="rc-minds mono" data-testid="rc-minds-table">
        <thead>
          <tr>
            <th>agent</th>
            <th>mind</th>
            <th>profile</th>
            <th>overrides</th>
            <th>provider</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => {
            const entry = s2Of(draft, a.key);
            const r = resolved.find((x) => x.agentId === a.id);
            const err = rowError(validation, a.key);
            const provider =
              r?.s2 === undefined ? (entry === undefined ? undefined : undefined) : r.s2.provider.id;
            const base = provider === undefined ? undefined : providerStore.get(provider)?.baseUrl;
            const blocked = base !== undefined && allowedBy(policy, base) === false;
            const profile = entry !== undefined && "id" in entry.profile ? entry.profile : undefined;
            const tokensOverride = entry?.overrides?.limits?.tokens;
            const callsOverride = entry?.overrides?.limits?.calls;
            const setOverride = (field: "tokens" | "calls", v: string) => {
              if (entry === undefined) return;
              const n = v.trim() === "" ? undefined : Number(v);
              const limits = { ...entry.overrides?.limits, [field]: n };
              if (n === undefined) delete (limits as Record<string, unknown>)[field];
              const overrides = {
                ...entry.overrides,
                ...(Object.keys(limits).length === 0 ? {} : { limits }),
              } as NonNullable<typeof entry.overrides>;
              if (Object.keys(limits).length === 0) delete (overrides as { limits?: unknown }).limits;
              onChange(
                withS2(draft, a.key, {
                  ...entry,
                  ...(Object.keys(overrides).length === 0 ? { overrides: undefined } : { overrides }),
                } as never),
              );
            };
            return (
              <tr
                key={a.key}
                data-testid={`rc-minds-row-${a.key}`}
                data-state={err !== undefined ? "error" : blocked ? "warn" : "ok"}
              >
                <td>
                  {a.id} <span className="muted">{a.key}</span>
                </td>
                <td>
                  <span className="rc-input">
                    <select
                      aria-label={`Mind of ${a.key}`}
                      value={entry === undefined ? "script" : "s2"}
                      onChange={(e) =>
                        onChange(
                          e.target.value === "s2"
                            ? withS2(draft, a.key, {
                                profile: {
                                  id: first?.id ?? "scout-llm",
                                  version: first?.versions[first.versions.length - 1] ?? 1,
                                },
                                mission: "",
                              } as never)
                            : withS2(draft, a.key, undefined),
                        )
                      }
                      data-testid={`rc-minds-kind-${a.key}`}
                    >
                      <option value="script">script / none</option>
                      <option value="s2" disabled={library.profiles.length === 0 && entry === undefined}>
                        s2 · language model
                      </option>
                    </select>
                  </span>
                </td>
                <td>
                  {entry === undefined ? (
                    <span className="muted">—</span>
                  ) : profile === undefined ? (
                    <span className="muted">inline profile</span>
                  ) : (
                    <span className="rc-input">
                      <select
                        aria-label={`Profile of ${a.key}`}
                        value={`${profile.id}@${profile.version}`}
                        onChange={(e) => {
                          const [id, v] = e.target.value.split("@");
                          onChange(
                            withS2(draft, a.key, {
                              ...entry,
                              profile: { id: id as string, version: Number(v) },
                            } as never),
                          );
                        }}
                        data-testid={`rc-minds-profile-${a.key}`}
                      >
                        {[
                          ...new Set([
                            `${profile.id}@${profile.version}`,
                            ...library.profiles.flatMap((p) => p.versions.map((v) => `${p.id}@${v}`)),
                          ]),
                        ].map((o) => (
                          <option key={o} value={o}>
                            {o.replace("@", " v")}
                          </option>
                        ))}
                      </select>
                    </span>
                  )}
                </td>
                <td>
                  {entry === undefined ? (
                    <span className="muted">—</span>
                  ) : (
                    <span className="rc-overrides">
                      <label>
                        tokens{" "}
                        <input
                          className="mono"
                          inputMode="numeric"
                          value={tokensOverride ?? ""}
                          placeholder={r?.s2 === undefined ? "profile" : String(r.s2.effective.limits.tokens)}
                          onChange={(e) => setOverride("tokens", e.target.value)}
                          data-testid={`rc-minds-tokens-${a.key}`}
                        />
                      </label>{" "}
                      <label>
                        calls{" "}
                        <input
                          className="mono"
                          inputMode="numeric"
                          value={callsOverride ?? ""}
                          placeholder={r?.s2 === undefined ? "profile" : String(r.s2.effective.limits.calls)}
                          onChange={(e) => setOverride("calls", e.target.value)}
                          data-testid={`rc-minds-calls-${a.key}`}
                        />
                      </label>
                    </span>
                  )}
                </td>
                <td data-testid={`rc-minds-provider-${a.key}`}>
                  {entry === undefined ? (
                    <span className="muted">—</span>
                  ) : r?.s2 === undefined ? (
                    <span className="muted">—</span>
                  ) : (
                    <span>{r.s2.provider.id}</span>
                  )}
                  {blocked && <span className="st-warn"> ▲ endpoint not allowed yet</span>}
                </td>
                {err !== undefined && (
                  <td className="st-alm" data-testid={`rc-minds-error-${a.key}`} colSpan={5}>
                    ✕ {err}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {sectionError !== undefined && (
        <p className="st-alm" data-testid="rc-minds-section-error">
          ✕ {sectionError}
        </p>
      )}
      {agents
        .filter((a) => s2Of(draft, a.key) !== undefined)
        .map((a) => {
          const entry = s2Of(draft, a.key);
          if (entry === undefined) return null;
          const r = resolved.find((x) => x.agentId === a.id);
          const mission = entry.mission ?? "";
          const s2 = r?.s2;
          const prices = s2 === undefined ? undefined : providerStore.get(s2.provider.id)?.prices;
          const est =
            s2 === undefined
              ? undefined
              : estimateWords(
                  estimate({ mission, effective: s2.effective, template: s2.template.content, prices }),
                );
          return (
            <div key={a.key} className="rc-s2" data-testid={`rc-minds-detail-${a.key}`}>
              <label className="rc-label" htmlFor={`rc-mission-${a.key}`}>
                {a.id} · mission in plain words{" "}
                <span className="muted">(part of the run configuration and its hash)</span>
              </label>
              <textarea
                id={`rc-mission-${a.key}`}
                className="mono rc-mission-text"
                rows={3}
                maxLength={MISSION_MAX_CHARS}
                value={mission}
                onChange={(e) =>
                  onChange(withS2(draft, a.key, { ...entry, mission: e.target.value } as never))
                }
                data-testid={`rc-minds-mission-${a.key}`}
              />
              <div className="muted mono rc-counter" data-testid={`rc-minds-count-${a.key}`}>
                {mission.length} / {MISSION_MAX_CHARS}
              </div>
              {s2 !== undefined && (
                <dl className="compute-kv mono" data-testid={`rc-minds-effective-${a.key}`}>
                  <dt>effective</dt>
                  <dd>
                    {s2.provider.id} ({s2.provider.host}) · {s2.effective.model} · template {s2.template.id} v
                    {s2.template.version}
                  </dd>
                  <dt>limits</dt>
                  <dd>
                    {spaced(s2.effective.limits.calls)} calls · {spaced(s2.effective.limits.tokens)} tok ·{" "}
                    {s2.effective.limits.costUsd} USD
                    {prices === undefined ? " (no prices: no cost limit)" : ""} ·{" "}
                    {s2.effective.limits.retries} {s2.effective.limits.retries === 1 ? "retry" : "retries"}
                  </dd>
                </dl>
              )}
              {est !== undefined && (
                <div className="rc-estimate" data-testid={`rc-minds-estimate-${a.key}`}>
                  <b>Estimate for this run · {a.key}</b> <span className="muted">(an estimate)</span>
                  <dl className="compute-kv mono">
                    <dt>calls</dt>
                    <dd data-testid={`rc-minds-est-calls-${a.key}`}>{est.calls}</dd>
                    <dt>tokens</dt>
                    <dd data-testid={`rc-minds-est-tokens-${a.key}`}>{est.tokens}</dd>
                    <dt>cost</dt>
                    <dd data-testid={`rc-minds-est-cost-${a.key}`}>{est.cost}</dd>
                  </dl>
                  <p className={est.overLimit ? "st-warn" : "muted"}>
                    {est.overLimit ? "▲ the upper end is over a limit: the run may pause. " : ""}
                    {est.basis}
                  </p>
                </div>
              )}
            </div>
          );
        })}
      {anyS2 && (
        <div
          className="rc-runmode"
          data-testid="rc-minds-runmode"
          role="radiogroup"
          aria-label="Run mode for minds"
        >
          <b>Run mode for minds</b>
          {RUN_MODES.map((m) => (
            <label key={m.mode} className="rc-mode">
              <input
                type="radio"
                name="minds-run-mode"
                checked={mode === m.mode}
                onChange={() => onChange(withRunMode(draft, m.mode as MindsRunMode))}
                data-testid={`rc-minds-mode-${m.mode}`}
              />{" "}
              {m.mode} <span className="muted">· {m.words}</span>
            </label>
          ))}
          <p className="muted">The time mode (lockstep · latency-modeled) is in the Run section.</p>
        </div>
      )}
    </section>
  );
}
