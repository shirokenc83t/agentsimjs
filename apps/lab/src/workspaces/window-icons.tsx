import type { ReactNode } from "react";

/**
 * The icons of the window buttons (ADR-0042 §7): small strokes drawn here, so no font glyph stands in for one (a ✓ is the "ok" state, a × reads as close
 * wherever it is). They take the colour of the button.
 */
function Icon(props: { children: ReactNode }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" aria-hidden="true">
      {props.children}
    </svg>
  );
}

export const CollapseIcon = () => (
  <Icon>
    <path d="M3 11.5h10" />
  </Icon>
);
export const ExpandIcon = () => (
  <Icon>
    <path d="M3.5 10.5 8 6l4.5 4.5" />
  </Icon>
);
export const FloatIcon = () => (
  <Icon>
    <path d="M4 12 12 4M6.5 4H12v5.5" />
  </Icon>
);
export const DockIcon = () => (
  <Icon>
    <path d="M4 4l8 8M9.5 12H12V9.5" />
    <path d="M3 13h10" />
  </Icon>
);
export const MaximizeIcon = () => (
  <Icon>
    <path d="M3.5 3.5h9v9h-9z" />
  </Icon>
);
export const RestoreIcon = () => (
  <Icon>
    <path d="M5.5 5.5h7v7h-7zM3.5 10.5v-7h7" />
  </Icon>
);
export const CloseIcon = () => (
  <Icon>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Icon>
);
