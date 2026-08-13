import { computeResizeTransform, maskToContours, modelToImage } from '@osdlabel/segmentation';
import type {
  SegmentationDecoder,
  SegmentationImageRef,
  SegmentationMask,
  SegmentationPrompt,
  SegmentationResult,
} from '@osdlabel/segmentation';
import type { SamEmbedding } from './sam-embedding.js';
import type { SamSession, SamTensor } from './sam-tensor.js';
import {
  buildDecoderFeeds,
  DEFAULT_DECODER_INPUT_NAMES,
  type DecoderInputNames,
} from './build-decoder-feeds.js';

/** Output tensor names for the SAM/MobileSAM decoder ONNX graph. */
export interface DecoderOutputNames {
  readonly masks: string;
  readonly iouPredictions: string;
}

/** Default output names matching the official Segment Anything ONNX export. */
export const DEFAULT_DECODER_OUTPUT_NAMES: DecoderOutputNames = {
  masks: 'masks',
  iouPredictions: 'iou_predictions',
};

export interface OnnxSamDecoderConfig {
  /** Lazily creates (and the decoder caches) the inference session. */
  readonly createSession: () => Promise<SamSession>;
  /** Logit cutoff: mask pixels with `value > maskThreshold` are foreground. Default `0`. */
  readonly maskThreshold?: number;
  /** Douglas–Peucker tolerance (px) passed to {@link maskToContours}. Default `1.5`. */
  readonly simplifyTolerance?: number;
  /** Drop mask components below this pixel area. */
  readonly minArea?: number;
  /** Override decoder input tensor names (for non-standard exports). */
  readonly inputNames?: DecoderInputNames;
  /** Override decoder output tensor names. */
  readonly outputNames?: DecoderOutputNames;
  /**
   * Coordinate space of the output `masks`:
   * - `'original'` (default): the export already upscaled to `orig_im_size`, so
   *   contours are image-space and used directly.
   * - `'model'`: masks are at model resolution; contours are mapped back to
   *   image space via {@link modelToImage}.
   */
  readonly maskSpace?: 'original' | 'model';
}

/**
 * A {@link SegmentationDecoder} that runs the SAM/MobileSAM mask decoder through
 * an injected {@link SamSession}, then vectorizes the result with the library's
 * {@link maskToContours}. All logic is runtime-agnostic; the only `onnxruntime-web`
 * touch is the `createSession` factory the caller supplies (typically
 * {@link import('./ort-session.js').createOrtSession}).
 */
export class OnnxSamDecoder implements SegmentationDecoder<SamEmbedding> {
  private readonly config: OnnxSamDecoderConfig;
  private sessionPromise: Promise<SamSession> | null = null;

  constructor(config: OnnxSamDecoderConfig) {
    this.config = config;
  }

  private getSession(): Promise<SamSession> {
    if (!this.sessionPromise) this.sessionPromise = this.config.createSession();
    return this.sessionPromise;
  }

  async decode(
    embedding: SamEmbedding,
    _image: SegmentationImageRef,
    prompt: SegmentationPrompt,
    signal: AbortSignal,
  ): Promise<SegmentationResult> {
    const session = await this.getSession();
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    const inputNames = this.config.inputNames ?? DEFAULT_DECODER_INPUT_NAMES;
    const outputNames = this.config.outputNames ?? DEFAULT_DECODER_OUTPUT_NAMES;

    const feeds = buildDecoderFeeds(embedding, prompt, inputNames);
    const outputs = await session.run(feeds);
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    const masks = outputs[outputNames.masks];
    if (!masks) throw new Error(`Decoder output '${outputNames.masks}' missing`);
    const iou = outputs[outputNames.iouPredictions];

    const best = pickBestMaskIndex(iou);
    const { width, height, plane } = extractMaskPlane(masks, best);

    const threshold = this.config.maskThreshold ?? 0;
    const data = new Uint8Array(width * height);
    for (let i = 0; i < data.length; i++) data[i] = plane[i]! > threshold ? 1 : 0;
    const mask: SegmentationMask = { width, height, data };

    let contours = maskToContours(mask, {
      simplifyTolerance: this.config.simplifyTolerance ?? 1.5,
      ...(this.config.minArea !== undefined ? { minArea: this.config.minArea } : {}),
    });

    if ((this.config.maskSpace ?? 'original') === 'model') {
      const transform = computeResizeTransform(
        embedding.origWidth,
        embedding.origHeight,
        embedding.inputSize,
      );
      contours = contours.map((ring) => ring.map((p) => modelToImage(p, transform)));
    }

    const score = iou?.data[best];
    return { contours, ...(score !== undefined ? { score } : {}) };
  }

  dispose(): void {
    if (this.sessionPromise) {
      const pending = this.sessionPromise;
      this.sessionPromise = null;
      void pending.then((s) => s.dispose?.()).catch(() => {});
    }
  }
}

/** Index of the highest-IoU mask, or `0` when no predictions are present. */
function pickBestMaskIndex(iou: SamTensor | undefined): number {
  if (!iou || iou.data.length === 0) return 0;
  let best = 0;
  let bestValue = iou.data[0]!;
  for (let i = 1; i < iou.data.length; i++) {
    const value = iou.data[i]!;
    if (value > bestValue) {
      bestValue = value;
      best = i;
    }
  }
  return best;
}

/** Extracts one mask plane as a `width × height` view. Handles `[1,K,H,W]` and `[1,H,W]`. */
function extractMaskPlane(
  masks: SamTensor,
  index: number,
): { width: number; height: number; plane: Float32Array } {
  const dims = masks.dims;
  let height: number;
  let width: number;
  if (dims.length === 4) {
    height = dims[2]!;
    width = dims[3]!;
  } else if (dims.length === 3) {
    height = dims[1]!;
    width = dims[2]!;
  } else {
    throw new Error(`Unexpected masks dims length ${dims.length}`);
  }
  const planeSize = width * height;
  const offset = index * planeSize;
  const plane = masks.data.subarray(offset, offset + planeSize);
  return { width, height, plane };
}
