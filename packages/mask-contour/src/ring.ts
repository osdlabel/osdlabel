/** A 2D vertex. Structurally identical to `@osdlabel/annotation`'s `Point`. */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** A closed ring; the closing edge from the last vertex back to the first is implicit. */
export type Ring = readonly Vec2[];

/**
 * A traced boundary. In this package's convention (y down, foreground on the
 * right of travel) outer boundaries have positive {@link signedArea} and holes
 * negative.
 */
export interface Contour {
  readonly ring: Ring;
  readonly hole: boolean;
}

/** An outer ring with the holes it contains. */
export interface PolygonWithHoles {
  readonly outer: Ring;
  readonly holes: readonly Ring[];
}

/** Shoelace area; positive for clockwise rings in y-down coordinates. */
export function signedArea(ring: Ring): number {
  let sum = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/** Even-odd point-in-ring test. */
export function pointInRing(p: Vec2, ring: Ring): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Groups contours into polygons: each hole goes to the smallest outer ring
 * containing its first vertex. Polygons are returned largest first.
 */
export function assembleHoles(contours: readonly Contour[]): PolygonWithHoles[] {
  const outers = contours
    .filter((c) => !c.hole)
    .map((c) => ({ ring: c.ring, area: Math.abs(signedArea(c.ring)), holes: [] as Ring[] }))
    .sort((a, b) => b.area - a.area);
  for (const c of contours) {
    if (!c.hole || c.ring.length === 0) continue;
    const probe = c.ring[0]!;
    let owner: (typeof outers)[number] | null = null;
    for (const o of outers) {
      if (pointInRing(probe, o.ring) && (!owner || o.area < owner.area)) owner = o;
    }
    owner?.holes.push(c.ring);
  }
  return outers.map((o) => ({ outer: o.ring, holes: o.holes }));
}

/** Applies an affine map (scale then offset) to every vertex. */
export function transformRing(
  ring: Ring,
  scaleX: number,
  scaleY: number,
  offsetX: number,
  offsetY: number,
): Vec2[] {
  return ring.map((p) => ({ x: p.x * scaleX + offsetX, y: p.y * scaleY + offsetY }));
}
