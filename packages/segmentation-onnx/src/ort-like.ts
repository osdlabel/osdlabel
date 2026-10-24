/**
 * The structural subset of `onnxruntime-web` this package uses. Typing it
 * locally keeps ORT out of the package's dependencies: the host imports the
 * build it wants (`onnxruntime-web/wasm`, `/webgpu`, …) and hands over a
 * small adapter, so the heavy runtime is never pulled in transitively.
 *
 * Generic over the runtime's tensor type `T`, so an adapter over the real
 * `onnxruntime-web` types needs no casts: tensors this package creates are
 * the ones it feeds back to the same runtime.
 */
export interface OrtTensorLike {
  readonly type: string;
  readonly dims: readonly number[];
  readonly data: unknown;
}

export interface OrtSessionOptionsLike {
  readonly executionProviders?: readonly string[];
  readonly graphOptimizationLevel?: 'disabled' | 'basic' | 'extended' | 'all';
}

export interface OrtSessionLike<T extends OrtTensorLike = OrtTensorLike> {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, T>, fetches?: readonly string[]): Promise<Record<string, T>>;
  release(): Promise<void>;
}

export interface OrtModuleLike<T extends OrtTensorLike = OrtTensorLike> {
  createSession(
    model: string | Uint8Array,
    options?: OrtSessionOptionsLike,
  ): Promise<OrtSessionLike<T>>;
  float32(data: Float32Array, dims: readonly number[]): T;
  int64(data: BigInt64Array, dims: readonly number[]): T;
}

export function float32Data(t: OrtTensorLike | undefined, name: string): Float32Array {
  if (!t) throw new Error(`model output '${name}' missing`);
  if (!(t.data instanceof Float32Array))
    throw new Error(`model output '${name}' is ${t.type}, not float32`);
  return t.data;
}
