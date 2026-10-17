import { useEffect, useRef, useState } from "react";
import type { StateInterpolator } from "../scene/interpolator.ts";
import { SceneRenderer } from "../scene/scene-renderer.ts";
import { getThemeState, subscribeTheme } from "../theme/theme-controller.ts";
import { sceneTokens } from "../theme/tokens.ts";

/**
 * Thin React host for the imperative Three.js renderer (ADR-0016): React mounts it once and never
 * participates in per-frame work.
 */
export function SceneView(props: {
  interpolator: StateInterpolator;
  /** Entity IDs by pose index (agent colours are derived from them). */
  entityIds?: readonly string[];
  onRenderer?: (r: SceneRenderer | undefined) => void;
  children?: React.ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const { interpolator, onRenderer, entityIds } = props;
  const rendererRef = useRef<SceneRenderer | undefined>(undefined);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: SceneRenderer | undefined;
    try {
      renderer = new SceneRenderer(el, interpolator, sceneTokens(getThemeState().resolved));
      renderer.start();
      rendererRef.current = renderer;
      onRenderer?.(renderer);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    // Theme changes reach the renderer as one token snapshot, outside the frame loop.
    const unsubscribe = subscribeTheme(() => renderer?.applyTheme(sceneTokens(getThemeState().resolved)));
    return () => {
      unsubscribe();
      rendererRef.current = undefined;
      onRenderer?.(undefined);
      renderer?.dispose();
    };
  }, [interpolator, onRenderer]);

  useEffect(() => {
    if (entityIds) rendererRef.current?.setEntityIds(entityIds);
  }, [entityIds]);

  return (
    <div className="scene-host" ref={host} data-testid="scene">
      {error && (
        <p className="panel danger" role="alert">
          ✗ 3D view unavailable: {error}
        </p>
      )}
      {props.children}
    </div>
  );
}
