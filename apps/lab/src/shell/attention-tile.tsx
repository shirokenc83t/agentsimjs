import { AttentionCounts } from "./attention-counts.tsx";
import { useAppActions, useSource } from "../services.tsx";
import { useAttention } from "../panels/attention-store.ts";
import { useMinds } from "./minds-status.ts";

/**
 * The attention tile of the player (UI-SPEC section 4): how many agents are at each level, each in its own colour (a zero is neutral). A click takes the researcher to the
 * Explorer's attention group. Loaded lazily with the first run: the shell does not carry the attention rules.
 */
export function AttentionTile() {
  const source = useSource();
  const { openWorkspace } = useAppActions();
  const { counts } = useAttention(source);
  const worst = counts.alarm > 0 ? "alarm" : counts.warning > 0 ? "warning" : "none";
  // A run paused by a limit says so here too (the designer's LimitsPause): `▲ limit`, in the warning colour.
  const limitPaused = useMinds().status?.pausedAt !== undefined;
  const go = () => {
    openWorkspace("scene");
    // The Explorer is in the Scene workspace: its attention group takes the focus once it is there.
    setTimeout(() => document.querySelector<HTMLElement>('[data-testid="explorer-attention"] button')?.focus(), 150);
  };
  return (
    <button type="button" className="tile attn-tile" onClick={go} disabled={worst === "none" && !limitPaused} aria-label={`Attention: ${counts.alarm} alarms, ${counts.warning} warnings`} data-testid="attention-tile" data-level={worst}>
      <span className="lbl">Attention</span>
      <span className={`v mono${worst === "none" && !limitPaused ? " muted" : ""}`} data-testid={limitPaused ? "attention-limit" : undefined} style={limitPaused ? { color: "var(--warn)" } : undefined}>
        {limitPaused ? "▲ limit" : worst === "none" ? "none" : <AttentionCounts alarm={counts.alarm} warning={counts.warning} />}
      </span>
    </button>
  );
}
