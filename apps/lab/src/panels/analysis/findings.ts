import type { TraceRecord } from "@agentsim/trace";
import { knowledgeAt, knowledgeShown, type KnowledgeBand } from "../../shell/knowledge-band.ts";
import { reflexWords } from "../agent-views.ts";

// The findings line under the title of the Analysis workspace (ADR-0043, IdentityAnalysis): what the run came to, in two or three sentences, from data the run holds. A sentence for
// which the run holds nothing is left out; nothing is guessed.

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const payload = (r: TraceRecord) => (r.payload !== null && typeof r.payload === "object" ? (r.payload as { op?: unknown; status?: unknown; code?: unknown; failure?: { code?: unknown } }) : {});

/** The sentences: what the swarm knew at the end (observer data), the reflexes (the first, with its agent and time), and the failed actions. */
export function findingsOf(args: { readonly band: KnowledgeBand; readonly events: readonly TraceRecord[]; readonly endS: number }): string[] {
  const out: string[] = [];
  const known = knowledgeShown(args.band, args.endS);
  const agents = knowledgeAt(args.band, args.endS)?.agents ?? 0;
  if (known?.kind === "union") out.push(`At the end the swarm knows ${known.knownPct.toFixed(1)} % of the map, ${known.matchPct.toFixed(1)} % of it matching the truth (observer data, the union of what its ${plural(agents, "agent", "agents")} know).`);
  else if (known !== undefined) out.push(`At the end the swarm knows ${known.knownPct.toFixed(1)} % of what it can reach, ${known.matchPct.toFixed(1)} % matching the truth (observer data, mean of ${plural(agents, "agent", "agents")}).`);
  const reflexes = args.events.filter((r) => r.kind === "reflex").sort((a, b) => a.simTime - b.simTime);
  const first = reflexes[0];
  if (first !== undefined) {
    const code = payload(first).code;
    const what = typeof code === "string" ? reflexWords(code) : "a reflex";
    out.push(`${reflexes.length === 1 ? "One reflex" : `${reflexes.length} reflexes`}: ${first.agentId ?? "an agent"} ${what} at ${first.simTime.toFixed(1)} s${reflexes.length > 1 ? " (the first)" : ""}.`);
  }
  const failed = args.events.filter((r) => r.kind === "action" && payload(r).op === "end" && payload(r).status === "failed");
  if (failed.length > 0) out.push(`${plural(failed.length, "action", "actions")} failed.`);
  return out;
}
