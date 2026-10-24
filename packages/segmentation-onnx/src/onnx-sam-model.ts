import type { RgbaImage } from '@osdlabel/region-reader';
import type { MaskCandidate, ModelFrame, SegmentationPrompt } from '@osdlabel/segmentation';
import {
  adapterFor,
  alignPreviousMask,
  type FamilyAdapter,
  type ModelFamily,
  type PreviousMaskAlignment,
  type SamEmbedding,
} from './families.js';
import type {
  OrtModuleLike,
  OrtSessionLike,
  OrtSessionOptionsLike,
  OrtTensorLike,
} from './ort-like.js';
import { float32Data } from './ort-like.js';
import { rgbaToChw } from './preprocess.js';

export interface OnnxSamModelSpec {
  readonly family: ModelFamily;
  readonly inputSize: number;
  /** URL (or bytes) of the image encoder. Omit for decode-only use (remote encode). */
  readonly encoder?: string | Uint8Array | undefined;
  readonly decoder: string | Uint8Array;
}

export interface OnnxSamLoadOptions {
  readonly encoderSession?: OrtSessionOptionsLike | undefined;
  readonly decoderSession?: OrtSessionOptionsLike | undefined;
  /**
   * A previous result (SAM `mask_input`) on another grid than the embedding
   * being decoded, as after a pan/zoom re-encode during refinement: resample
   * it onto the grid (default) or drop it. It is never copied misaligned.
   */
  readonly previousMask?: PreviousMaskAlignment | undefined;
}

/**
 * One SAM-family model on onnxruntime: the encoder and decoder sessions plus
 * the graph conventions of its family. Knows nothing of viewers, crops or
 * caches — {@link createOnnxEncoder} / {@link createOnnxDecoder} adapt it to
 * the `@osdlabel/segmentation` contract.
 */
export class OnnxSamModel<T extends OrtTensorLike = OrtTensorLike> {
  readonly family: ModelFamily;
  readonly inputSize: number;
  readonly adapter: FamilyAdapter;
  /** Session creation times (download + graph optimisation + compile), ms. */
  readonly loadTimings: Readonly<Record<string, number>>;
  private readonly ort: OrtModuleLike<T>;
  private readonly encoder: OrtSessionLike<T> | null;
  private readonly decoder: OrtSessionLike<T>;
  private readonly previousMask: PreviousMaskAlignment;

  private constructor(
    ort: OrtModuleLike<T>,
    spec: OnnxSamModelSpec,
    encoder: OrtSessionLike<T> | null,
    decoder: OrtSessionLike<T>,
    loadTimings: Record<string, number>,
    previousMask: PreviousMaskAlignment,
  ) {
    this.ort = ort;
    this.previousMask = previousMask;
    this.family = spec.family;
    this.inputSize = spec.inputSize;
    this.adapter = adapterFor(spec.family);
    this.encoder = encoder;
    this.decoder = decoder;
    this.loadTimings = loadTimings;
  }

  static async load<T extends OrtTensorLike>(
    ort: OrtModuleLike<T>,
    spec: OnnxSamModelSpec,
    options?: OnnxSamLoadOptions,
  ): Promise<OnnxSamModel<T>> {
    const t0 = performance.now();
    const encoder = spec.encoder
      ? await ort.createSession(spec.encoder, options?.encoderSession)
      : null;
    const t1 = performance.now();
    const decoder = await ort.createSession(spec.decoder, options?.decoderSession);
    const t2 = performance.now();
    return new OnnxSamModel(
      ort,
      spec,
      encoder,
      decoder,
      { encoderLoad: t1 - t0, decoderLoad: t2 - t1 },
      options?.previousMask ?? 'resample',
    );
  }

  get canEncode(): boolean {
    return this.encoder !== null;
  }

  /** Encodes pixels that already match `frame` (contentWidth x contentHeight). */
  async encode(
    pixels: RgbaImage,
    frame: ModelFrame,
  ): Promise<{ embedding: SamEmbedding; timings: Record<string, number> }> {
    if (!this.encoder) throw new Error('this model was loaded without an encoder');
    const t0 = performance.now();
    const input = rgbaToChw(pixels, this.inputSize, this.adapter.normalization);
    const t1 = performance.now();
    const outputs = await this.encoder.run(
      this.adapter.encoderFeeds(this.ort, this.encoder, input, this.inputSize),
    );
    const t2 = performance.now();
    const tensors = this.adapter.embeddingNames.map((name) => {
      const t = outputs[name];
      return { name, dims: t?.dims ?? [], data: float32Data(t, name) };
    });
    return {
      embedding: { family: this.family, frame, tensors },
      timings: { preprocess: t1 - t0, encode: t2 - t1 },
    };
  }

  async decode(
    embedding: SamEmbedding,
    prompt: SegmentationPrompt,
  ): Promise<{ candidates: MaskCandidate[]; timings: Record<string, number> }> {
    const t0 = performance.now();
    const aligned = alignPreviousMask(prompt, embedding, this.previousMask);
    const feeds = this.adapter.decoderFeeds(this.ort, this.decoder, embedding, aligned);
    const outputs = await this.decoder.run(feeds, this.adapter.decoderFetches());
    const t1 = performance.now();
    const candidates = this.adapter.candidates(outputs, embedding, prompt);
    const t2 = performance.now();
    // 1 when the previous logits were fed back as mask_input (diagnostic).
    const has = feeds['has_mask_input'];
    const maskInput = has ? (float32Data(has, 'has_mask_input')[0] ?? 0) : 0;
    return { candidates, timings: { decode: t1 - t0, decodeOutputs: t2 - t1, maskInput } };
  }

  async release(): Promise<void> {
    await this.encoder?.release();
    await this.decoder.release();
  }
}
