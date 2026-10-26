import { KIND_STYLE } from "@agentsim/ui";
import { useRunMarks } from "../panels/debug/use-run-marks.ts";

/** The kinds the player flags on its track (what a reader looks for when scrubbing): reflexes, injected commands and degradations. */
const FLAGGED = new Set(["reflex", "injected", "degradation"]);

/**
 * Flag markers of a stored run on the player's scrub track, by kind (colour from the kind's family, with the kind in the accessible name). Loaded only for a
 * run that is stored: the marks are read from storage in the background, up to the persisted head.
 */
export function PlayerMarks(props: { runId: string; headS: number; scaleS: number }) {
  const marks = useRunMarks(props.runId, props.headS);
  const flagged = marks.filter((m) => FLAGGED.has(m.kind));
  return (
    <>
      {flagged.map((m) => (
        <i
          key={m.seq}
          className="tick"
          data-testid="player-flag"
          data-kind={m.kind}
          title={`${m.kind} · ${m.t.toFixed(1)} s`}
          style={{ left: `${Math.min(100, (m.t / props.scaleS) * 100)}%`, background: `var(--kind-${KIND_STYLE[m.kind as keyof typeof KIND_STYLE]?.family ?? "slate"})` }}
        />
      ))}
    </>
  );
}
