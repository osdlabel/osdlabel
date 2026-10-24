import {
  cropGrid,
  imageToModel,
  modelGridFrame,
  type InputLayout,
  type MaskCandidate,
  type ModelFrame,
  type SegmentationPrompt,
} from '@osdlabel/segmentation';
import {
  float32Data,
  type OrtModuleLike,
  type OrtSessionLike,
  type OrtTensorLike,
} from './ort-like.js';
import type { PixelNormalization } from './preprocess.js';

/**
 * The ONNX graph conventions of each SAM-family export:
 * - `sam1`: Segment Anything's official ONNX decoder (`SamOnnxModel`) with a
 *   separately exported image encoder. Shared by SAM ViT-B/L/H, MobileSAM,
 *   EdgeSAM and LiteMedSAM (which only change the encoder).
 * - `efficientsam`: EfficientSAM's own export (batched inputs, stretch resize,
 *   normalisation inside the graph).
 * - `sam2`: SAM 2 / 2.1 image mode — the encoder also returns two high-res
 *   feature maps the decoder consumes.
 */
export type ModelFamily = 'sam1' | 'efficientsam' | 'sam2';

/** A CPU-side tensor kept as part of an embedding. */
export interface SamTensor {
  readonly name: string;
  readonly dims: readonly number[];
  readonly data: Float32Array;
}

export interface SamEmbedding {
  readonly family: ModelFamily;
  readonly frame: ModelFrame;
  readonly tensors: readonly SamTensor[];
}

export function embeddingBytes(e: SamEmbedding): number {
  return e.tensors.reduce((s, t) => s + t.data.byteLength, 0);
}

/** SAM-family decoders all produce 256 x 256 low-resolution logits. */
export const LOW_RES = 256;

export interface FamilyAdapter {
  readonly family: ModelFamily;
  readonly layout: InputLayout;
  readonly normalization: PixelNormalization;
  readonly embeddingNames: readonly string[];
  encoderFeeds<T extends OrtTensorLike>(
    ort: OrtModuleLike<T>,
    session: OrtSessionLike<T>,
    input: Float32Array,
    inputSize: number,
  ): Record<string, T>;
  decoderFeeds<T extends OrtTensorLike>(
    ort: OrtModuleLike<T>,
    session: OrtSessionLike<T>,
    embedding: SamEmbedding,
    prompt: SegmentationPrompt,
  ): Record<string, T>;
  /** Output names to fetch (skipping full-resolution upsamples when the graph has them). */
  decoderFetches(): readonly string[];
  candidates(
    outputs: Record<string, OrtTensorLike>,
    embedding: SamEmbedding,
    prompt: SegmentationPrompt,
  ): MaskCandidate[];
}

/** Prompt -> SAM point list in model pixels (box corners labelled 2/3). */
function samPoints(
  frame: ModelFrame,
  prompt: SegmentationPrompt,
  coordScale: number,
  padWhenNoBox: boolean,
): { coords: Float32Array; labels: Float32Array; n: number } {
  const coords: number[] = [];
  const labels: number[] = [];
  for (const p of prompt.points ?? []) {
    const m = imageToModel(frame, p);
    coords.push(m.x * coordScale, m.y * coordScale);
    labels.push(p.label);
  }
  if (prompt.box) {
    const b = prompt.box;
    const a = imageToModel(frame, { x: b.x, y: b.y });
    const c = imageToModel(frame, { x: b.x + b.width, y: b.y + b.height });
    coords.push(a.x * coordScale, a.y * coordScale, c.x * coordScale, c.y * coordScale);
    labels.push(2, 3);
  } else if (padWhenNoBox) {
    coords.push(0, 0);
    labels.push(-1);
  }
  return { coords: Float32Array.from(coords), labels: Float32Array.from(labels), n: labels.length };
}

function tensor(e: SamEmbedding, name: string): SamTensor {
  const t = e.tensors.find((x) => x.name === name);
  if (!t) throw new Error(`embedding has no tensor '${name}'`);
  return t;
}

