import { Button, TextField } from "../controls.tsx";
import type { AgentSpec, ZoneSpec } from "@agentsim/scenarios";
import { useState, type InputHTMLAttributes } from "react";
import { Issue, NumberField, OptionField } from "../run-config/fields.tsx";
import { BODY_FIELDS, bodyValue, bodyWarnings, effectiveBodyValue, withBodyValue, type BodyField } from "./body-fields.ts";
import type { NewScenarioSpec } from "./model.ts";

const KEY_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const ZONE_KINDS = ["base", "geofence", "noFly"] as const;
const CHUNK_SIZES = ["8", "16", "32", "64", "128", "256"] as const;
const htmlInput = (testId: string) => ({ "data-testid": testId, className: "mono", spellCheck: false }) as InputHTMLAttributes<HTMLInputElement>;
const deg = (rad: number | undefined) => (rad === undefined ? undefined : Math.round((rad * 180) / Math.PI * 10) / 10);
const rad = (d: number | undefined) => (d === undefined ? undefined : Math.round(((d * Math.PI) / 180) * 1e6) / 1e6);

/** One body field: generated from the schema; the placeholder is the built-in default (empty = default). */
function BodyFieldInput(props: { agent: AgentSpec; field: BodyField; onChange: (a: AgentSpec) => void }) {
  const { agent, field } = props;
  const name = field.path.join(".");
  const value = bodyValue(agent, field.path);
  const fallback = effectiveBodyValue(agent, field.path);
  const set = (v: unknown) => props.onChange(withBodyValue(agent, field.path, v));
  const testId = `ed-body-${name}`;
  if (field.kind === "enum") {
    return <OptionField label={name} value={typeof value === "string" ? value : undefined} options={field.options} onChange={set} testId={testId} inheritLabel={`default (${String(fallback)})`} />;
  }
  if (field.kind === "boolean") {
    return (
      <OptionField
        label={name}
        value={value === undefined ? undefined : value ? "yes" : "no"}
        options={["yes", "no"] as const}
        onChange={(v) => set(v === undefined ? undefined : v === "yes")}
        testId={testId}
        inheritLabel={`default (${fallback ? "yes" : "no"})`}
      />
    );
  }
  return (
    <NumberField
      label={name}
      value={typeof value === "number" ? value : undefined}
      integer={field.kind === "integer"}
      placeholder={String(fallback)}
      onChange={set}
      testId={testId}
    />
  );
}

/** The selected agent: key, start pose, base, and its body parameters with defaults and warnings. */
export function AgentForm(props: { agent: AgentSpec; index: number; id: string; onChange: (a: AgentSpec) => void; onDelete: () => void }) {
  const { agent, index } = props;
  const set = props.onChange;
  const keyIssue = agent.key !== undefined && !KEY_PATTERN.test(agent.key) ? "keys are lowercase letters, digits and dashes, starting with a letter" : undefined;
  const warnings = bodyWarnings(agent, index);
  return (
    <section className="editor-agent" data-testid="ed-agent-form">
      <h5>
        <span className="mono">{props.id}</span> <span className="kind-tag">{agent.kind.toUpperCase()}</span>
      </h5>
      <div className="row wrap">
        <TextField
          size="small"
          label="key"
          value={agent.key ?? ""}
          error={keyIssue !== undefined}
          helperText={keyIssue}
          onChange={(e) => {
            const k = e.target.value.trim().slice(0, 32);
            const { key: _k, ...rest } = agent;
            set((k === "" ? rest : { ...rest, key: k }) as AgentSpec);
          }}
          slotProps={{ htmlInput: htmlInput("ed-agent-key") }}
        />
        <NumberField label="start x (m)" value={agent.start.xM} onChange={(v) => set({ ...agent, start: { ...agent.start, xM: v ?? 0 } } as AgentSpec)} testId="ed-agent-x" />
        <NumberField label="start y (m)" value={agent.start.yM} onChange={(v) => set({ ...agent, start: { ...agent.start, yM: v ?? 0 } } as AgentSpec)} testId="ed-agent-y" />
        {agent.kind === "uav" && (
          <NumberField
            label="start altitude (m)"
            value={agent.start.zM}
            placeholder="on the ground"
            onChange={(v) => {
              const { zM: _z, ...start } = agent.start;
              set({ ...agent, start: v === undefined ? start : { ...start, zM: v } } as AgentSpec);
            }}
            testId="ed-agent-z"
          />
        )}
        <NumberField
          label="heading (°, from east)"
          value={deg(agent.start.headingRad)}
          placeholder="0"
          onChange={(v) => {
            const { headingRad: _h, ...start } = agent.start;
            const r = rad(v);
            set({ ...agent, start: r === undefined ? start : { ...start, headingRad: r } } as AgentSpec);
          }}
          testId="ed-agent-heading"
        />
        <NumberField
          label="base x (m)"
          value={agent.base?.xM}
          placeholder="none"
          onChange={(v) => set(withBase(agent, v, agent.base?.yM))}
          testId="ed-agent-base-x"
        />
        <NumberField
          label="base y (m)"
          value={agent.base?.yM}
          placeholder="none"
          onChange={(v) => set(withBase(agent, agent.base?.xM, v))}
          testId="ed-agent-base-y"
        />
      </div>
      <h5>Body</h5>
      <p className="muted hint">Empty fields use the built-in default shown in grey; run configurations may override planning and drive parameters.</p>
      <div className="field-grid">
        {BODY_FIELDS[agent.kind].map((f) => (
          <BodyFieldInput key={f.path.join(".")} agent={agent} field={f} onChange={set} />
        ))}
      </div>
      {warnings.length > 0 && (
        <ul className="warnings" data-testid="ed-body-warnings">
          {warnings.map((w) => (
            <li key={`${w.code}${w.path}`} className="warn">
              ▲ <span className="mono">{w.code}</span> {w.message}
            </li>
          ))}
        </ul>
      )}
      <Button variant="outlined" color="inherit" onClick={props.onDelete} data-testid="ed-agent-delete">
        Delete agent
      </Button>
    </section>
  );
}

