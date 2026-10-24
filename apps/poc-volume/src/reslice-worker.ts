/// <reference lib="webworker" />
import { reslice, type ScalarVolume } from '@osdlabel/volume';
import type { WorkerReply, WorkerRequest } from './reslice-protocol.js';

/**
 * Reslice worker: holds slice views over the main thread's SharedArrayBuffer
 * (no copy of the volume) and writes its share of rows straight into a
 * shared output buffer.
 */
declare const self: DedicatedWorkerGlobalScope;

let volume: ScalarVolume | null = null;
const outViews = new WeakMap<SharedArrayBuffer, Int16Array>();

const reply = (m: WorkerReply): void => self.postMessage(m);

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    const [nx, ny, nz] = msg.grid.dimensions;
    const per = nx * ny;
    const slices: Int16Array[] = [];
    for (let k = 0; k < nz; k++) slices.push(new Int16Array(msg.voxels, k * per * 2, per));
    volume = { grid: msg.grid, slices };
    reply({ type: 'ready' });
    return;
  }
  if (!volume) throw new Error('worker not initialised');
  let out = outViews.get(msg.out);
  if (!out) {
    out = new Int16Array(msg.out);
    outViews.set(msg.out, out);
  }
  const t0 = performance.now();
  const path = reslice(volume, msg.mapping, msg.width, msg.height, out, {
    interpolation: msg.interpolation,
    rowStart: msg.rowStart,
    rowEnd: msg.rowEnd,
  });
  reply({ type: 'done', id: msg.id, ms: performance.now() - t0, path });
};
