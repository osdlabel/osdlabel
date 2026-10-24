import { describe, expect, it } from 'vitest';
import {
  chooseExecutionProvider,
  type EpProbe,
  type GpuAdapterLike,
  type GpuLike,
  type ProbeEp,
} from '../../src/index.js';

const gpu = (adapter: GpuAdapterLike | null | Error): GpuLike => ({
  requestAdapter: () =>
    adapter instanceof Error ? Promise.reject(adapter) : Promise.resolve(adapter),
});

/** A probe answering fixed times per EP; records which EPs it ran. */
function probe(times: Partial<Record<ProbeEp, number | Error>>): EpProbe & { ran: ProbeEp[] } {
  const ran: ProbeEp[] = [];
  const fn = async (ep: ProbeEp): Promise<number> => {
    ran.push(ep);
    const t = times[ep];
    if (t instanceof Error) throw t;
    if (t === undefined) throw new Error(`no time for ${ep}`);
    return t;
  };
  return Object.assign(fn, { ran });
}

const nvidia: GpuAdapterLike = {
  info: { vendor: 'nvidia', architecture: 'ampere', device: '', description: '' },
};

describe('chooseExecutionProvider (WebGPU gate)', () => {
  it('stays on WASM without navigator.gpu or an adapter', async () => {
    const p = probe({ wasm: 100, webgpu: 10 });
    expect(await chooseExecutionProvider(undefined, p)).toEqual({
      ep: 'wasm',
      reason: 'no-webgpu',
    });
    expect(await chooseExecutionProvider(gpu(null), p)).toEqual({
      ep: 'wasm',
      reason: 'no-adapter',
    });
    expect(await chooseExecutionProvider(gpu(new Error('blocked')), p)).toMatchObject({
      ep: 'wasm',
      reason: 'no-adapter',
      error: 'blocked',
    });
    expect(p.ran).toEqual([]);
  });

  it("never picks this sandbox's SwiftShader adapter, and does not even probe it", async () => {
    // What Chromium 153 headless reported in the PoC's bench.
    const swiftshader: GpuAdapterLike = {
      info: { vendor: 'google', architecture: 'swiftshader', device: '', description: '' },
    };
    const p = probe({ wasm: 100, webgpu: 1 });
    const v = await chooseExecutionProvider(gpu(swiftshader), p);
    expect(v).toMatchObject({ ep: 'wasm', reason: 'software-adapter' });
    expect(v.adapter?.architecture).toBe('swiftshader');
    expect(p.ran).toEqual([]);
    for (const description of ['llvmpipe (LLVM 15.0.7, 256 bits)', 'Microsoft Basic Render Driver'])
      expect(
        await chooseExecutionProvider(gpu({ info: { vendor: 'x', description } }), p),
      ).toMatchObject({ reason: 'software-adapter' });
  });

  it('rejects fallback adapters (new info flag and the older adapter flag)', async () => {
    const p = probe({ wasm: 100, webgpu: 1 });
    expect(
      await chooseExecutionProvider(gpu({ info: { vendor: 'intel', isFallbackAdapter: true } }), p),
    ).toMatchObject({ ep: 'wasm', reason: 'fallback-adapter' });
    expect(
      await chooseExecutionProvider(gpu({ info: { vendor: 'intel' }, isFallbackAdapter: true }), p),
    ).toMatchObject({ ep: 'wasm', reason: 'fallback-adapter' });
    expect(p.ran).toEqual([]);
  });

  it('picks WebGPU on a hardware adapter only when the probe is minSpeedup x faster', async () => {
    const fast = probe({ wasm: 180, webgpu: 50 });
    expect(await chooseExecutionProvider(gpu(nvidia), fast)).toMatchObject({
      ep: 'webgpu',
      reason: 'probe-faster',
      probe: { wasmMs: 180, webgpuMs: 50 },
    });
    expect(fast.ran).toEqual(['wasm', 'webgpu']);
    // An integrated GPU that only ties WASM is not worth the switch.
    expect(
      await chooseExecutionProvider(gpu(nvidia), probe({ wasm: 180, webgpu: 150 })),
    ).toMatchObject({ ep: 'wasm', reason: 'probe-slower' });
    expect(
      await chooseExecutionProvider(gpu(nvidia), probe({ wasm: 180, webgpu: 150 }), {
        minSpeedup: 1.1,
      }),
    ).toMatchObject({ ep: 'webgpu' });
  });

  it('falls back when a probe fails or the WebGPU probe overruns its budget', async () => {
    expect(
      await chooseExecutionProvider(gpu(nvidia), probe({ wasm: 100, webgpu: new Error('OOM') })),
    ).toMatchObject({ ep: 'wasm', reason: 'probe-failed', error: 'OOM', probe: { wasmMs: 100 } });
    expect(
      await chooseExecutionProvider(gpu(nvidia), probe({ wasm: new Error('no wasm') })),
    ).toMatchObject({ ep: 'wasm', reason: 'probe-failed' });
    let aborted = false;
    const hang: EpProbe = (ep, signal) =>
      ep === 'wasm'
        ? Promise.resolve(5)
        : new Promise((resolve) => {
            signal.addEventListener('abort', () => {
              aborted = true;
              resolve(1);
            });
          });
    const t0 = performance.now();
    const v = await chooseExecutionProvider(gpu(nvidia), hang, { minProbeBudgetMs: 30 });
    expect(v).toMatchObject({ ep: 'wasm', reason: 'probe-timeout', probe: { wasmMs: 5 } });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(aborted).toBe(true);
  });
});
