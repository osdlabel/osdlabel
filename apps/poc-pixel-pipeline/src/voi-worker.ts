/// <reference lib="webworker" />
import { applyVoiLutRgba32 } from '@osdlabel/pixel';
import type { StoredPixelArray } from '@osdlabel/pixel';

/**
 * Worker for the H2 worker-pool variant: applies a LUT (in a
 * SharedArrayBuffer) to its slice of a shared stored-value buffer, writing
 * packed RGBA into a shared output buffer.
 */
interface InitMessage {
  readonly type: 'init';
  readonly src: SharedArrayBuffer;
  readonly signed: boolean;
  readonly dst: SharedArrayBuffer;
}

interface ApplyMessage {
  readonly type: 'apply';
  readonly lut: SharedArrayBuffer;
  readonly min: number;
  readonly start: number;
  readonly end: number;
}

let src: StoredPixelArray | null = null;
let dst: Uint32Array | null = null;

self.onmessage = (e: MessageEvent<InitMessage | ApplyMessage>): void => {
  const m = e.data;
  if (m.type === 'init') {
    src = m.signed ? new Int16Array(m.src) : new Uint16Array(m.src);
    dst = new Uint32Array(m.dst);
    self.postMessage({ type: 'ready' });
    return;
  }
  if (!src || !dst) return;
  const t0 = performance.now();
  const rgba32 = new Uint32Array(m.lut);
  applyVoiLutRgba32(
    src,
    { range: { min: m.min, max: m.min + rgba32.length - 1 }, gray: new Uint8Array(0), rgba32 },
    dst,
    m.start,
    m.end,
  );
  self.postMessage({ type: 'done', ms: performance.now() - t0 });
};
