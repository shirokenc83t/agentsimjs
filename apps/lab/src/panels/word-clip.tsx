import type { CSSProperties } from "react";

/**
 * A line of text that is cut at a word when it does not fit: each word is an atomic inline box, so the ellipsis replaces whole words and never half of one (a word that is alone
 * and wider than the line is still cut). The full text is the tooltip.
 */
export function WordClip(props: { text: string; className?: string | undefined; style?: CSSProperties | undefined; testId?: string | undefined }) {
  const words = props.text.split(/\s+/).filter((w) => w !== "");
  return (
    <span className={`wordclip${props.className ? ` ${props.className}` : ""}`} style={props.style} title={props.text} data-testid={props.testId}>
      {words.map((w, i) => (
        <span key={i}>{w}</span>
      ))}
    </span>
  );
}