/**
 * Orders SAM's 4 outputs the way SamPredictor does: a lone point is
 * ambiguous, so the 3 multimask outputs (1..3) lead; with more context the
 * single-mask output (0) is the better answer.
 */
function orderSam4(iou: Float32Array, prompt: SegmentationPrompt): number[] {
  const nPrompts = (prompt.points?.length ?? 0) + (prompt.box ? 2 : 0);
  const multi = [1, 2, 3].sort((a, b) => iou[b]! - iou[a]!);
  return nPrompts <= 1 ? [...multi, 0] : [0, ...multi];
}

/**
 * Candidate order for a decoder with `count` outputs: SAM's 4-output layout
 * (single-mask output first) gets {@link orderSam4}; any other count (a
 * multimask-only export returns 3, a single-mask one 1) is ranked by IoU.
 */
export function orderCandidates(
  iou: Float32Array,
  count: number,
  prompt: SegmentationPrompt,
): number[] {
  if (count === 4) return orderSam4(iou, prompt);
  return Array.from({ length: count }, (_, i) => i).sort((a, b) => (iou[b] ?? 0) - (iou[a] ?? 0));
}

function maskInputFeeds<T extends OrtTensorLike>(
  ort: OrtModuleLike<T>,
  prompt: SegmentationPrompt,
): { mask_input: T; has_mask_input: T } {
  const prev = prompt.previous;
  const data = new Float32Array(LOW_RES * LOW_RES);
  let has = 0;
  // Only a previous result on the same low-res grid can be fed back.
  if (
    prev &&
    prev.data instanceof Float32Array &&
    prev.frame.width <= LOW_RES &&
    prev.frame.height <= LOW_RES
  ) {
    for (let y = 0; y < prev.frame.height; y++) {
      data.set(prev.data.subarray(y * prev.frame.width, (y + 1) * prev.frame.width), y * LOW_RES);
    }
    has = 1;
  }
  return {
    mask_input: ort.float32(data, [1, 1, LOW_RES, LOW_RES]),
    has_mask_input: ort.float32(Float32Array.from([has]), [1]),
  };
}

function lowResCandidates(
  planes: Float32Array,
  count: number,
  iou: Float32Array,
  order: readonly number[],
  embedding: SamEmbedding,
): MaskCandidate[] {
  const grid = modelGridFrame(embedding.frame, LOW_RES);
  const plane = LOW_RES * LOW_RES;
  return order
    .filter((i) => i < count)
    .map((i) => ({
      predictedIou: iou[i] ?? 0,
      mask: {
        frame: grid,
        data: cropGrid(planes.subarray(i * plane, (i + 1) * plane), LOW_RES, grid),
      },
    }));
}

export const SAM1: FamilyAdapter = {
  family: 'sam1',
  layout: 'letterbox',
  normalization: 'imagenet',
  embeddingNames: ['image_embeddings'],
  encoderFeeds(ort, session, input, inputSize) {
    return { [session.inputNames[0]!]: ort.float32(input, [1, 3, inputSize, inputSize]) };
  },
  decoderFeeds(ort, session, embedding, prompt) {
    const emb = tensor(embedding, 'image_embeddings');
    const pts = samPoints(embedding.frame, prompt, 1, true);
    const feeds: Record<string, ReturnType<typeof ort.float32>> = {
      image_embeddings: ort.float32(emb.data, emb.dims),
      point_coords: ort.float32(pts.coords, [1, pts.n, 2]),
      point_labels: ort.float32(pts.labels, [1, pts.n]),
      ...maskInputFeeds(ort, prompt),
    };
    if (session.inputNames.includes('orig_im_size')) {
      // Full graph: keep its internal upsample at model size — passing the
      // region's image-space size here costs seconds on a gigapixel crop.
      feeds['orig_im_size'] = ort.float32(
        Float32Array.from([embedding.frame.contentHeight, embedding.frame.contentWidth]),
        [2],
      );
    }
    return feeds;
  },
  decoderFetches: () => ['low_res_masks', 'iou_predictions'],
  candidates(outputs, embedding, prompt) {
    const masks = outputs['low_res_masks'];
    const planes = float32Data(masks, 'low_res_masks');
    const iou = float32Data(outputs['iou_predictions'], 'iou_predictions');
    const count = masks!.dims[1] ?? 1;
    return lowResCandidates(planes, count, iou, orderCandidates(iou, count, prompt), embedding);
  },
};

