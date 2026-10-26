import { useUiContext } from "@agentsim/ui";
import { useEffect, useState } from "react";
import { missionLine, missionViews } from "../panels/mission-view.ts";
import { useSource } from "../services.tsx";

/** The mission of the selected agent (else of the first that has one), in words, under the clock: `uav-001 mission 3 / 5 · explore`. Nothing when no agent has a mission. */
export function MissionNote() {
  const source = useSource();
  const selection = useUiContext((s) => s.selection);
  const [text, setText] = useState("");
  useEffect(() => {
    const read = () => {
      const all = missionViews(source.records());
      const id = (selection?.kind === "agent" && all.has(selection.id) ? selection.id : undefined) ?? [...all.keys()][0];
      setText(id === undefined ? "" : missionLine(all.get(id), id));
    };
    read();
    return source.onRecords(read);
  }, [source, selection]);
  return text === "" ? null : (
    <span className="mission-note mono muted" data-testid="player-mission" title={text}>
      {text}
    </span>
  );
}
