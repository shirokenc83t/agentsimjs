/** What a key does in the shell (UI-SPEC §2): `1`–`5` open the workspaces, Space plays and pauses, `.` steps one tick. */
export type ShellKey = { readonly kind: "workspace"; readonly index: number } | { readonly kind: "toggle-play" } | { readonly kind: "step" };

interface KeyLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/** Roles whose own key handling uses Space (and Enter): a Space there activates the control, it is not the transport's. */
const OWN_SPACE = new Set(["button", "slider", "option", "tab", "checkbox", "radio", "switch", "menuitem", "link", "combobox", "listbox", "textbox", "spinbutton"]);

function target(el: EventTarget | null): { editable: boolean; ownSpace: boolean; inDialog: boolean } {
  const e = el instanceof Element ? el : null;
  if (!e) return { editable: false, ownSpace: false, inDialog: false };
  const tag = e.tagName;
  const editable = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e as HTMLElement).isContentEditable === true;
  const role = e.getAttribute("role");
  const ownSpace = editable || tag === "BUTTON" || tag === "A" || tag === "SUMMARY" || (role !== null && OWN_SPACE.has(role));
  return { editable, ownSpace, inDialog: e.closest('[role="dialog"], [role="alertdialog"]') !== null };
}

/**
 * The shell action of a key press, or undefined when the key is not the shell's: with a modifier, while typing in a field, inside a dialog, or (for Space)
 * on a control that Space already activates.
 */
export function shellKey(e: KeyLike, from: EventTarget | null, workspaces: number): ShellKey | undefined {
  if (e.ctrlKey || e.metaKey || e.altKey) return undefined;
  const t = target(from);
  if (t.editable || t.inDialog) return undefined;
  if (e.key === " ") return t.ownSpace || e.shiftKey ? undefined : { kind: "toggle-play" };
  if (e.shiftKey) return undefined;
  if (e.key === ".") return { kind: "step" };
  if (/^[1-9]$/.test(e.key)) {
    const index = Number(e.key) - 1;
    return index < workspaces ? { kind: "workspace", index } : undefined;
  }
  return undefined;
}
