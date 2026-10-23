/**
 * Tooltips of compact controls (`data-tip`, ADR-0042 section 6) close on any key and any click, and stay closed until the pointer leaves the control or the focus moves
 * on. The stylesheet shows a tip on hover and on keyboard focus, which for a control that was just used keeps its tip over the result of what it did (a message under the
 * Run button, a row under the cursor): so a press or a key marks the control (`data-tip-off`) and the stylesheet draws no tip for a marked control.
 */
const OFF = "data-tip-off";

function tipOf(el: EventTarget | Element | null): HTMLElement | undefined {
  const near = el instanceof Element ? el.closest<HTMLElement>("[data-tip]") : null;
  return near ?? undefined;
}

/** Installs the listeners once; returns a function that removes them. */
export function initTooltips(doc: Document = document): () => void {
  const close = (el: HTMLElement | undefined) => el?.setAttribute(OFF, "");
  const reopen = (el: HTMLElement | undefined) => el?.removeAttribute(OFF);
  const onDown = (e: Event) => close(tipOf(e.target));
  const onKey = () => {
    // The control with the focus and the one under the pointer: either may be showing its tip.
    close(tipOf(doc.activeElement));
    doc.querySelectorAll<HTMLElement>("[data-tip]:hover").forEach((el) => close(el));
  };
  const onOut = (e: Event) => {
    const el = tipOf(e.target);
    const to = (e as PointerEvent).relatedTarget;
    if (el && !(to instanceof Node && el.contains(to))) reopen(el);
  };
  const onBlur = (e: Event) => reopen(tipOf(e.target));
  doc.addEventListener("pointerdown", onDown, true);
  doc.addEventListener("keydown", onKey, true);
  doc.addEventListener("pointerout", onOut, true);
  doc.addEventListener("focusout", onBlur, true);
  return () => {
    doc.removeEventListener("pointerdown", onDown, true);
    doc.removeEventListener("keydown", onKey, true);
    doc.removeEventListener("pointerout", onOut, true);
    doc.removeEventListener("focusout", onBlur, true);
  };
}
