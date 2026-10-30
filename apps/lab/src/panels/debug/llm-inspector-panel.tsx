import "../panels.css";
import { useUiContext } from "@agentsim/ui";
import type { TraceRecord } from "@agentsim/trace";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePolled, useServices, useSource } from "../../services.tsx";
import { buildDecisionStory, callFacts, callSays, callTokens, notebookAt, opOf, promptSections, type CallFacts, type DecisionStory, type Step } from "./decision-story.ts";
import { summary } from "./log-rows.ts";
import { useJump } from "./use-jump.ts";

// The LLM inspector (F4 M4, T-123, the designer's LLMInspector board): one decision of a System 2 mind as a lane, in the order things happened: the request, each model call with what it said, the compute
// calls it asked for, the final answer and the action it started; invalid answers, retries, the fallback and the limit records where they came. A model call opens below with the prompt by section (the size of each in
// tokens, characters / 4: an estimate), the answer, the notebook as the mind had it and the raw record. The record picked elsewhere (the Log, the Trace) is the one it is about.

const spaced = (n: number): string => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const TAGS: Record<Step["kind"], { tag: string; tone: string }> = {
  request: { tag: "REQ", tone: "slate" },
  call: { tag: "THK", tone: "violet" },
  tool: { tag: "CMP", tone: "amber" },
  answer: { tag: "ANS", tone: "green" },
  invalid: { tag: "INV", tone: "red" },
  fallback: { tag: "FBK", tone: "red" },
  limit: { tag: "LIM", tone: "amber" },
  cache: { tag: "CCH", tone: "slate" },
  action: { tag: "ACT", tone: "green" },
};
const payload = (r: TraceRecord): Record<string, unknown> => (r.payload !== null && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {});

/** The mark of a step that is not as it should be: a red ✕ for a call or an answer that failed, an amber ▲ for a degradation or a limit. Only the mark takes the colour; the text is the foreground. */
export function stepMark(s: Step): { readonly glyph: string; readonly tone: "alm" | "warn" } | undefined {
  const p = payload(s.record);
  if (s.kind === "invalid") return { glyph: "✕", tone: "alm" };
  if (s.kind === "call" && (p["outcome"] === "error" || p["outcome"] === "timeout" || p["outcome"] === "invalid")) return { glyph: "✕", tone: "alm" };
  if (s.kind === "fallback" || s.kind === "limit") return { glyph: "▲", tone: "warn" };
  return undefined;
}

/** What the lane writes for a step, after its tag and its mark; `callNo` is the number of a model call among the calls of the decision (unique: a retry has its own call number and says its attempt). */
export function stepText(s: Step, callNo = 1): string {
  const p = payload(s.record);
  switch (s.kind) {
    case "request": {
      const ev = Array.isArray(p["events"]) ? (p["events"] as { kind?: unknown }[]).map((e) => String(e.kind)).join(", ") : "";
      const nb = notebookAt(s.record);
      return `request · trigger: ${ev === "" ? "—" : ev}${nb === "" ? "" : ` · notebook ${nb.length} chars`}`;
    }
    case "call": {
      const t = callTokens(s.record);
      const says = callSays(s.record);
      const failed = stepMark(s) !== undefined;
      const head = `model call ${callNo} · attempt ${String(p["attempt"] ?? 1)} · ${t === undefined ? "" : `${spaced(t.input)} → ${spaced(t.output)} tok`}`;
      return failed ? `${head}${says === "" ? "" : ` · ${says}`}` : `${head}${says === "" ? "" : ` — “${says}”`}`;
    }
    case "invalid":
      return `invalid · ${String(p["validationError"] ?? "")}`;
    case "answer": {
      const d = p["decision"] as { kind?: unknown; name?: unknown; params?: unknown } | undefined;
      const mind = p["mind"] as { fallback?: unknown } | undefined;
      const what = d?.kind === "action" ? `${String(d.name)} ${JSON.stringify(d.params ?? {})}` : "idle";
      return `${mind?.fallback === undefined ? "answer" : "fallback decision"} · ${what}`;
    }
    case "fallback":
      return `fallback · ${String(p["decision"] ?? "idle")} · ${String(p["reason"] ?? "").slice(0, 120)}`;
    default:
      return summary(s.record);
  }
}

/** A text with `code` in backticks drawn as code (Mono on the raised background) instead of raw backticks. */
function Ticks({ text }: { text: string }): ReactNode {
  return text.split("`").map((t, i) => (i % 2 === 1 ? <code key={i} className="inline-code">{t}</code> : t));
}

