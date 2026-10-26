import { KIND_STYLE } from "@agentsim/ui";
import { flagRole, isFailure } from "../panels/debug/marks.ts";
import { useRunMarks } from "../panels/debug/use-run-marks.ts";

/** The kinds the player flags on its track (what a reader looks for when scrubbing): reflexes, injected commands and degradations. */
const FLAGGED = new Set(["reflex", "injected", "degradation"]);

/**
 * Flag markers of a stored run on the player's scrub track, by kind (colour from the kind's family, with the kind in the accessible name). Loaded only for a
 * run that is stored: the marks are read from storage in the background, up to the persisted head.
 */
const role = (m: Parameters<typeof flagRole>[0]): string | undefined => (flagRole(m) === "alarm" ? "var(--alm)" : m.kind === "reflex" ? "var(--warn)" : undefined);

export function PlayerMarks(props: { runId: string; headS: number; scaleS: number }) {
  const marks = useRunMarks(props.runId, props.headS);
  // Reflexes and failures are the marks of the swarm knowledge band's axis (ADR-0043 section 7): a reflex in the warning colour, a failure in the alarm colour; the other flags keep their kind's hue.
  const flagged = marks.filter((m) => FLAGGED.has(m.kind) || isFailure(m));
  return (
    <>
      {flagged.map((m) => (
        <i
          key={m.seq}
          className="tick"
          data-testid="player-flag"
          data-kind={m.kind}
          data-flag={isFailure(m) ? "failure" : undefined}
          title={`${isFailure(m) ? "failure" : m.kind}${m.agentId ? ` · ${m.agentId}` : ""} · ${m.t.toFixed(1)} s`}
          style={{ left: `${Math.min(100, (m.t / props.scaleS) * 100)}%`, background: role(m) ?? `var(--kind-${KIND_STYLE[m.kind as keyof typeof KIND_STYLE]?.family ?? "slate"})` }}
        />
      ))}
    </>
  );
}
