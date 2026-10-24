import type { PlaneIndexMapping, VolumeGrid } from '@osdlabel/spatial';
import type { Interpolation } from '@osdlabel/volume';
import type { JobMessage, WorkerReply } from './reslice-protocol.js';

/**
 * N workers sharing the volume's SharedArrayBuffer; one plane is split into
 * N row bands. `run` resolves when every band is written.
 */
export class ReslicePool {
  private readonly workers: Worker[] = [];
  private nextId = 1;
  private readonly pending = new Map<number, () => void>();
  readonly ready: Promise<void>;

  constructor(
    readonly size: number,
    grid: VolumeGrid,
    voxels: SharedArrayBuffer,
  ) {
    const readies: Promise<void>[] = [];
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('./reslice-worker.ts', import.meta.url), { type: 'module' });
      readies.push(
        new Promise<void>((resolve) => {
          w.onmessage = (e: MessageEvent<WorkerReply>) => {
            const m = e.data;
            if (m.type === 'ready') resolve();
            else this.pending.get(m.id)?.();
          };
        }),
      );
      w.postMessage({ type: 'init', grid, voxels });
      this.workers.push(w);
    }
    this.ready = Promise.all(readies).then(() => undefined);
  }

  run(
    mapping: PlaneIndexMapping,
    width: number,
    height: number,
    out: SharedArrayBuffer,
    interpolation: Interpolation,
  ): Promise<void> {
    const n = this.workers.length;
    const band = Math.ceil(height / n);
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < n; i++) {
      const rowStart = i * band;
      const rowEnd = Math.min(height, rowStart + band);
      if (rowStart >= rowEnd) continue;
      const id = this.nextId++;
      jobs.push(
        new Promise<void>((resolve) => {
          this.pending.set(id, () => {
            this.pending.delete(id);
            resolve();
          });
        }),
      );
      const msg: JobMessage = {
        type: 'job',
        id,
        mapping,
        width,
        height,
        out,
        rowStart,
        rowEnd,
        interpolation,
      };
      this.workers[i]!.postMessage(msg);
    }
    return Promise.all(jobs).then(() => undefined);
  }

  terminate(): void {
    for (const w of this.workers) w.terminate();
  }
}
