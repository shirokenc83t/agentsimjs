import { Button, TextField } from "../controls.tsx";
import type { ObjectSpec, ScenarioError } from "@agentsim/scenarios";
import { useState, type InputHTMLAttributes } from "react";
import { Issue, NumberField } from "../run-config/fields.tsx";
import type { PriorSummary } from "./model.ts";

const htmlInput = (testId: string) => ({ "data-testid": testId, className: "mono", spellCheck: false }) as InputHTMLAttributes<HTMLInputElement>;

/**
 * The selected object (ADR-0025 addition of 2026-10-09): id, kind, label, position and size. Problems with ids and limits
 * are shown by the validation section with the loader's stable codes; nothing here hides them.
 */
export function ObjectForm(props: { object: ObjectSpec; onChange: (o: ObjectSpec) => void; onDelete: () => void }) {
  const o = props.object;
  const set = props.onChange;
  return (
    <section className="editor-agent" data-testid="ed-object-form">
      <h5>
        <span className="mono">{o.id}</span> <span className="kind-tag">OBJECT</span>
      </h5>
      <div className="row wrap">
        <TextField size="small" label="id" value={o.id} onChange={(e) => set({ ...o, id: e.target.value.trim().slice(0, 32) })} slotProps={{ htmlInput: htmlInput("ed-object-id") }} />
        <TextField size="small" label="kind" value={o.kind} onChange={(e) => set({ ...o, kind: e.target.value.trim().slice(0, 32) })} slotProps={{ htmlInput: htmlInput("ed-object-kind") }} />
        <TextField size="small" label="label" value={o.label ?? ""} onChange={(e) => set({ ...o, ...(e.target.value === "" ? { label: undefined } : { label: e.target.value.slice(0, 64) }) } as ObjectSpec)} slotProps={{ htmlInput: htmlInput("ed-object-label") }} />
      </div>
      <div className="row wrap">
        <NumberField label="x (m)" value={o.position.xM} onChange={(v) => set({ ...o, position: { ...o.position, xM: v ?? 0 } })} testId="ed-object-x" />
        <NumberField label="y (m)" value={o.position.yM} onChange={(v) => set({ ...o, position: { ...o.position, yM: v ?? 0 } })} testId="ed-object-y" />
        <NumberField label="z (m)" value={o.position.zM} placeholder="0" onChange={(v) => set({ ...o, position: { xM: o.position.xM, yM: o.position.yM, ...(v === undefined ? {} : { zM: v }) } })} testId="ed-object-z" />
        <NumberField label="radius (m)" value={o.size.radiusM} onChange={(v) => set({ ...o, size: { ...o.size, radiusM: v ?? 0.4 } })} testId="ed-object-radius" />
        <NumberField label="height (m)" value={o.size.heightM} onChange={(v) => set({ ...o, size: { ...o.size, heightM: v ?? 1 } })} testId="ed-object-height" />
      </div>
      <Button size="small" variant="text" color="error" onClick={props.onDelete} data-testid="ed-object-delete">
        Delete object
      </Button>
    </section>
  );
}

/** What the validation of the draft's objects and priors says now: a check mark, or the loader's code, message and path. */
export function ExtrasValidation(props: { result: { ok: true } | { ok: false; error: ScenarioError } }) {
  const r = props.result;
  if (r.ok) return <p data-testid="ed-validation">✓ ids, objects and priors are valid</p>;
  return (
    <Issue code={r.error.code} message={r.error.message} testId="ed-validation-error">
      {r.error.path && <span className="muted mono"> at {r.error.path}</span>}
    </Issue>
  );
}

/** The scenario's prior maps: coverage and disagreement with the world, show / edit, a form for the selected one, and creation. */
export function PriorList(props: {
  priors: readonly PriorSummary[];
  shown: string | undefined;
  editing: string | undefined;
  onShow: (id: string | undefined) => void;
  onEdit: (id: string | undefined) => void;
  onUpdate: (id: string, patch: { confidence?: number; description?: string }) => void;
  onDelete: (id: string) => void;
  onCreate: (id: string, confidence: number, description: string) => { ok: boolean; code?: string; message?: string };
}) {
  const [id, setId] = useState("");
  const [confidence, setConfidence] = useState(0.8);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<{ code: string; message: string } | undefined>(undefined);
  return (
    <div data-testid="ed-priors-list">
      {props.priors.length === 0 && <p className="muted">No prior maps. A prior is a map an agent may start from; it can differ from the world on purpose.</p>}
      <ul className="agent-list">
        {props.priors.map((p) => (
          <li key={p.id} data-testid={`ed-prior-${p.id}`}>
            <div className="row wrap">
              <span className="mono">{p.id}</span>
              <span className="muted">
                confidence {p.confidence} · knows {p.knownPct.toFixed(1)} % · {p.wrongPct.toFixed(1)} % of that differs from the world{p.edited ? " · edited" : ""}
              </span>
            </div>
            <div className="row wrap">
              <Button size="small" variant={props.shown === p.id ? "contained" : "outlined"} color="inherit" onClick={() => props.onShow(props.shown === p.id ? undefined : p.id)} aria-pressed={props.shown === p.id} data-testid={`ed-prior-show-${p.id}`}>
                {props.shown === p.id ? "Hide overlay" : "Show against the world"}
              </Button>
              <Button size="small" variant={props.editing === p.id ? "contained" : "outlined"} color="inherit" onClick={() => props.onEdit(props.editing === p.id ? undefined : p.id)} aria-pressed={props.editing === p.id} data-testid={`ed-prior-edit-${p.id}`}>
                {props.editing === p.id ? "Stop editing" : "Edit this prior"}
              </Button>
              <Button size="small" variant="text" color="error" onClick={() => props.onDelete(p.id)} data-testid={`ed-prior-delete-${p.id}`}>
                Delete
              </Button>
            </div>
            {props.editing === p.id && (
              <div className="row wrap">
                <NumberField label="confidence (0–1]" value={p.confidence} step={0.05} onChange={(v) => v !== undefined && props.onUpdate(p.id, { confidence: v })} testId="ed-prior-confidence" />
                <TextField size="small" label="description" value={p.description ?? ""} onChange={(e) => props.onUpdate(p.id, { description: e.target.value.slice(0, 500) })} slotProps={{ htmlInput: htmlInput("ed-prior-description") }} />
              </div>
            )}
          </li>
        ))}
      </ul>
      <h5>Create a prior from this world</h5>
      <div className="row wrap">
        <TextField size="small" label="prior id" value={id} onChange={(e) => setId(e.target.value.trim().slice(0, 32))} slotProps={{ htmlInput: htmlInput("ed-prior-new-id") }} />
        <NumberField label="confidence" value={confidence} step={0.05} onChange={(v) => setConfidence(v ?? 0.8)} testId="ed-prior-new-confidence" />
        <TextField size="small" label="description" value={description} onChange={(e) => setDescription(e.target.value.slice(0, 500))} slotProps={{ htmlInput: htmlInput("ed-prior-new-description") }} />
        <Button
          size="small"
          variant="outlined"
          color="inherit"
          onClick={() => {
            const r = props.onCreate(id, confidence, description);
            if (r.ok) {
              setId("");
              setDescription("");
              setError(undefined);
            } else setError({ code: r.code ?? "error", message: r.message ?? "" });
          }}
          data-testid="ed-prior-create"
        >
          Create from this world
        </Button>
      </div>
      {error && <Issue code={error.code} message={error.message} testId="ed-prior-error" />}
    </div>
  );
}
