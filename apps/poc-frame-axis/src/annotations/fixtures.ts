/**
 * Per-frame fixture geometry: N annotations per frame, of every vector type,
 * placed deterministically (around the phantom's lesions where a slice has
 * them, on a jittered grid otherwise). Pure — the browser turns these into
 * `OsdAnnotation`s with real Fabric payloads (see `build-annotations.ts`).
 */
import type { VectorGeometry } from '@osdlabel/annotation';
import { mulberry32 } from '../data/ct-phantom.js';

export const FIXTURE_TYPES = [
  'rectangle',
  'circle',
  'line',
  'polygon',
  'point',
  'polyline',
] as const;

export interface FixtureSpec {
  readonly frame: number;
  readonly ordinal: number;
  readonly geometry: VectorGeometry;
  readonly label: string | undefined;
}

export function fixtureGeometry(
  frame: number,
  perFrame: number,
  width: number,
  height: number,
  anchors: readonly { x: number; y: number; r: number }[] = [],
): FixtureSpec[] {
  const rnd = mulberry32(frame * 1000 + 17);
  const out: FixtureSpec[] = [];
  const cols = Math.max(1, Math.ceil(Math.sqrt(perFrame)));
  const cell = Math.min(width, height) / (cols + 1);
  for (let k = 0; k < perFrame; k++) {
    const anchor = anchors[k];
    const cx = anchor ? anchor.x : ((k % cols) + 1) * cell + (rnd() - 0.5) * cell * 0.3;
    const cy = anchor ? anchor.y : (Math.floor(k / cols) + 1) * cell + (rnd() - 0.5) * cell * 0.3;
    const s = anchor ? Math.max(6, anchor.r) : cell * (0.15 + rnd() * 0.15);
    const type = FIXTURE_TYPES[k % FIXTURE_TYPES.length]!;
    let geometry: VectorGeometry;
    switch (type) {
      case 'rectangle':
        geometry = {
          type,
          origin: { x: cx - s, y: cy - s * 0.7 },
          width: 2 * s,
          height: 1.4 * s,
          rotation: 0,
        };
        break;
      case 'circle':
        geometry = { type, center: { x: cx, y: cy }, radius: s };
        break;
      case 'line':
        geometry = {
          type,
          start: { x: cx - s, y: cy - s * 0.4 },
          end: { x: cx + s, y: cy + s * 0.4 },
        };
        break;
      case 'point':
        geometry = { type, position: { x: cx, y: cy } };
        break;
      case 'polygon':
      case 'polyline': {
        const n = type === 'polygon' ? 6 : 8;
        const points = Array.from({ length: n }, (_, j) => {
          const a = (2 * Math.PI * j) / n;
          const rr = s * (0.8 + 0.4 * rnd());
          return { x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr };
        });
        geometry = { type, points };
        break;
      }
    }
    out.push({ frame, ordinal: k, geometry, label: k % 3 === 0 ? `F${frame}#${k}` : undefined });
  }
  return out;
}