/** A base needs both coordinates; clearing either removes it. */
function withBase(agent: AgentSpec, x: number | undefined, y: number | undefined): AgentSpec {
  const { base: _b, ...rest } = agent;
  return (x === undefined || y === undefined ? rest : { ...rest, base: { xM: x, yM: y } }) as AgentSpec;
}

/** Zones: rectangles are editable; polygons from imported documents are kept as they are. */
export function ZoneList(props: { zones: readonly ZoneSpec[]; onChange: (index: number, z: ZoneSpec) => void; onDelete: (index: number) => void }) {
  if (props.zones.length === 0) return <p className="muted">No zones. Use the zone tool to draw a rectangle.</p>;
  return (
    <ul className="zone-list" data-testid="ed-zones">
      {props.zones.map((z, k) => (
        <li key={k} data-testid={`ed-zone-${z.id}`}>
          <div className="row wrap">
            <TextField
              size="small"
              label="id"
              value={z.id}
              error={!ID_PATTERN.test(z.id)}
              onChange={(e) => props.onChange(k, { ...z, id: e.target.value.trim().slice(0, 64) })}
              slotProps={{ htmlInput: htmlInput(`ed-zone-id-${k}`) }}
            />
            <OptionField label="kind" value={z.kind} options={ZONE_KINDS} onChange={(v) => v && props.onChange(k, { ...z, kind: v })} testId={`ed-zone-kind-${k}`} inheritLabel="—" />
            {z.rect ? (
              (["x0", "y0", "x1", "y1"] as const).map((c) => (
                <NumberField
                  key={c}
                  label={`${c} (m)`}
                  value={z.rect?.[c]}
                  onChange={(v) => z.rect && props.onChange(k, { ...z, rect: { ...z.rect, [c]: v ?? 0 } })}
                  testId={`ed-zone-${c}-${k}`}
                />
              ))
            ) : (
              <span className="muted">polygon, {z.polygon?.length ?? 0} vertices (kept as imported)</span>
            )}
            <Button size="small" variant="text" onClick={() => props.onDelete(k)} aria-label={`Delete zone ${z.id}`}>
              ✕
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Form for a new, empty scenario. */
export function NewScenarioForm(props: { onCreate: (spec: NewScenarioSpec) => void; onCancel: () => void }) {
  const [id, setId] = useState("new-scenario");
  const [name, setName] = useState("New scenario");
  const [sizeX, setSizeX] = useState<number | undefined>(128);
  const [sizeY, setSizeY] = useState<number | undefined>(128);
  const [resolutionM, setResolution] = useState<number | undefined>(0.5);
  const [chunk, setChunk] = useState<(typeof CHUNK_SIZES)[number]>("32");
  const problem = !ID_PATTERN.test(id)
    ? "id: lowercase letters, digits and dashes, starting with a letter"
    : name.trim() === ""
      ? "name is required"
      : !sizeX || !sizeY || sizeX < 1 || sizeY < 1 || sizeX > 8192 || sizeY > 8192
        ? "size: 1 to 8192 cells per side"
        : !resolutionM || resolutionM <= 0 || resolutionM > 100
          ? "resolution: more than 0, at most 100 m"
          : undefined;
  return (
    <fieldset className="cost-profile" data-testid="ed-new-form">
      <legend>New scenario</legend>
      <div className="row wrap">
        <TextField size="small" label="id" value={id} onChange={(e) => setId(e.target.value.trim())} slotProps={{ htmlInput: htmlInput("ed-new-id") }} />
        <TextField size="small" label="name" value={name} onChange={(e) => setName(e.target.value.slice(0, 200))} slotProps={{ htmlInput: htmlInput("ed-new-name") }} />
        <NumberField label="cells x" value={sizeX} integer onChange={setSizeX} testId="ed-new-x" />
        <NumberField label="cells y" value={sizeY} integer onChange={setSizeY} testId="ed-new-y" />
        <NumberField label="resolution (m)" value={resolutionM} onChange={setResolution} testId="ed-new-res" />
        <OptionField label="chunk size" value={chunk} options={CHUNK_SIZES} onChange={(v) => v && setChunk(v)} testId="ed-new-chunk" inheritLabel="32" />
      </div>
      {problem && <Issue code="invalid_document" message={problem} testId="ed-new-issue" />}
      <div className="row">
        <Button
          variant="contained"
          aria-disabled={problem !== undefined}
          onClick={() =>
            problem === undefined &&
            sizeX &&
            sizeY &&
            resolutionM &&
            props.onCreate({ id, name: name.trim(), defaultSeed: 1, sizeX, sizeY, resolutionM, chunkSize: Number(chunk) as NewScenarioSpec["chunkSize"] })
          }
          data-testid="ed-new-create"
        >
          Create
        </Button>
        <Button variant="text" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </fieldset>
  );
}
