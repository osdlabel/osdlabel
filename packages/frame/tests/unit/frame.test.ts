import { describe, expect, it } from 'vitest';
import type { AnnotationId } from '@osdlabel/annotation';
import {
  annotatedFrameIndices,
  annotationsOnFrame,
  bucketByFrame,
  clampFrameIndex,
  frameIndexAtTime,
  frameRefAt,
  hasFrame,
  isOnFrame,
  reconcileFrameRefs,
  sameFrame,
  stepFrameIndex,
} from '../../src/index.js';
import type { FrameAxis, FrameRef, MaybeFramed } from '../../src/index.js';

const annId = (s: string): AnnotationId => s as AnnotationId;

function ann(id: string, frame?: FrameRef): MaybeFramed {
  return {
    id: annId(id),
    geometry: { type: 'point', position: { x: 0, y: 0 } },
    toolType: 'point',
    createdAt: '',
    updatedAt: '',
    ...(frame !== undefined ? { frame } : {}),
  };
}

describe('frame-ref', () => {
  it('treats an annotation without frame as series-level', () => {
    const a = ann('a');
    expect(hasFrame(a)).toBe(false);
    expect(isOnFrame(a, 0)).toBe(true);
    expect(isOnFrame(a, 299)).toBe(true);
  });

  it('places a framed annotation on exactly one frame', () => {
    const a = ann('a', { index: 4 });
    expect(hasFrame(a)).toBe(true);
    expect(isOnFrame(a, 4)).toBe(true);
    expect(isOnFrame(a, 5)).toBe(false);
  });

  it('compares by key when both refs have one, else by index', () => {
    expect(sameFrame({ index: 1, key: 'x' }, { index: 2, key: 'x' })).toBe(true);
    expect(sameFrame({ index: 1, key: 'x' }, { index: 1, key: 'y' })).toBe(false);
    expect(sameFrame({ index: 1 }, { index: 1, key: 'y' })).toBe(true);
  });
});

describe('frame-axis', () => {
  it('clamps and steps', () => {
    expect(clampFrameIndex(-3, 10)).toBe(0);
    expect(clampFrameIndex(12, 10)).toBe(9);
    expect(clampFrameIndex(Number.NaN, 10)).toBe(0);
    expect(clampFrameIndex(3.7, 10)).toBe(3);
    expect(stepFrameIndex(9, 1, 10, false)).toBe(9);
    expect(stepFrameIndex(9, 1, 10, true)).toBe(0);
    expect(stepFrameIndex(0, -1, 10, true)).toBe(9);
    expect(stepFrameIndex(0, -21, 10, true)).toBe(9);
  });

  it('finds the frame at a time from explicit times (variable rate)', () => {
    const axis: FrameAxis = { kind: 'temporal', count: 4, times: [0, 0.1, 0.15, 0.4] };
    expect(frameIndexAtTime(axis, -1)).toBe(0);
    expect(frameIndexAtTime(axis, 0.12)).toBe(1);
    expect(frameIndexAtTime(axis, 0.15)).toBe(2);
    expect(frameIndexAtTime(axis, 9)).toBe(3);
  });

  it('finds the frame at a time from a frame rate', () => {
    const axis: FrameAxis = { kind: 'temporal', count: 100, frameRate: 30 };
    expect(frameIndexAtTime(axis, 1)).toBe(30);
    expect(frameIndexAtTime(axis, 10)).toBe(99);
  });

  it('builds the ref an annotation drawn on a frame carries', () => {
    const series: FrameAxis = { kind: 'spatial', count: 3, keys: ['u0', 'u1', 'u2'] };
    expect(frameRefAt(series, 1)).toEqual({ index: 1, key: 'u1' });
    const cine: FrameAxis = { kind: 'temporal', count: 100, frameRate: 25 };
    expect(frameRefAt(cine, 50)).toEqual({ index: 50, time: 2 });
    expect(frameRefAt({ kind: 'spatial', count: 5 }, 7)).toEqual({ index: 4 });
  });
});

describe('frame-buckets', () => {
  const a0 = ann('a0', { index: 0 });
  const a1 = ann('a1', { index: 1 });
  const b1 = ann('b1', { index: 1 });
  const s = ann('s');

  it('groups by frame and keeps series-level annotations apart', () => {
    const buckets = bucketByFrame([a0, a1, b1]);
    expect(annotationsOnFrame(buckets, 1)).toEqual([a1, b1]);
    expect(annotationsOnFrame(buckets, 7)).toEqual([]);
    expect(annotatedFrameIndices(buckets)).toEqual([0, 1]);
  });

  it('returns the stored array (reference-stable) when there are no series-level annotations', () => {
    const buckets = bucketByFrame([a0, a1, b1]);
    expect(annotationsOnFrame(buckets, 1)).toBe(annotationsOnFrame(buckets, 1));
  });

  it('shows series-level annotations on every frame', () => {
    const buckets = bucketByFrame([s, a1]);
    expect(annotationsOnFrame(buckets, 0)).toBe(buckets.seriesLevel);
    expect(annotationsOnFrame(buckets, 1)).toEqual([s, a1]);
  });
});

describe('reconcileFrameRefs', () => {
  it('re-indexes by key and preserves identity of unmoved annotations', () => {
    const axis: FrameAxis = { kind: 'spatial', count: 3, keys: ['c', 'b', 'a'] };
    const moved = ann('m', { index: 0, key: 'a' });
    const stay = ann('s', { index: 1, key: 'b' });
    const series = ann('x');
    const r = reconcileFrameRefs([moved, stay, series], axis);
    expect(r.moved).toBe(1);
    expect(r.annotations[0]!.frame).toEqual({ index: 2, key: 'a' });
    expect(r.annotations[1]).toBe(stay);
    expect(r.annotations[2]).toBe(series);
    expect(r.orphaned).toEqual([]);
  });

  it('reports annotations whose key is not on the axis', () => {
    const axis: FrameAxis = { kind: 'spatial', count: 1, keys: ['a'] };
    const lost = ann('l', { index: 0, key: 'gone' });
    const r = reconcileFrameRefs([lost], axis);
    expect(r.orphaned).toEqual([lost]);
    expect(r.annotations[0]).toBe(lost);
  });

  it('re-indexes temporal annotations by time when the rate changes', () => {
    const drawnAt30: FrameRef = { index: 60, time: 2 };
    const axisAt25: FrameAxis = { kind: 'temporal', count: 100, frameRate: 25 };
    const r = reconcileFrameRefs([ann('t', drawnAt30)], axisAt25);
    expect(r.annotations[0]!.frame).toEqual({ index: 50, time: 2 });
  });
});
