/**
 * The structural subset of `onnxruntime-web` this package uses. Typing it
 * locally keeps ORT out of the package's dependencies: the host imports the
 * build it wants (`onnxruntime-web/wasm`, `/webgpu`, …) and passes the module
 * in, so the heavy runtime is never pulled in transitively.
 */
export type OrtTensorType = 'float32' | 'int64';

export interface OrtTensorLike {
  readonly type: string;
  readonly dims: readonly number[];
  readonly data: unknown;
  dispose?(): void;
}

export interface OrtSessionOptionsLike {
  readonly executionProviders?: readonly string[];
  readonly graphOptimizationLevel?: 'disabled' | 'basic' | 'extended' | 'all';
  readonly enableCpuMemArena?: boolean;
}

export interface OrtSessionLike {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(
    feeds: Record<string, OrtTensorLike>,
    fetches?: readonly string[],
  ): Promise<Record<string, OrtTensorLike>>;
  release(): Promise<void>;
}

export interface OrtEnvLike {
  readonly wasm: {
    numThreads?: number;
    wasmPaths?: string | Record<string, string>;
    proxy?: boolean;
  };
}

export interface OrtModuleLike {
  readonly env: OrtEnvLike;
  readonly InferenceSession: {
    create(model: string | Uint8Array, options?: OrtSessionOptionsLike): Promise<OrtSessionLike>;
  };
  readonly Tensor: new (
    type: OrtTensorType,
    data: Float32Array | BigInt64Array,
    dims: readonly number[],
  ) => OrtTensorLike;
}

export function float32Data(t: OrtTensorLike | undefined, name: string): Float32Array {
  if (!t) throw new Error(`model output '${name}' missing`);
  if (!(t.data instanceof Float32Array)) throw new Error(`model output '${name}' is ${t.type}, not float32`);
  return t.data;
}
