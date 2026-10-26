import { BufferGeometry, Float32BufferAttribute, RingGeometry } from "three";

/**
 * A flat ring cut into `dashes` arcs (the dashed marker style of an agent, and the hover ring): one geometry, so a dashed ring is one instance like a solid one.
 * The gap is as long as the arc.
 */
export function dashedRingGeometry(inner: number, outer: number, dashes = 14, arcSegments = 3): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const step = (Math.PI * 2) / dashes;
  for (let k = 0; k < dashes; k++) {
    const arc = new RingGeometry(inner, outer, arcSegments, 1, k * step, step / 2);
    const pos = arc.getAttribute("position");
    const base = positions.length / 3;
    for (let i = 0; i < pos.count; i++) positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    const index = arc.getIndex();
    if (index) for (let i = 0; i < index.count; i++) indices.push(base + index.getX(i));
    arc.dispose();
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  return g;
}
