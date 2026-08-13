/**
 * A minimal, runtime-agnostic tensor: a flat `Float32Array` plus its shape.
 * Used so the decode logic never depends on `onnxruntime-web` directly — the
 * ORT adapter ({@link import('./ort-session.js').createOrtSession}) converts
 * `SamTensor` to/from ORT tensors at the boundary, and tests inject a fake
 * {@link SamSession} that speaks `SamTensor`.
 */
export interface SamTensor {
  readonly data: Float32Array;
  readonly dims: readonly number[];
}

/**
 * The seam between the decoder logic and the actual inference runtime. A real
 * session wraps `onnxruntime-web`; tests provide a deterministic fake.
 */
export interface SamSession {
  run(feeds: Record<string, SamTensor>): Promise<Record<string, SamTensor>>;
  /** Release the underlying runtime session, if any. */
  dispose?(): void;
}
