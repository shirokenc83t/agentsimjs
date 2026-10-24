import "./panels.css";
import { useSceneView } from "./scene-view-store.ts";

/**
 * The Legend window of the Scene (ADR-0042, UI-SPEC section 4): what the map's marks and the overlays that are on mean, in one floating window instead of over the map.
 * Always the same first block (labels, identities, attention, chips); then one block per overlay that is switched on.
 */
export function LegendPanel() {
  const v = useSceneView();
  return (
    <div className="panel legend-panel" data-testid="legend">
      <dl className="kv legend">
        <dt>g07</dt>
        <dd>= ugv-007 · g ground, a aerial (the whole ID in the tooltip)</dd>
        <dt>■ □ ▢</dt>
        <dd>identity: solid, outline or dashed marker, in one of eight colours (24 in all)</dd>
        <dt>4 · g03 g05</dt>
        <dd>cluster of agents too close to label: click to zoom in</dd>
        <dt>✕ ring</dt>
        <dd>alarm: the agent failed or is out of battery</dd>
        <dt>▲ badge</dt>
        <dd>warning: rejected, recovering, a reflex, battery low, stuck</dd>
        <dt>╌╌ dashed</dt>
        <dd>planned path</dd>
        <dt>── solid</dt>
        <dd>executed path</dd>
        {v.mode === "height" && (
          <>
            <dt>▨ hatched</dt>
            <dd>occupied, unknown height</dd>
          </>
        )}
      </dl>
      {v.overlay !== "truth" && (
        <dl className="kv legend" data-testid="overlay-legend">
          <dt>╱ dark, hatched</dt>
          <dd>unknown to the agent</dd>
          {v.overlay === "difference" && (
            <>
              <dt>╱ hatched</dt>
              <dd>believed occupied, actually free</dd>
              <dt>╳ cross-hatched</dt>
              <dd>believed free, actually blocked</dd>
            </>
          )}
        </dl>
      )}
      {(v.rays || v.topology) && (
        <dl className="kv legend" data-testid="sensor-legend">
          {v.rays && (
            <>
              <dt>─ accent</dt>
              <dd>lidar ray that hit an obstacle</dd>
              <dt>─ grey</dt>
              <dd>lidar ray that reached its range</dd>
            </>
          )}
          {v.topology && (
            <>
              <dt>□ outline</dt>
              <dd>region of the agent&apos;s topological layer</dd>
              <dt>● amber</dt>
              <dd>frontier group: known free next to unknown</dd>
              <dt>● red</dt>
              <dd>frontier group marked unreachable</dd>
            </>
          )}
        </dl>
      )}
      {v.explore && (
        <dl className="kv legend" data-testid="explore-legend">
          <dt>◯ ring</dt>
          <dd>iteration of explore: its radius around its centre (square: the search window)</dd>
          <dt>◇ amber</dt>
          <dd>target set aside for the iteration (tried again from another centre)</dd>
          <dt>✕ red</dt>
          <dd>target marked unreachable</dd>
        </dl>
      )}
      {(v.stages || v.sandbox) && (
        <dl className="kv legend" data-testid="stages-legend">
          {v.stages && (
            <>
              <dt>╌╌ dashed</dt>
              <dd>coarse path of a refine</dd>
              <dt>── solid, two tones</dt>
              <dd>the legs of a plan, alternating</dd>
              <dt>● ① ②</dt>
              <dd>numbered joint: where one leg ends and the next begins</dd>
            </>
          )}
          {v.sandbox && (
            <>
              <dt>── orange</dt>
              <dd data-testid="sandbox-legend">Strategy test result (not part of the run)</dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}
