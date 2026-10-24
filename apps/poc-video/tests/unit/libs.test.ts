import { describe, expect, it } from 'vitest';
import { readFrameCode, writeFrameCode } from '../../src/lib/frame-code.js';
import type { PacketInfo } from '../../src/lib/frame-table.js';
import { buildFrameTable, frameOfTimestamp, startKeyFor } from '../../src/lib/frame-table.js';
import { LruCache } from '../../src/lib/lru-cache.js';

describe('frame code', () => {
  it('round-trips every value and rejects a blended frame', () => {
    for (const v of [0, 1, 2, 29, 30, 255, 256, 299, 65535]) {
      expect(readFrameCode(writeFrameCode(v)).value).toBe(v);
    }
    // 50/50 blend of two frames (what a decoder never shows, a scaler might).
    const a = writeFrameCode(5);
    const b = writeFrameCode(6);
    const mix = new Uint8ClampedArray(a.data.length);
    for (let i = 0; i < mix.length; i++) mix[i] = (a.data[i]! + b.data[i]!) / 2;
    expect(readFrameCode({ ...a, data: mix }).value).toBe(-1);
  });
});

/** IPBB-style decode order: I0 P3 B1 B2 P6 B4 B5 | I7 ... */
function packets(): PacketInfo[] {
  const order = [0, 3, 1, 2, 6, 4, 5, 7, 10, 8, 9];
  return order.map((f, j) => ({
    timestampUs: f * 33333,
    durationUs: 33333,
    key: f === 0 || f === 7,
    decodeIndex: j,
  }));
}

describe('frame table', () => {
  it('orders frames by presentation and finds the start key in decode order', () => {
    const t = buildFrameTable(packets());
    expect(t.frames.map((p) => p.timestampUs / 33333)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(t.frames[2]!.decodeIndex).toBe(3);
    expect(startKeyFor(t, 0)).toBe(0);
    expect(startKeyFor(t, 6)).toBe(0);
    expect(startKeyFor(t, 7)).toBe(7);
    expect(startKeyFor(t, 9)).toBe(7);
    expect(frameOfTimestamp(t, 5 * 33333)).toBe(5);
    expect(frameOfTimestamp(t, 5 * 33333 + 400)).toBe(-1);
  });
  it('rejects a stream that does not start on a key packet', () => {
    const p = packets().map((x, j) => (j === 0 ? { ...x, key: false } : x));
    expect(() => buildFrameTable(p)).toThrow();
  });
});

describe('LruCache', () => {
  it('evicts least recently used by count and bytes, disposing what it drops', () => {
    const dropped: number[] = [];
    const c = new LruCache<number, string>(3, 100, (_v, k) => dropped.push(k));
    c.set(1, 'a', 10);
    c.set(2, 'b', 10);
    c.set(3, 'c', 10);
    c.get(1);
    c.set(4, 'd', 10);
    expect(dropped).toEqual([2]);
    c.set(5, 'e', 90);
    expect(c.bytes).toBeLessThanOrEqual(100);
    expect(c.has(5)).toBe(true);
    expect(c.peakEntries).toBe(3);
    const none = new LruCache<number, string>(0, 100, (_v, k) => dropped.push(k));
    none.set(9, 'z', 1);
    expect(none.size).toBe(0);
    expect(dropped).toContain(9);
  });
});
