import type { FrameDecoder } from '@osdlabel/dicom-wsi';

const J2K = new Set([
  '1.2.840.10008.1.2.4.90', // JPEG 2000 lossless
  '1.2.840.10008.1.2.4.91', // JPEG 2000
]);

interface Pending {
  resolve: (b: ImageBitmap) => void;
  reject: (e: Error) => void;
}

/**
 * A FrameDecoder backed by a pool of OpenJPEG WASM workers — what a host
 * registers when its slides are JPEG 2000. Lives in the app, not in
 * `@osdlabel/dicom-wsi`: the codec (~260 KB WASM) is the host's choice.
 */
export function createJ2kWorkerDecoder(
  size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)),
): FrameDecoder & {
  readonly workerMs: number[];
} {
  const workers = Array.from(
    { length: size },
    () => new Worker(new URL('./j2k-worker.ts', import.meta.url), { type: 'module' }),
  );
  const pending = new Map<number, Pending>();
  const workerMs: number[] = [];
  let next = 0;
  for (const w of workers) {
    w.onerror = (ev) => {
      console.error('j2k worker error', ev.message);
      for (const [id, p] of pending) {
        pending.delete(id);
        p.reject(new Error(`j2k worker: ${ev.message}`));
      }
    };
    w.onmessage = (
      ev: MessageEvent<{ id: number; bitmap?: ImageBitmap; ms?: number; error?: string }>,
    ) => {
      const p = pending.get(ev.data.id);
      if (!p) return;
      pending.delete(ev.data.id);
      if (ev.data.bitmap) {
        if (ev.data.ms !== undefined) workerMs.push(ev.data.ms);
        p.resolve(ev.data.bitmap);
      } else p.reject(new Error(ev.data.error ?? 'decode failed'));
    };
  }
  return {
    name: `openjpeg-wasm×${size}`,
    workerMs,
    canDecode: (ts) => J2K.has(ts),
    decode(frame) {
      const id = next++;
      const copy = frame.slice();
      return new Promise<ImageBitmap>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        workers[id % workers.length]!.postMessage({ id, bytes: copy }, [copy.buffer]);
      });
    },
  };
}