function Tabs(props: { value: string; onChange: (v: string) => void; items: readonly string[] }) {
  return (
    <div className="li-tabs" role="tablist">
      {props.items.map((t) => (
        <button key={t} type="button" role="tab" aria-selected={props.value === t} className={`kt${props.value === t ? " on" : ""}`} onClick={() => props.onChange(t)} data-testid={`llm-tab-${t}`}>
          {t}
        </button>
      ))}
    </div>
  );
}

export function LlmInspectorPanel() {
  const source = useSource();
  const { storage } = useServices();
  const snap = usePolled(useCallback(() => source.snapshot(), [source]), 200);
  const jump = useJump(snap);
  const picked = useUiContext((s) => s.selectedRecord);
  const runId = snap.runId;
  const head = snap.persistedHeadTick ?? 0;
  const seq = picked !== undefined && picked.runId === runId ? picked.seq : undefined;
  const [story, setStory] = useState<DecisionStory | undefined | null>(null);
  const [sel, setSel] = useState<number | undefined>(undefined);
  const [tab, setTab] = useState<"prompt" | "answer" | "notebook" | "raw JSON">("prompt");
  const [section, setSection] = useState(0);

  useEffect(() => {
    if (runId === undefined || seq === undefined) return setStory(null);
    let live = true;
    void buildDecisionStory(storage.ports, runId, seq).then((s) => live && setStory(s));
    return () => {
      live = false;
    };
  }, [storage, runId, seq, head]);
  // A decision picked: its first model call is the one shown, unless the picked record is itself a step of it.
  useEffect(() => {
    if (story === null || story === undefined) return setSel(undefined);
    const steps = story.steps.map((s) => s.record.seq);
    setSel((cur) => (seq !== undefined && steps.includes(seq) && opOf(story.steps.find((s) => s.record.seq === seq)?.record as TraceRecord) !== "request" ? seq : cur !== undefined && steps.includes(cur) ? cur : story.calls[0]?.record.seq));
    setSection(0);
  }, [story, seq]);

  const pickRecord = (r: TraceRecord) => {
    if (runId === undefined) return;
    useUiContext.getState().selectRecord({ runId, seq: r.seq });
    jump(r.simTime, r.agentId);
  };

  const selected = story?.steps.find((s) => s.record.seq === sel);
  const call = selected !== undefined && selected.kind === "call" ? selected.record : undefined;
  const [facts, setFacts] = useState<CallFacts | undefined>(undefined);
  useEffect(() => {
    if (call === undefined || runId === undefined) return setFacts(undefined);
    let live = true;
    void callFacts(storage.ports, runId, call).then((f) => live && setFacts(f));
    return () => {
      live = false;
    };
  }, [storage, runId, call]);
  const sections = useMemo(() => (call === undefined ? [] : promptSections(payload(call)["messages"])), [call]);
  const totals = useMemo(() => {
    if (!story) return undefined;
    let input = 0;
    let output = 0;
    let latency = 0;
    let cost = 0;
    let priced = false;
    for (const c of story.calls) {
      const t = callTokens(c.record);
      input += t?.input ?? 0;
      output += t?.output ?? 0;
      latency += typeof payload(c.record)["latencyMs"] === "number" ? (payload(c.record)["latencyMs"] as number) : 0;
      if (typeof payload(c.record)["costUsd"] === "number") {
        priced = true;
        cost += payload(c.record)["costUsd"] as number;
      }
    }
    return { input, output, latency, cost, priced, tools: story.calls.reduce((n, c) => n + c.tools.length, 0) };
  }, [story]);

  if (seq === undefined) {
    return (
      <div className="panel llm-inspector" data-testid="llm-inspector">
        <p className="muted tt-empty" data-testid="llm-empty">
          No record selected · pick a decision, a model call or a compute call of a System 2 mind in the Log to see how it was reached.
        </p>
      </div>
    );
  }
  if (story === null) return <div className="panel llm-inspector muted tt-empty">Reading…</div>;
  if (story === undefined) {
    return (
      <div className="panel llm-inspector" data-testid="llm-inspector">
        <p className="muted tt-empty" data-testid="llm-not-a-mind">
          Record #{seq} is not part of a decision of a language-model mind (it has no request with model calls): pick a model call, a compute call or the decision of an LLM mind.
        </p>
      </div>
    );
  }
  const at = story.decision === undefined ? -1 : story.decisions.indexOf(story.decision.seq);
  const prev = at > 0 ? story.decisions[at - 1] : undefined;
  const next = at >= 0 && at < story.decisions.length - 1 ? story.decisions[at + 1] : undefined;
  const first = story.calls[0]?.record;
  const model = first === undefined ? "" : `${String(payload(first)["model"] ?? "")}${payload(first)["providerKind"] === undefined ? "" : ` · ${String(payload(first)["providerKind"])}`}`;
  const decisionP = story.decision === undefined ? {} : payload(story.decision);
  const d = decisionP["decision"] as { kind?: unknown; name?: unknown; params?: unknown } | undefined;
  const cacheHits = story.calls.filter((c) => payload(c.record)["cacheHit"] === true).length;
  const open = (seqNo: number | undefined) => seqNo !== undefined && runId !== undefined && useUiContext.getState().selectRecord({ runId, seq: seqNo });

  return (
    <div className="panel llm-inspector" data-testid="llm-inspector">
      <div className="llm-head">
        <b data-testid="llm-title">decision {at >= 0 ? `#${at + 1}` : "(open)"}</b> <span className="muted mono">· {story.agentId} · {story.request.simTime.toFixed(1)} s</span>
        <span className="sp" />
        <button type="button" className="kt" disabled={prev === undefined} onClick={() => open(prev)} aria-label="The previous decision of this agent" data-testid="llm-prev">
          ◂ #{at}
        </button>
        <button type="button" className="kt" disabled={next === undefined} onClick={() => open(next)} aria-label="The next decision of this agent" data-testid="llm-next">
          #{at + 2} ▸
        </button>
      </div>
      <div className="llm-tiles mono" data-testid="llm-tiles">
        <span>{model === "" ? "—" : model}</span>
        <span>
          {story.calls.length} model call{story.calls.length === 1 ? "" : "s"} · {totals?.tools ?? 0} tool call{totals?.tools === 1 ? "" : "s"}
        </span>
        <span>
          {spaced((totals?.input ?? 0) + (totals?.output ?? 0))} tok (in {spaced(totals?.input ?? 0)} · out {spaced(totals?.output ?? 0)})
        </span>
        <span>{((totals?.latency ?? 0) / 1000).toFixed(1)} s</span>
        <span>{totals?.priced ? `cost ${totals.cost.toFixed(4)} USD` : "cost — (no prices)"}</span>
        <span>{cacheHits === story.calls.length && story.calls.length > 0 ? "from the cache" : cacheHits > 0 ? `${cacheHits} from the cache` : "live"}</span>
      </div>
      {d !== undefined && (
        <div className="llm-action mono" data-testid="llm-action">
          {story.fallback !== undefined ? "▲" : "✓"} {d.kind === "action" ? `${String(d.name)} ${JSON.stringify(d.params ?? {})}` : "idle"}
          {story.action !== undefined ? ` · action started #${story.action.seq}` : ""}
        </div>
      )}
      <ol className="llm-lane mono" data-testid="llm-lane">
        {story.steps.map((s) => {
          const t = TAGS[s.kind];
          const p = payload(s.record);
          const mark = stepMark(s);
          const callNo = s.kind === "call" ? story.calls.findIndex((c) => c.record.seq === s.record.seq) + 1 : 0;
          const ms = typeof p["latencyMs"] === "number" ? `+${((p["latencyMs"] as number) / 1000).toFixed(1)} s` : "";
          return (
            <li key={`${s.kind}-${s.record.seq}`} className={s.record.seq === sel ? "sel" : undefined} data-kind={s.kind} data-seq={s.record.seq}>
              <button type="button" onClick={() => (setSel(s.record.seq), s.kind === "tool" || s.kind === "answer" || s.kind === "action" ? pickRecord(s.record) : undefined)} data-testid={`llm-step-${s.record.seq}`}>
                <span className="tag" style={{ color: `var(--kind-${t.tone})` }}>
                  {t.tag}
                </span>{" "}
                {mark !== undefined && <span className={`llm-mark ${mark.tone}`}>{mark.glyph} </span>}
                <span className="llm-step-text">{stepText(s, callNo)}</span>
                <span className="muted llm-ms">{ms}</span>
              </button>
            </li>
          );
        })}
      </ol>
      {call !== undefined && (
        <div className="llm-detail" data-testid="llm-detail">
          <Tabs value={tab} onChange={(v) => setTab(v as typeof tab)} items={["prompt", "answer", "notebook", "raw JSON"]} />
          {facts !== undefined && (tab === "prompt" || tab === "answer") && (
            <dl className="llm-facts mono" data-testid="llm-facts">
              <dt>parameters</dt>
              <dd>
                {facts.params} · format: function tools, JSON in the answer
              </dd>
              <dt>limits after this call</dt>
              <dd>
                calls {facts.calls.used} / {facts.calls.max} · tokens {spaced(facts.tokens.used)} / {spaced(facts.tokens.max)}
              </dd>
              <dt>output</dt>
              <dd>
                {spaced(callTokens(call)?.output ?? 0)} tok · {((Number(payload(call)["latencyMs"]) || 0) / 1000).toFixed(1)} s · finish: {facts.finish}
              </dd>
            </dl>
          )}
          {tab === "prompt" && typeof payload(call)["messages"] === "string" && (
            <p className="muted" data-testid="llm-metadata-note">
              <Ticks text="This run kept `mind-io` at `metadata`: the prompt of this call is only its hash (" />
              {String(payload(call)["messages"])}
              <Ticks text={`), with its size (${spaced(callTokens(call)?.input ?? 0)} tok in). At \`full\` the sections would be here to read.`} />
            </p>
          )}
          {tab === "prompt" && typeof payload(call)["messages"] !== "string" && (
            <div className="llm-prompt">
              <p className="muted">
                model call {story.calls.findIndex((c) => c.record.seq === call.seq) + 1} · attempt {String(payload(call)["attempt"] ?? 1)} · input {spaced(callTokens(call)?.input ?? sections.reduce((n, x) => n + x.tokens, 0))} tok by section (characters / 4, an estimate) · click a section to read it
              </p>
              <div className="llm-sections">
                {sections.map((s, i) => (
                  <button key={`${s.title}-${i}`} type="button" className={i === section ? "on" : undefined} onClick={() => setSection(i)} data-testid={`llm-section-${i}`}>
                    <span>{s.title}</span>
                    <span className="muted"> {spaced(s.tokens)} tok</span>
                  </button>
                ))}
              </div>
              <pre className="llm-text" data-testid="llm-section-text">
                {sections[section]?.text ?? ""}
              </pre>
            </div>
          )}
          {tab === "answer" && (
            <div className="llm-answer">
              {typeof payload(call)["response"] === "string" ? (
                <p className="muted" data-testid="llm-answer-text">
                  <Ticks text="`mind-io` was kept at `metadata`: the answer is only its hash (" />
                  {String(payload(call)["response"])}
                  <Ticks text="); at `full` it would be here." />
                </p>
              ) : (
                <pre className="llm-text" data-testid="llm-answer-text">
                  {JSON.stringify(payload(call)["response"] ?? null, null, 2)}
                </pre>
              )}
              {typeof payload(call)["validationError"] === "string" && <p className="st-warn">✕ invalid · {String(payload(call)["validationError"])}</p>}
              <p className="muted mono">
                output {spaced(callTokens(call)?.output ?? 0)} tok · {((Number(payload(call)["latencyMs"]) || 0) / 1000).toFixed(1)} s · outcome {String(payload(call)["outcome"] ?? "")} · attempt {String(payload(call)["attempt"] ?? 1)}
              </p>
            </div>
          )}
          {tab === "notebook" && (
            <pre className="llm-text" data-testid="llm-notebook">
              {typeof payload(story.request)["self"] === "string" ? "(kept as a hash at `mind-io` metadata; `full` would show the notebook)" : notebookAt(story.request) === "" ? "(empty)" : notebookAt(story.request)}
            </pre>
          )}
          {tab === "raw JSON" && (
            <pre className="llm-text" data-testid="llm-raw">
              {JSON.stringify(call, null, 2)}
            </pre>
          )}
        </div>
      )}
      {selected !== undefined && selected.kind !== "call" && (
        <div className="llm-detail" data-testid="llm-detail-other">
          <pre className="llm-text">{JSON.stringify(selected.record.payload, null, 2)}</pre>
        </div>
      )}
      {story.other.length > 0 && <p className="muted mono">{story.other.map((r) => summary(r)).join(" · ")}</p>}
      <p className="muted rc-note">
        {payload(story.request)["allowed"] === undefined ? "" : <Ticks text="mind-io at `metadata` keeps the sizes, the outcome and the hashes of what was sent and answered; at `full` it also keeps the prompt and the answer, which this panel then shows." />}
      </p>
    </div>
  );
}
