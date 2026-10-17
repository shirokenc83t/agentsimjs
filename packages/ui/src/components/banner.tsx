/** Persistent, full-width notice (e.g. "database in use", "not persistent"). Icon + text: never color alone. */
export function Banner(props: { kind: "info" | "warn" | "danger"; testId?: string; children: React.ReactNode }) {
  const icon = props.kind === "danger" ? "✗" : props.kind === "warn" ? "⚠" : "ℹ";
  return (
    <div className={`banner ${props.kind}`} role={props.kind === "info" ? "status" : "alert"} data-testid={props.testId}>
      <span aria-hidden="true">{icon}</span>
      <span>{props.children}</span>
    </div>
  );
}
