import type { DecisionRequest } from "@agentsim/core";
import { canonicalJson } from "./canonical.ts";
import type { PromptTemplateDocument, Slot } from "./documents.ts";
import type { ChatMessage } from "./provider.ts";

// The prompt of a decision (ADR-0036 section 5 and its F4 addition): the template's system text, then the template's sections in its order, each filled by this trusted code from the request, the
// mission, the notebook and the last decisions. Deterministic: the same request, template, mission and history give the same bytes (structured parts are canonical JSON, keys sorted). Nothing here reads
// anything but the `DecisionRequest` an S1 mind gets too: what a model sees is what any mind sees, plus its own notes and its own history.

/** One decision the mind made, kept for the `decisions` slot (compact: the action it chose and why, never the whole request). */
export interface DecisionNote {
  readonly tick: number;
  readonly simTimeS: number;
  /** `goTo {"xM":50,"yM":20}` or `idle`. */
  readonly chose: string;
  readonly rationale?: string;
  /** True when the mind fell back (an invalid or missing answer). */
  readonly fallback?: boolean;
}

export interface PromptInput {
  readonly template: PromptTemplateDocument;
  readonly mission: string | undefined;
  readonly request: DecisionRequest;
  /** The last N decisions of this mind, oldest first. */
  readonly history: readonly DecisionNote[];
  /** The actions the profile's tool list leaves out of the offer (names), if it restricts them. */
  readonly offered?: readonly string[];
}

const json = (v: unknown): string => canonicalJson(v);

/** The text of one slot (without its instruction). */
function slotText(slot: Slot, i: PromptInput): string {
  const r = i.request;
  switch (slot) {
    case "role":
      return `You are the mind of ${r.self.kind === "uav" ? "an aerial vehicle (UAV)" : "a ground vehicle (UGV)"} named ${r.agentId}. It is simulated time ${r.simTimeS} s (tick ${r.tick}).`;
    case "mission":
      return i.mission === undefined || i.mission.trim() === "" ? "You have no mission: use your judgement and the events." : i.mission.trim();
    case "notebook":
      return r.self.notebook === undefined || r.self.notebook === "" ? "(empty)" : r.self.notebook;
    case "decisions":
      return i.history.length === 0
        ? "(none yet)"
        : i.history.map((d) => `- t=${d.simTimeS} s: ${d.chose}${d.fallback === true ? " (fallback)" : ""}${d.rationale === undefined ? "" : ` — ${d.rationale}`}`).join("\n");
    case "self":
      return json(r.self);
    case "beliefs":
      return json(r.beliefs);
    case "space":
      return json(r.space);
    case "events":
      return r.events.length === 0 ? "(none)" : `${json(r.events)}${r.eventsDropped > 0 ? `\n(${r.eventsDropped} perception events were dropped before this request)` : ""}`;
    case "actions": {
      const offer = i.offered === undefined ? r.allowedActions : r.allowedActions.filter((a) => i.offered?.includes(a.name));
      const allowed = offer.map((a) => `- ${a.name}: parameters ${json(a.paramsSchema)}`).join("\n");
      const unavailable = r.unavailable.length === 0 ? "" : `\nNot available now: ${r.unavailable.map((u) => `${u.name} (${u.code})`).join(", ")}.`;
      return `Answer with one JSON object: {"action": <name or "idle">, "params": {...}, "timers"?: [...], "note"?: {"text": ..., "mode": "replace"|"append"}, "rationale"?: <short reason>}.\nAllowed actions:\n${allowed.length === 0 ? "(none)" : allowed}\n- idle: wait for the next event.${unavailable}`;
    }
  }
}

const HEADINGS: Readonly<Record<Slot, string>> = {
  role: "Who you are",
  mission: "Your mission",
  notebook: "Your notebook",
  decisions: "Your last decisions",
  self: "Your state",
  beliefs: "What you believe",
  space: "The space around you",
  events: "What just happened",
  actions: "What you can do",
};

/** The messages of a decision's first attempt: the system text and one user message with the template's sections in order. */
export function buildPrompt(i: PromptInput): ChatMessage[] {
  const blocks = i.template.sections.map((slot) => {
    const instruction = i.template.instructions?.[slot];
    return `## ${HEADINGS[slot as Slot]}\n${instruction === undefined ? "" : `${instruction}\n`}${slotText(slot as Slot, i)}`;
  });
  return [
    { role: "system", content: i.template.system },
    { role: "user", content: blocks.join("\n\n") },
  ];
}

/** The messages of a retry: what was asked, the answer that was not accepted, and why. */
export function retryMessages(first: readonly ChatMessage[], answer: string | undefined, why: string): ChatMessage[] {
  return [
    ...first,
    ...(answer === undefined ? [] : [{ role: "assistant" as const, content: answer }]),
    { role: "user", content: `${answer === undefined ? "There was no usable answer" : "Your answer was not accepted"}: ${why}\nAnswer again with one JSON object as described.` },
  ];
}
