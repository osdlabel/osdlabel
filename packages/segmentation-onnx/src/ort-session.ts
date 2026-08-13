import type { SamSession, SamTensor } from './sam-tensor.js';

/**
 * The only file that touches `onnxruntime-web`. It is loaded via a dynamic
 * `import()` (so it stays out of the static graph and loads lazily) and typed
 * through a minimal local interface describing only the surface we use.
 */
interface OrtTensorLike {
  readonly data: Float32Array;
  readonly dims: readonly number[];
}
interface OrtModule {
  readonly Tensor: new (
    type: 'float32',
    data: Float32Array,
    dims: readonly number[],
  ) => OrtTensorLike;
  readonly InferenceSession: {
    create(
      path: string,
      options?: { executionProviders?: readonly string[] },
    ): Promise<{
      run(feeds: Record<string, OrtTensorLike>): Promise<Record<string, OrtTensorLike>>;
      release?(): Promise<void> | void;
    }>;
  };
  readonly env: { wasm: { wasmPaths?: string } };
}

export interface CreateOrtSessionOptions {
  /** ORT execution providers, e.g. `['webgpu', 'wasm']`. Defaults to `['wasm']`. */
  readonly executionProviders?: readonly string[];
  /** Where the `.wasm` runtime assets are served from (`ort.env.wasm.wasmPaths`). */
  readonly wasmPaths?: string;
}

/**
 * Loads `onnxruntime-web`, creates an `InferenceSession` for `modelUrl`, and
 * adapts it to the runtime-agnostic {@link SamSession} the decoder consumes
 * (converting {@link SamTensor} ↔ ORT tensors at the boundary).
 *
 * `onnxruntime-web` is a **runtime requirement** the consuming application must
 * install. It is deliberately not declared as a dependency or peer dependency of
 * this package, so the heavy prebuilt WASM never enters installs that only need
 * the runtime-agnostic logic (e.g. `buildDecoderFeeds` with a custom session).
 */
export async function createOrtSession(
  modelUrl: string,
  options?: CreateOrtSessionOptions,
): Promise<SamSession> {
  let ort: OrtModule;
  try {
    ort = (await import('onnxruntime-web')) as unknown as OrtModule;
  } catch (cause) {
    throw new Error(
      "createOrtSession requires 'onnxruntime-web' to be installed in the consuming app.",
      { cause },
    );
  }
  if (options?.wasmPaths !== undefined) {
    ort.env.wasm.wasmPaths = options.wasmPaths;
  }
  const session = await ort.InferenceSession.create(modelUrl, {
    executionProviders: options?.executionProviders ?? ['wasm'],
  });

  return {
    async run(feeds: Record<string, SamTensor>): Promise<Record<string, SamTensor>> {
      const ortFeeds: Record<string, OrtTensorLike> = {};
      for (const [name, tensor] of Object.entries(feeds)) {
        ortFeeds[name] = new ort.Tensor('float32', tensor.data, tensor.dims);
      }
      const outputs = await session.run(ortFeeds);
      const result: Record<string, SamTensor> = {};
      for (const [name, tensor] of Object.entries(outputs)) {
        result[name] = { data: tensor.data, dims: tensor.dims };
      }
      return result;
    },
    dispose(): void {
      void session.release?.();
    },
  };
}
