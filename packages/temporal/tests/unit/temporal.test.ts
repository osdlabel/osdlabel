import { describe, expect, it } from 'vitest';
import type { Geometry, Point, PolygonGeometry } from '@osdlabel/annotation';
import {
  createConstantRateAxis,
  createFrameMaterializer,
  createSliceAxis,
  createTimestampAxis,
  createTrack,
  createTrackId,
  frameAt,
  interpolateGeometry,
  frameRefOf,
  midpointOf,
  nearestFrame,
  reconcileFrame,
  resolveFrameRef,
  polygonCorrespondence,
  polylineCorrespondence,
  removeKeyframe,
  sampleTrack,
  signedArea,
  upsertKeyframe,
} from '../../src/index.js';
import type { Keyframe, TrackBase } from '../../src/index.js';

const rect = (x: number, y: number, w: number, h: number, rotation = 0): Geometry => ({
  type: 'rectangle',
  origin: { x, y },
  width: w,
  height: h,
  rotation,
});
const kf = (
  frame: number,
  geometry: Geometry,
  visibility: Keyframe['visibility'] = 'visible',
): Keyframe => ({
  frame,
  geometry,
  visibility,
});
const poly = (points: readonly Point[]): PolygonGeometry => ({ type: 'polygon', points });
const area = (g: Geometry): number => (g.type === 'polygon' ? Math.abs(signedArea(g.points)) : NaN);

describe('frame axis', () => {
  it('computes 29.97 fps timestamps from the index without drift', () => {
    const axis = createConstantRateAxis(100000, 30000, 1001);
    expect(axis.positions[99999]).toBeCloseTo((99999 * 1001 * 1e6) / 30000, 6);
    expect(frameAt(axis, axis.positions[54321]!)).toBe(54321);
    expect(frameAt(axis, axis.positions[54321]! - 1e-3)).toBe(54320);
  });
  it('maps positions on a variable-rate axis and clamps', () => {
    const axis = createTimestampAxis([0, 33366, 50000, 116733], 33366);
    expect(frameAt(axis, -5)).toBe(0);
    expect(frameAt(axis, 49999)).toBe(1);
    expect(frameAt(axis, 50000)).toBe(2);
    expect(frameAt(axis, 1e9)).toBe(3);
    expect(midpointOf(axis, 2)).toBeCloseTo(50000 + 66733 / 2);
    expect(midpointOf(axis, 3)).toBeCloseTo(116733 + 33366 / 2);
  });
  it('maps a stored time back to the nearest frame, where frameAt would slip back', () => {
    // A WebM demuxer's 1 ms timebase vs a nominal 30 fps writer: frame 2 is
    // at 67 ms, the writer stored 66.67 ms.
    const axis = createTimestampAxis([0, 33000, 67000, 100000], 33000);
    expect(frameAt(axis, (2 * 1e6) / 30)).toBe(1);
    expect(nearestFrame(axis, (2 * 1e6) / 30)).toBe(2);
    expect(nearestFrame(axis, 50000)).toBe(1);
    expect(nearestFrame(axis, 50001)).toBe(2);
    expect(nearestFrame(axis, -1)).toBe(0);
    expect(nearestFrame(axis, 1e9)).toBe(3);
  });
  it('reconciles stored start times with a capped tolerance, not to the nearest frame', () => {
    // ffprobe-exact 29.97 fps starts (fractional µs) as a reader's axis.
    const exact = createConstantRateAxis(300, 30000, 1001);
    // Another demuxer truncates to integer µs; this one keeps the fraction:
    // plain at-or-before slips back, the tolerance does not.
    expect(frameAt(exact, Math.trunc(exact.positions[2]!))).toBe(1);
    expect(reconcileFrame(exact, Math.trunc(exact.positions[2]!))).toBe(2);
    // Millisecond truncation (up to 1 ms early) and the float seconds round trip.
    expect(reconcileFrame(exact, Math.floor(exact.positions[7]! / 1000) * 1000)).toBe(7);
    expect(reconcileFrame(exact, (exact.positions[7]! / 1e6) * 1e6)).toBe(7);
    // A time inside the frame (a paused currentTime) stays on that frame,
    // where nearestFrame jumps to the next one past the midpoint...
    const late = exact.positions[7]! + 0.7 * (exact.positions[8]! - exact.positions[7]!);
    expect(reconcileFrame(exact, late)).toBe(7);
    expect(nearestFrame(exact, late)).toBe(8);
    expect(reconcileFrame(exact, midpointOf(exact, 7))).toBe(7);
    // ...except within the 1 ms tolerance of the next frame's start.
    expect(reconcileFrame(exact, exact.positions[8]! - 999)).toBe(8);
    expect(reconcileFrame(exact, exact.positions[8]! - 1001)).toBe(7);
    // The tolerance is a quarter frame when frames are shorter than 4 ms.
    const fast = createConstantRateAxis(10, 1000);
    expect(reconcileFrame(fast, 1000 - 251)).toBe(0);
    expect(reconcileFrame(fast, 1000 - 249)).toBe(1);
    // Clamped at both ends.
    expect(reconcileFrame(exact, -5e6)).toBe(0);
    expect(reconcileFrame(exact, 1e12)).toBe(299);
  });
  it('stores a frame as its start in integer µs and resolves it on another axis', () => {
    const exact = createConstantRateAxis(300, 30000, 1001);
    const ref = frameRefOf(exact, 123);
    expect(ref).toEqual({ index: 123, timeUs: Math.round(exact.positions[123]!) });
    // The reader's demuxer truncates to µs; same frame.
    const trunc = createTimestampAxis(exact.positions.map(Math.trunc), 33367);
    expect(resolveFrameRef(trunc, ref)).toBe(123);
    // Without a time, the index (clamped) is the authority.
    expect(resolveFrameRef(trunc, { index: 999 })).toBe(299);
    const slices = createSliceAxis([0, 2.5, 5], 2.5);
    expect(frameRefOf(slices, 1)).toEqual({ index: 1 });
  });
  it('builds a slice axis and rejects non-increasing positions', () => {
    expect(createSliceAxis([-10, -7.5, -5], 2.5).kind).toBe('space');
    expect(() => createSliceAxis([0, 0], 1)).toThrow();
  });
});

