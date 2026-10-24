/**
 * Whether to run on onnxruntime-web's WebGPU execution provider or stay on
 * WASM. "A WebGPU adapter exists" is not enough: headless and GPU-less
 * Chromium hands out SwiftShader, a CPU emulation of a GPU, which the PoC
 * measured 40-150x slower than WASM (a MobileSAM encode took 219 s against
 * 2 s). So the gate needs, in order:
 *
 * 1. `navigator.gpu` and an adapter;
 * 2. an adapter that is not a fallback adapter (`info.isFallbackAdapter`, or
 *    the older `adapter.isFallbackAdapter`) and does not describe itself as a
 *    software rasteriser (SwiftShader, llvmpipe, lavapipe, Microsoft Basic
 *    Render Driver);
 * 3. a short microbenchmark the app supplies — one representative run (e.g.
 *    one decode after a warm-up) on each EP — in which WebGPU beats WASM by
 *    `minSpeedup`, within a time budget (a slow GPU is not kept waiting on).
 *
 * The probe only runs when 1 and 2 pass, so a software adapter costs nothing.
 */

/** The adapter fields the gate reads; a `GPUAdapter` satisfies it. */
export interface GpuAdapterLike {
  readonly info?:
    | {
        readonly vendor?: string | undefined;
        readonly architecture?: string | undefined;
        readonly device?: string | undefined;
        readonly description?: string | undefined;
        readonly isFallbackAdapter?: boolean | undefined;
      }
    | undefined;
  /** Older Chromium exposed this on the adapter itself. */
  readonly isFallbackAdapter?: boolean | undefined;
}

/** `navigator.gpu`, structurally. */
export interface GpuLike {
  requestAdapter(options?: {
    powerPreference?: 'high-performance' | 'low-power';
  }): Promise<GpuAdapterLike | null>;
}

export type ProbeEp = 'webgpu' | 'wasm';

/**
 * Times one representative run on `ep` in ms, warm-up excluded (the app
 * creates a session, runs once untimed, then times one or a few runs).
 */
export type EpProbe = (ep: ProbeEp, signal: AbortSignal) => Promise<number>;

export interface AdapterSummary {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
  readonly isFallbackAdapter: boolean;
}

export type WasmReason =
  | 'no-webgpu'
  | 'no-adapter'
  | 'fallback-adapter'
  | 'software-adapter'
  | 'probe-failed'
  | 'probe-timeout'
  | 'probe-slower';

export interface ProbeTimes {
  readonly wasmMs: number;
  readonly webgpuMs?: number | undefined;
}

export type EpVerdict =
  | {
      readonly ep: 'webgpu';
      readonly reason: 'probe-faster';
      readonly adapter: AdapterSummary;
      readonly probe: ProbeTimes;
    }
  | {
      readonly ep: 'wasm';
      readonly reason: WasmReason;
      readonly adapter?: AdapterSummary | undefined;
      readonly probe?: ProbeTimes | undefined;
      readonly error?: string | undefined;
    };

export interface EpGateOptions {
  /** WebGPU must be at least this many times faster than WASM in the probe. Default 1.5. */
  readonly minSpeedup?: number | undefined;
  /**
   * The WebGPU probe is abandoned after `max(minProbeBudgetMs, wasmMs * 4)` ms
   * (warm-up included, since shader compilation is part of the first run).
   * Default 5000.
   */
  readonly minProbeBudgetMs?: number | undefined;
  /** Adapter strings that mean a software rasteriser. */
  readonly softwarePatterns?: readonly RegExp[] | undefined;
}

export const SOFTWARE_ADAPTER_PATTERNS: readonly RegExp[] = [
  /swiftshader/i,
  /llvmpipe/i,
  /lavapipe/i,
  /softpipe/i,
  /basic render/i,
  /software/i,
];

export function summarizeAdapter(adapter: GpuAdapterLike): AdapterSummary {
  const info = adapter.info ?? {};
  return {
    vendor: info.vendor ?? '',
    architecture: info.architecture ?? '',
    device: info.device ?? '',
    description: info.description ?? '',
    isFallbackAdapter: info.isFallbackAdapter === true || adapter.isFallbackAdapter === true,
  };
}

/** Whether an adapter is a software rasteriser, by its self-description. */
export function isSoftwareAdapter(
  summary: AdapterSummary,
  patterns: readonly RegExp[] = SOFTWARE_ADAPTER_PATTERNS,
): boolean {
  const text = [summary.vendor, summary.architecture, summary.device, summary.description].join(
    ' ',
  );
  return patterns.some((p) => p.test(text));
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Picks the execution provider: see the module comment for the three checks. */
export async function chooseExecutionProvider(
  gpu: GpuLike | null | undefined,
  probe: EpProbe,
  options: EpGateOptions = {},
): Promise<EpVerdict> {
  if (!gpu) return { ep: 'wasm', reason: 'no-webgpu' };
  let adapter: GpuAdapterLike | null;
  try {
    adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch (e) {
    return { ep: 'wasm', reason: 'no-adapter', error: message(e) };
  }
  if (!adapter) return { ep: 'wasm', reason: 'no-adapter' };
  const summary = summarizeAdapter(adapter);
  if (summary.isFallbackAdapter)
    return { ep: 'wasm', reason: 'fallback-adapter', adapter: summary };
  if (isSoftwareAdapter(summary, options.softwarePatterns))
    return { ep: 'wasm', reason: 'software-adapter', adapter: summary };

  const controller = new AbortController();
  let wasmMs: number;
  try {
    wasmMs = await probe('wasm', controller.signal);
  } catch (e) {
    return { ep: 'wasm', reason: 'probe-failed', adapter: summary, error: message(e) };
  }
  const budget = Math.max(options.minProbeBudgetMs ?? 5000, wasmMs * 4);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), budget);
  });
  let webgpu: number | 'timeout';
  try {
    webgpu = await Promise.race([probe('webgpu', controller.signal), timeout]);
  } catch (e) {
    return {
      ep: 'wasm',
      reason: 'probe-failed',
      adapter: summary,
      probe: { wasmMs },
      error: message(e),
    };
  } finally {
    clearTimeout(timer);
  }
  if (webgpu === 'timeout') {
    controller.abort();
    return { ep: 'wasm', reason: 'probe-timeout', adapter: summary, probe: { wasmMs } };
  }
  const times = { wasmMs, webgpuMs: webgpu };
  if (webgpu * (options.minSpeedup ?? 1.5) <= wasmMs)
    return { ep: 'webgpu', reason: 'probe-faster', adapter: summary, probe: times };
  return { ep: 'wasm', reason: 'probe-slower', adapter: summary, probe: times };
}