export const SAM2: FamilyAdapter = {
  family: 'sam2',
  layout: 'stretch',
  normalization: 'imagenet',
  embeddingNames: ['image_embed', 'high_res_feats_0', 'high_res_feats_1'],
  encoderFeeds(ort, session, input, inputSize) {
    return { [session.inputNames[0]!]: ort.float32(input, [1, 3, inputSize, inputSize]) };
  },
  decoderFeeds(ort, _session, embedding, prompt) {
    const pts = samPoints(embedding.frame, prompt, 1, true);
    const t = (n: string): ReturnType<typeof ort.float32> => {
      const x = tensor(embedding, n);
      return ort.float32(x.data, x.dims);
    };
    return {
      image_embed: t('image_embed'),
      high_res_feats_0: t('high_res_feats_0'),
      high_res_feats_1: t('high_res_feats_1'),
      point_coords: ort.float32(pts.coords, [1, pts.n, 2]),
      point_labels: ort.float32(pts.labels, [1, pts.n]),
      ...maskInputFeeds(ort, prompt),
    };
  },
  decoderFetches: () => ['masks', 'iou_predictions'],
  candidates(outputs, embedding, prompt) {
    const masks = outputs['masks'];
    const planes = float32Data(masks, 'masks');
    const iou = float32Data(outputs['iou_predictions'], 'iou_predictions');
    const count = masks!.dims[1] ?? 1;
    return lowResCandidates(planes, count, iou, orderCandidates(iou, count, prompt), embedding);
  },
};

export const EFFICIENT_SAM: FamilyAdapter = {
  family: 'efficientsam',
  layout: 'stretch',
  normalization: 'unit',
  embeddingNames: ['image_embeddings'],
  encoderFeeds(ort, session, input, inputSize) {
    return { [session.inputNames[0]!]: ort.float32(input, [1, 3, inputSize, inputSize]) };
  },
  decoderFeeds(ort, _session, embedding, prompt) {
    const emb = tensor(embedding, 'image_embeddings');
    // Coordinates are given in `orig_im_size` space; asking for 256x256
    // output keeps the graph's own upsample at the low-res grid.
    const pts = samPoints(embedding.frame, prompt, LOW_RES / embedding.frame.inputSize, false);
    return {
      image_embeddings: ort.float32(emb.data, emb.dims),
      batched_point_coords: ort.float32(pts.coords, [1, 1, pts.n, 2]),
      batched_point_labels: ort.float32(pts.labels, [1, 1, pts.n]),
      orig_im_size: ort.int64(BigInt64Array.from([BigInt(LOW_RES), BigInt(LOW_RES)]), [2]),
    };
  },
  decoderFetches: () => ['output_masks', 'iou_predictions'],
  candidates(outputs, embedding) {
    const masks = outputs['output_masks'];
    const planes = float32Data(masks, 'output_masks');
    const iou = float32Data(outputs['iou_predictions'], 'iou_predictions');
    const count = masks!.dims[2] ?? 1;
    const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => iou[b]! - iou[a]!);
    return lowResCandidates(planes, count, iou, order, embedding);
  },
};

export function adapterFor(family: ModelFamily): FamilyAdapter {
  switch (family) {
    case 'sam1':
      return SAM1;
    case 'sam2':
      return SAM2;
    case 'efficientsam':
      return EFFICIENT_SAM;
  }
}