describe('track editing', () => {
  it('sorts, validates and edits keyframes immutably', () => {
    const t = createTrack({
      geometryType: 'rectangle',
      keyframes: [kf(40, rect(0, 0, 1, 1)), kf(10, rect(0, 0, 1, 1))],
    });
    expect(t.keyframes.map((k) => k.frame)).toEqual([10, 40]);
    const t2 = upsertKeyframe(t, kf(25, rect(1, 1, 1, 1)));
    expect(t2.keyframes.map((k) => k.frame)).toEqual([10, 25, 40]);
    expect(t2.keyframes[0]).toBe(t.keyframes[0]);
    expect(t.keyframes).toHaveLength(2);
    expect(removeKeyframe(t2, 25).keyframes.map((k) => k.frame)).toEqual([10, 40]);
    expect(removeKeyframe(t2, 26)).toBe(t2);
    expect(() => upsertKeyframe(t, kf(5, { type: 'point', position: { x: 0, y: 0 } }))).toThrow();
    expect(() =>
      createTrack({
        geometryType: 'rectangle',
        keyframes: [kf(1, rect(0, 0, 1, 1)), kf(1, rect(0, 0, 1, 1))],
      }),
    ).toThrow();
  });
});

describe('sampleTrack', () => {
  const track = createTrack({
    id: createTrackId('t1'),
    geometryType: 'rectangle',
    keyframes: [kf(10, rect(100, 100, 50, 50)), kf(40, rect(400, 100, 50, 80))],
  });

  it('is empty before the first keyframe, exact on keyframes, linear between', () => {
    expect(sampleTrack(track, 9)).toBeNull();
    const k = sampleTrack(track, 10);
    expect(k!.source).toBe('keyframe');
    expect(k!.geometry).toBe(track.keyframes[0]!.geometry);
    const mid = sampleTrack(track, 25)!;
    expect(mid.source).toBe('interpolated');
    expect(mid.geometry).toEqual(rect(250, 100, 50, 65));
  });

  it('holds after the last keyframe unless afterLast is end', () => {
    expect(sampleTrack(track, 99)!.geometry).toBe(track.keyframes[1]!.geometry);
    expect(sampleTrack({ ...track, afterLast: 'end' }, 99)).toBeNull();
  });

  it('honours outside (gaps) and occluded (carried until the next keyframe)', () => {
    const t = createTrack({
      geometryType: 'point',
      keyframes: [
        kf(0, { type: 'point', position: { x: 0, y: 0 } }, 'occluded'),
        kf(10, { type: 'point', position: { x: 10, y: 0 } }, 'outside'),
        kf(20, { type: 'point', position: { x: 20, y: 0 } }),
      ],
    });
    const s5 = sampleTrack(t, 5)!;
    // b is outside: no blend toward a shape that does not exist; hold a.
    expect(s5.visibility).toBe('occluded');
    expect(s5.geometry).toEqual({ type: 'point', position: { x: 0, y: 0 } });
    expect(sampleTrack(t, 10)).toBeNull();
    expect(sampleTrack(t, 15)).toBeNull();
    expect(sampleTrack(t, 20)!.visibility).toBe('visible');
  });

  it('rotates along the short arc', () => {
    const g = interpolateGeometry(rect(0, 0, 1, 1, 350), rect(0, 0, 1, 1, 10), 0.5);
    // Normalised to [0, 360): the midpoint of 350 -> 10 is 0, not 360.
    expect(g.type === 'rectangle' && g.rotation).toBeCloseTo(0);
    const q = interpolateGeometry(rect(0, 0, 1, 1, 350), rect(0, 0, 1, 1, 10), 0.75);
    expect(q.type === 'rectangle' && q.rotation).toBeCloseTo(5);
  });

  it('holds masks at the nearest keyframe, or the previous one on request', () => {
    const m = (x: number): Geometry => ({
      type: 'mask',
      origin: { x, y: 0 },
      width: 4,
      height: 4,
      pixelCount: 16,
    });
    const t: TrackBase<string> = createTrack<string>({
      geometryType: 'mask',
      keyframes: [
        { frame: 0, geometry: m(0), visibility: 'visible', payload: 'rle-a' },
        { frame: 10, geometry: m(10), visibility: 'visible', payload: 'rle-b' },
      ],
    });
    expect(sampleTrack(t, 4)!.payload).toBe('rle-a');
    expect(sampleTrack(t, 6)!.payload).toBe('rle-b');
    expect(sampleTrack(t, 6)!.source).toBe('held');
    expect(sampleTrack({ ...t, holdPolicy: 'previous' }, 9)!.payload).toBe('rle-a');
  });

  it('interpolates circle, point and line linearly', () => {
    const c = interpolateGeometry(
      { type: 'circle', center: { x: 0, y: 0 }, radius: 10 },
      { type: 'circle', center: { x: 10, y: 20 }, radius: 30 },
      0.25,
    );
    expect(c).toEqual({ type: 'circle', center: { x: 2.5, y: 5 }, radius: 15 });
    const l = interpolateGeometry(
      { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { type: 'line', start: { x: 0, y: 10 }, end: { x: 10, y: 10 } },
      0.5,
    );
    expect(l).toEqual({ type: 'line', start: { x: 0, y: 5 }, end: { x: 10, y: 5 } });
  });
});

describe('contour correspondence', () => {
  const square: Point[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];

  it('keeps index correspondence for an edited polygon with the same vertices', () => {
    const moved = square.map((p, i) => (i === 2 ? { x: 120, y: 130 } : p));
    const c = polygonCorrespondence(square, moved);
    expect(c.method).toBe('index');
    expect(c.from).toBe(square);
  });

  it('handles a redraw starting at another vertex with the opposite winding', () => {
    // The same square, drawn from vertex 2, clockwise instead of counter.
    const redrawn: Point[] = [square[2]!, square[1]!, square[0]!, square[3]!];
    const naive = interpolateGeometry(poly(square), poly(redrawn), 0.5, {
      from: square,
      to: redrawn,
      method: 'index',
    });
    const aligned = interpolateGeometry(poly(square), poly(redrawn), 0.5);
    // Naive index-wise blending collapses the square; aligned keeps it.
    expect(area(naive)).toBeLessThan(0.5 * 10000);
    expect(area(aligned)).toBeCloseTo(10000, 6);
  });

  it('resamples unequal counts and reproduces both keyframes exactly', () => {
    // Octagon-ish circle approximation vs square: 16 vs 4 vertices.
    const circle: Point[] = Array.from({ length: 16 }, (_, i) => ({
      x: 50 + 50 * Math.cos((i / 16) * 2 * Math.PI),
      y: 50 + 50 * Math.sin((i / 16) * 2 * Math.PI),
    }));
    const c = polygonCorrespondence(square, circle);
    expect(c.method).toBe('arc-length');
    expect(c.from.length).toBe(c.to.length);
    expect(Math.abs(signedArea(c.from))).toBeCloseTo(10000, 6);
    expect(Math.abs(signedArea(c.to))).toBeCloseTo(Math.abs(signedArea(circle)), 6);
    const mid = interpolateGeometry(poly(square), poly(circle), 0.5, c);
    const a = area(mid);
    expect(a).toBeGreaterThan(Math.abs(signedArea(circle)) * 0.95);
    expect(a).toBeLessThan(10000 * 1.05);
  });

  it('flips a polyline drawn end for end', () => {
    const a: Point[] = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 100, y: 0 },
    ];
    const b: Point[] = [
      { x: 100, y: 10 },
      { x: 0, y: 10 },
    ];
    const c = polylineCorrespondence(a, b);
    const mid = interpolateGeometry(
      { type: 'polyline', points: a },
      { type: 'polyline', points: b },
      0.5,
      c,
    );
    expect(mid.type === 'polyline' && mid.points[0]).toEqual({ x: 0, y: 5 });
    expect(mid.type === 'polyline' && mid.points[mid.points.length - 1]).toEqual({ x: 100, y: 5 });
  });
});

describe('createFrameMaterializer', () => {
  it('builds annotations per frame and keeps identity for held samples', () => {
    const tracks = [
      createTrack({
        id: createTrackId('a'),
        geometryType: 'rectangle',
        keyframes: [kf(0, rect(0, 0, 1, 1)), kf(10, rect(10, 0, 1, 1))],
      }),
      createTrack({
        id: createTrackId('b'),
        geometryType: 'rectangle',
        keyframes: [kf(0, rect(5, 5, 1, 1))],
      }),
    ];
    let builds = 0;
    const m = createFrameMaterializer((t: TrackBase, s) => {
      builds++;
      return { id: t.id, geometry: s.geometry };
    });
    const f3 = m(tracks, 3);
    const f4 = m(tracks, 4);
    expect(f3.map((a) => a.id)).toEqual(['a', 'b']);
    expect(f4[1]).toBe(f3[1]);
    expect(f4[0]).not.toBe(f3[0]);
    expect(builds).toBe(3);
  });
});
