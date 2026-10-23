import { describe, expect, it } from 'vitest';
import { analyzeDisplayLog, resolveLanding } from '../../src/instrument/display-log.js';
import type { DisplayEvent } from '../../src/instrument/display-log.js';
import { percentileSorted, summarize } from '../../src/instrument/stats.js';
import {
  decodeFrameMarker,
  markerBlockCenter,
  MARKER_BITS,
  stampFrameMarker,
} from '../../src/data/marker.js';
import { lesionsOnSlice, renderCtSlice } from '../../src/data/ct-phantom.js';
import { chamberAt, renderUltrasoundFrame } from '../../src/data/ultrasound.js';
import { fixtureGeometry, FIXTURE_TYPES } from '../../src/annotations/fixtures.js';

const ev = (kind: DisplayEvent['kind'], frame: number, seq: number, t: number): DisplayEvent => ({
  kind,
  frame,
  seq,
  t,
});

describe('analyzeDisplayLog', () => {
  it('measures latency from apply to the draw that showed it', () => {
    const a = analyzeDisplayLog([
      ev('img', 0, 1, 0),
      ev('apply', 1, 2, 30),
      ev('img', 1, 3, 50),
      ev('apply', 2, 4, 70),
      ev('img', 2, 4, 75),
    ]);
    expect(a.delivered).toBe(2);
    expect(a.latencyMs).toEqual([20, 5]);
    expect(a.latencyFrames).toEqual([1, 0]);
    expect(a.slicesShown).toBe(2);
  });

  it('counts superseded applies, blank and incoherent frames', () => {
    const a = analyzeDisplayLog([
      ev('img', 0, 1, 0),
      ev('ann', 0, 1, 1),
      ev('apply', 1, 2, 10),
      ev('apply', 2, 2, 12),
      ev('img', -1, 2, 15),
      ev('img', 2, 3, 30),
      ev('ann', 1, 3, 31),
    ]);
    expect(a.superseded).toBe(1);
    expect(a.blankFrames).toBe(1);
    expect(a.incoherentFrames).toBe(1);
    // A blank flash between two real frames is not a slice shown.
    expect(a.imageChanges).toBe(2);
    expect(a.slicesShown).toBe(1);
  });
});

describe('resolveLanding', () => {
  it('lands work outside rAF in the current frame only if a later callback of it ran', () => {
    const log = [
      { seq: 5, start: 100, last: 104 },
      { seq: 6, start: 116, last: 116 },
    ];
    const out = resolveLanding(
      [
        { kind: 'apply', frame: 1, seq: 5, t: 102, inRaf: false },
        { kind: 'apply', frame: 2, seq: 5, t: 105, inRaf: false },
        { kind: 'img', frame: 2, seq: 6, t: 117, inRaf: true },
      ],
      log,
    );
    expect(out.map((e) => e.seq)).toEqual([5, 6, 6]);
  });
});

describe('stats', () => {
  it('interpolates percentiles', () => {
    expect(percentileSorted([1, 2, 3, 4], 0.5)).toBe(2.5);
    const s = summarize([5, 1, 3]);
    expect(s).toMatchObject({ n: 3, min: 1, max: 5, p50: 3, mean: 3 });
  });
});

describe('frame marker', () => {
  it('round-trips a frame index through the barcode, in gray and RGBA', () => {
    for (const channels of [1, 4] as const) {
      const w = 128;
      const data = new Uint8ClampedArray(w * 32 * channels);
      stampFrameMarker(data, w, channels, 299);
      const samples: number[] = [];
      for (let b = 0; b <= MARKER_BITS; b++) {
        const c = markerBlockCenter(b);
        samples.push(data[(Math.floor(c.y) * w + Math.floor(c.x)) * channels] ?? 0);
      }
      expect(decodeFrameMarker(samples)).toBe(299);
    }
    expect(decodeFrameMarker([0, 255])).toBe(-1);
  });
});

describe('synthetic data', () => {
  it('renders distinct, deterministic CT slices carrying their index', () => {
    const a = renderCtSlice(10, 300, 128, 128, new Uint8Array(128 * 128));
    const b = renderCtSlice(10, 300, 128, 128, new Uint8Array(128 * 128));
    const c = renderCtSlice(150, 300, 128, 128, new Uint8Array(128 * 128));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(lesionsOnSlice(90, 300, 512, 512).length).toBeGreaterThan(0);
  });

  it('renders a moving ultrasound loop', () => {
    const f0 = renderUltrasoundFrame(0, 160, 120, new Uint8ClampedArray(160 * 120 * 4));
    const f5 = renderUltrasoundFrame(5, 160, 120, new Uint8ClampedArray(160 * 120 * 4));
    expect(f0).not.toEqual(f5);
    expect(chamberAt(0, 800, 600).rx).not.toBe(chamberAt(6, 800, 600).rx);
  });

  it('places N fixture annotations of every vector type', () => {
    const specs = fixtureGeometry(3, 12, 512, 512);
    expect(specs).toHaveLength(12);
    expect(new Set(specs.map((s) => s.geometry.type))).toEqual(new Set(FIXTURE_TYPES));
    expect(specs.every((s) => s.frame === 3)).toBe(true);
  });
});
