import { useUiContext } from "@agentsim/ui";
import { useCallback, useEffect, useState } from "react";
import { usePolled, useServices, useSource } from "../../services.tsx";
import { buildDecisionStory, promptSections } from "../debug/decision-story.ts";

// The `task` slot as it was rendered at the decision picked in the Log (F4b M2, the designer's WakeTaskSlot board): a fold under the template editor, in Mono on the sunken background, with the slot's size in tokens
// (characters / 4, an estimate). It reads the prompt the mind was sent (`mind-io: full`); with no list yet it says the slot is empty until the mind writes one.

const HEADING = "Your task list";

/** The `task` slot of a decision's prompt, as it was rendered, and the number of the decision among its agent's. */
export function TaskSlotFold() {
  const source = useSource();
  const { storage } = useServices();
  const snap = usePolled(useCallback(() => source.snapshot(), [source]), 400);
  const picked = useUiContext((s) => s.selectedRecord);
  const runId = snap.runId;
  const seq = picked !== undefined && picked.runId === runId ? picked.seq : undefined;
  const [shown, setShown] = useState<{ readonly no: number | undefined; readonly text: string | undefined; readonly tokens: number; readonly why: string } | undefined>(undefined);

  useEffect(() => {
    if (runId === undefined || seq === undefined) return setShown(undefined);
    let live = true;
    void buildDecisionStory(storage.ports, runId, seq).then((story) => {
      if (!live) return;
      if (story === undefined) return setShown({ no: undefined, text: undefined, tokens: 0, why: "the record picked in the Log is not part of a decision of a language-model mind" });
      const at = story.decision === undefined ? -1 : story.decisions.indexOf(story.decision.seq);
      const messages = (story.calls[0]?.record.payload as { messages?: unknown } | undefined)?.messages;
      if (typeof messages === "string") return setShown({ no: at >= 0 ? at + 1 : undefined, text: undefined, tokens: 0, why: "this run kept mind-io at metadata: the prompt is only a hash" });
      const section = promptSections(messages).find((s) => s.title === HEADING);
      setShown({ no: at >= 0 ? at + 1 : undefined, text: section?.text, tokens: section?.tokens ?? 0, why: "this decision's prompt has no task slot (its template does not place it)" });
    });
    return () => {
      live = false;
    };
  }, [storage, runId, seq]);

  const empty = shown?.text !== undefined && (shown.text.startsWith("(no list yet") || shown.text === "(none)");
  return (
    <details className="lib-task-fold" data-testid="lib-task-fold">
      <summary className="mono">
        ‹task› as rendered at {shown?.no === undefined ? "the decision picked in the Log" : `decision #${shown.no}`}
        {shown?.text !== undefined ? ` · ${shown.tokens} tok` : ""}
      </summary>
      {shown === undefined ? (
        <p className="muted">Pick a decision of a language-model mind in the Log to see the slot as it was rendered there.</p>
      ) : shown.text === undefined ? (
        <p className="muted" data-testid="lib-task-fold-why">{shown.why}</p>
      ) : (
        <>
          <pre className="mono lib-task-text" data-testid="lib-task-text">{shown.text}</pre>
          {empty && <p className="muted">empty until the mind writes a list</p>}
        </>
      )}
    </details>
  );
}
