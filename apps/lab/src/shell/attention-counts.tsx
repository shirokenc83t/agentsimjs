import { GLYPH } from "@agentsim/ui";

/**
 * The two attention counts, each in its own role colour: a failure count `alm`, a warning count `warn`. A count of zero is neutral (`fg3`): it says nothing needs attention at
 * that level, and must not borrow the colour of the worse level next to it ("✕0" in amber beside "▲1").
 */
export function AttentionCounts(props: { readonly alarm: number; readonly warning: number }) {
  return (
    <>
      <span className={props.alarm > 0 ? "danger" : "attn-zero"} data-testid="attention-count-alarm">
        {GLYPH.fail}
        {props.alarm}
      </span>{" "}
      <span className={props.warning > 0 ? "warn" : "attn-zero"} data-testid="attention-count-warning">
        {GLYPH.warn}
        {props.warning}
      </span>
    </>
  );
}
