import type { VolumeGrid } from '@osdlabel/spatial';
import {
  allocateScalarVolume,
  contiguousVoxels,
  fillSheppLoganPhantom,
  type ScalarVolume,
} from '@osdlabel/volume';

/** Page query parameters shared by every PoC page. */
export function param(name: string, fallback: string): string {
  return new URLSearchParams(location.search).get(name) ?? fallback;
}

export function intParam(name: string, fallback: number): number {
  const v = Number(param(name, String(fallback)));
  return Number.isFinite(v) ? v : fallback;
}

/**
 * The synthetic CT: 512 x 512 x 400 int16 at 0.7 x 0.7 x 1.25 mm (~210 MB),
 * LPS-aligned, centred on the patient origin. `?nx=&ny=&nz=` shrink it for a
 * quick run.
 */
export function makeGrid(): VolumeGrid {
  const nx = intParam('nx', 512);
  const ny = intParam('ny', 512);
  const nz = intParam('nz', 400);
  const spacing = [0.7, 0.7, 1.25] as const;
  return {
    dimensions: [nx, ny, nz],
    spacing,
    origin: [
      (-(nx - 1) * spacing[0]) / 2,
      (-(ny - 1) * spacing[1]) / 2,
      (-(nz - 1) * spacing[2]) / 2,
    ],
    direction: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
  };
}

export interface BuiltVolume {
  readonly volume: ScalarVolume;
  /** All voxels as one view (the volume is allocated contiguous). */
  readonly voxels: Int16Array;
  readonly buffer: SharedArrayBuffer;
  readonly allocMs: number;
  readonly fillMs: number;
}

export function buildVolume(grid: VolumeGrid = makeGrid()): BuiltVolume {
  const t0 = performance.now();
  const volume = allocateScalarVolume(grid, { shared: true });
  const t1 = performance.now();
  fillSheppLoganPhantom(volume);
  const t2 = performance.now();
  const voxels = contiguousVoxels(volume);
  if (!voxels || !(voxels.buffer instanceof SharedArrayBuffer)) {
    throw new Error('expected a contiguous SharedArrayBuffer volume');
  }
  return { volume, voxels, buffer: voxels.buffer, allocMs: t1 - t0, fillMs: t2 - t1 };
}

/** Summary statistics of a list of samples (ms). */
export interface Stats {
  readonly n: number;
  readonly median: number;
  readonly p95: number;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
}

export function stats(samples: readonly number[]): Stats {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? NaN;
  const mean = s.reduce((a, b) => a + b, 0) / Math.max(1, s.length);
  return {
    n: s.length,
    median: at(0.5),
    p95: at(0.95),
    mean,
    min: s[0] ?? NaN,
    max: s[s.length - 1] ?? NaN,
  };
}

/**
 * Count WebGL contexts the page creates, by wrapping getContext before any
 * library runs. Each canvas that returns a new webgl/webgl2 context counts
 * once; `webglcontextlost` events are counted too.
 */
export interface ContextCounter {
  readonly created: () => number;
  readonly lost: () => number;
  readonly byKind: () => Record<string, number>;
}

export function installContextCounter(): ContextCounter {
  const seen = new WeakSet<object>();
  const kinds: Record<string, number> = {};
  let created = 0;
  let lost = 0;
  const wrap = <T extends { getContext: (...args: never[]) => unknown }>(proto: T): void => {
    const original = proto.getContext;
    const patched = function (this: HTMLCanvasElement | OffscreenCanvas, ...args: unknown[]) {
      const ctx = (original as (...a: unknown[]) => unknown).apply(this, args);
      const kind = String(args[0]);
      if (ctx && (kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl')) {
        if (!seen.has(ctx)) {
          seen.add(ctx);
          created++;
          kinds[kind] = (kinds[kind] ?? 0) + 1;
          this.addEventListener('webglcontextlost', () => {
            lost++;
          });
        }
      }
      return ctx;
    };
    (proto as { getContext: unknown }).getContext = patched;
  };
  wrap(HTMLCanvasElement.prototype);
  if (typeof OffscreenCanvas !== 'undefined') wrap(OffscreenCanvas.prototype);
  return { created: () => created, lost: () => lost, byKind: () => ({ ...kinds }) };
}

/** `performance.measureUserAgentSpecificMemory` where available (cross-origin isolated only). */
export async function uaMemory(): Promise<number | null> {
  const perf = performance as Performance & {
    measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
  };
  if (!perf.measureUserAgentSpecificMemory) return null;
  try {
    return (await perf.measureUserAgentSpecificMemory()).bytes;
  } catch {
    return null;
  }
}

export const nextFrame = (): Promise<number> =>
  new Promise((resolve) => requestAnimationFrame((t) => resolve(t)));
