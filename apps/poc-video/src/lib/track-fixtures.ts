/**
 * The 1,000-track mixed fixture of scripts/temporal-bench.mjs (same mix, same
 * seed, 300 frames, a keyframe every 30), in TypeScript for the browser
 * pages. Mask keyframes carry real pixels here (a filled disc of varying
 * radius in a 64 x 64 box), so both storage formats pay for mask payloads.
 */
import type { Geometry, Point } from '@osdlabel/annotation';
import type { MaskSnapshot } from '@osdlabel/mask';
import { createTrack, createTrackId } from '@osdlabel/temporal';
import type { Keyframe, TrackBase, Visibility } from '@osdlabel/temporal';
import { mulberry32 } from './rng.js';

export const FIXTURE_FRAMES = 300;
export const FIXTURE_KF_EVERY = 30;
export const FIXTURE_IMAGE = { width: 1920, height: 1080 } as const;

export type FixtureKind =
  | 'rectangle'
  | 'circle'
  | 'point'
  | 'line'
  | 'polygon-equal'
  | 'polygon-unequal'
  | 'polyline-unequal'
  | 'mask';

export const FIXTURE_MIX: readonly (readonly [FixtureKind, number])[] = [
  ['rectangle', 250],
  ['circle', 150],
  ['point', 150],
  ['line', 100],
  ['polygon-equal', 150],
  ['polygon-unequal', 100],
  ['polyline-unequal', 50],
  ['mask', 50],
];

/** A fixture track: its keyframes, and for masks the pixels of each keyframe. */
export interface FixtureTrack {
  readonly kind: FixtureKind;
  readonly track: TrackBase<MaskSnapshot>;
}

function starPolygon(rnd: () => number, n: number, cx: number, cy: number, r: number): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    const rr = r * (0.7 + 0.3 * rnd());
    pts.push({ x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a) });
  }
  return pts;
}

function redraw(points: readonly Point[], start: number): Point[] {
  const n = points.length;
  const out: Point[] = [];
  for (let k = 0; k < n; k++) out.push(points[(start - k + n) % n]!);
  return out;
}

function discSnapshot(x: number, y: number, radius: number): MaskSnapshot {
  const w = 64;
  const h = 64;
  const data = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if ((i - 31.5) ** 2 + (j - 31.5) ** 2 <= radius * radius) data[j * w + i] = 1;
    }
  }
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: w,
    height: h,
    data,
    imageWidth: FIXTURE_IMAGE.width,
    imageHeight: FIXTURE_IMAGE.height,
  };
}

function makeKeyframe(
  kind: FixtureKind,
  rnd: () => number,
  kfIndex: number,
): { geometry: Geometry; payload?: MaskSnapshot } {
  const cx = 200 + rnd() * 1500;
  const cy = 150 + rnd() * 800;
  switch (kind) {
    case 'rectangle':
      return {
        geometry: {
          type: 'rectangle',
          origin: { x: cx, y: cy },
          width: 20 + rnd() * 80,
          height: 20 + rnd() * 80,
          rotation: rnd() * 30,
        },
      };
    case 'circle':
      return { geometry: { type: 'circle', center: { x: cx, y: cy }, radius: 5 + rnd() * 40 } };
    case 'point':
      return { geometry: { type: 'point', position: { x: cx, y: cy } } };
    case 'line':
      return {
        geometry: {
          type: 'line',
          start: { x: cx, y: cy },
          end: { x: cx + 50 * rnd(), y: cy + 50 * rnd() },
        },
      };
    case 'polygon-equal':
      return { geometry: { type: 'polygon', points: starPolygon(rnd, 16, cx, cy, 40) } };
    case 'polygon-unequal': {
      const pts = starPolygon(rnd, kfIndex % 2 === 0 ? 12 : 24, cx, cy, 40);
      return {
        geometry: { type: 'polygon', points: redraw(pts, Math.floor(rnd() * pts.length)) },
      };
    }
    case 'polyline-unequal':
      return {
        geometry: {
          type: 'polyline',
          points: Array.from({ length: kfIndex % 2 === 0 ? 8 : 12 }, (_, i) => ({
            x: cx + i * 10,
            y: cy + 20 * rnd(),
          })),
        },
      };
    case 'mask': {
      const snap = discSnapshot(cx, cy, 10 + rnd() * 20);
      let count = 0;
      for (const b of snap.data) count += b;
      return {
        geometry: {
          type: 'mask',
          origin: { x: snap.x, y: snap.y },
          width: snap.width,
          height: snap.height,
          pixelCount: count,
        },
        payload: snap,
      };
    }
  }
}

export function buildFixtureTracks(seed = 1): FixtureTrack[] {
  const rnd = mulberry32(seed);
  const out: FixtureTrack[] = [];
  for (const [kind, count] of FIXTURE_MIX) {
    for (let t = 0; t < count; t++) {
      const keyframes: Keyframe<MaskSnapshot>[] = [];
      for (let k = 0, f = 0; f < FIXTURE_FRAMES; k++, f += FIXTURE_KF_EVERY) {
        const { geometry, payload } = makeKeyframe(kind, rnd, k);
        const visibility: Visibility = rnd() < 0.1 ? 'occluded' : 'visible';
        keyframes.push({ frame: f, geometry, visibility, ...(payload ? { payload } : {}) });
      }
      out.push({
        kind,
        track: createTrack<MaskSnapshot>({
          id: createTrackId(`${kind}-${t}`),
          geometryType: keyframes[0]!.geometry.type,
          keyframes,
        }),
      });
    }
  }
  return out;
}
