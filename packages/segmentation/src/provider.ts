import type {
  EncodeView,
  ImageRegion,
  ImageSize,
  SegmentationImageKey,
  SegmentationPrompt,
  SegmentationResult,
  MaskCandidate,
} from './types.js';

/** What a provider can do, so a tool can hide what it cannot. */
export interface ProviderCapabilities {
  readonly box: boolean;
  readonly negativePoints: boolean;
  /** Returns several candidates for an ambiguous prompt. */
  readonly multimask: boolean;
  /** Accepts the previous result as a refinement hint. */
  readonly maskInput: boolean;
  /**
   * Side of one encode in model pixels (SAM: 1024, LiteMedSAM: 256), or
   * `null` when the provider is not crop-based (a server that segments the
   * whole image or volume itself).
   */
  readonly inputSize: number | null;
}

/**
 * Where the user is: the provider decides what to encode from this. The
 * viewport is what the screen shows (image px, clipped to the image);
 * `viewportScale` is screen px per image px, so a provider can tell an
 * embedding has become too coarse for the current zoom.
 */
export interface SegmentationTarget {
  readonly imageKey: SegmentationImageKey;
  readonly imageSize: ImageSize;
  readonly viewport: ImageRegion;
  readonly viewportScale: number;
}

/**
 * The contract every assisted-segmentation backend implements, whatever its
 * topology: all in the browser (worker), encode on a server and decode in the
 * browser, or all on a server (MONAI Label, nnInteractive).
 *
 * `prepare` lets the tool start the expensive encode as soon as the user
 * settles on a view, so the first click only pays for the decode.
 */
export interface SegmentationProvider {
  readonly capabilities: ProviderCapabilities;
  prepare?(target: SegmentationTarget, signal: AbortSignal): Promise<void>;
  segment(
    target: SegmentationTarget,
    prompt: SegmentationPrompt,
    signal: AbortSignal,
  ): Promise<SegmentationResult>;
  dispose?(imageKey?: SegmentationImageKey): void;
}

/** The output of an encode: an opaque embedding plus what it covers. */
export interface EncodedView<TEmbedding> {
  readonly view: EncodeView;
  readonly embedding: TEmbedding;
  /** Approximate memory held by the embedding, for the cache's budget. */
  readonly bytes: number;
  readonly timings?: Readonly<Record<string, number>> | undefined;
}

/**
 * The expensive half. Reads the view's pixels however it likes (a tile
 * pyramid in a worker, its own copy on a server) and returns an embedding.
 */
export interface SegmentationEncoder<TEmbedding> {
  readonly inputSize: number;
  encode(view: EncodeView, signal: AbortSignal): Promise<EncodedView<TEmbedding>>;
  dispose?(): void;
}

/** The cheap, per-prompt half. */
export interface SegmentationDecoder<TEmbedding> {
  readonly capabilities: Omit<ProviderCapabilities, 'inputSize'>;
  decode(
    encoded: EncodedView<TEmbedding>,
    prompt: SegmentationPrompt,
    signal: AbortSignal,
  ): Promise<{
    readonly candidates: readonly MaskCandidate[];
    readonly timings?: Readonly<Record<string, number>> | undefined;
  }>;
  dispose?(): void;
}

export function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}
