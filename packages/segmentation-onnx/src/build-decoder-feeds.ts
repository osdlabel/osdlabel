import { computeResizeTransform, imageToModel } from '@osdlabel/segmentation';
import type { SegmentationPrompt } from '@osdlabel/segmentation';
import type { SamEmbedding } from './sam-embedding.js';
import type { SamTensor } from './sam-tensor.js';

/** Input tensor names for the SAM/MobileSAM decoder ONNX graph. */
export interface DecoderInputNames {
  readonly imageEmbeddings: string;
  readonly pointCoords: string;
  readonly pointLabels: string;
  readonly maskInput: string;
  readonly hasMaskInput: string;
  readonly origImSize: string;
}

/** Default input names matching the official Segment Anything ONNX export. */
export const DEFAULT_DECODER_INPUT_NAMES: DecoderInputNames = {
  imageEmbeddings: 'image_embeddings',
  pointCoords: 'point_coords',
  pointLabels: 'point_labels',
  maskInput: 'mask_input',
  hasMaskInput: 'has_mask_input',
  origImSize: 'orig_im_size',
};

/** SAM low-resolution mask side (the `mask_input` is `[1,1,256,256]`). */
const LOW_RES_MASK_SIZE = 256;

/**
 * Assembles the SAM decoder input feeds from an embedding and a prompt.
 *
 * Prompt geometry is mapped from image-space into the encoder's resized model
 * space via {@link imageToModel}. A box is encoded as two points labelled `2`
 * (top-left) and `3` (bottom-right); foreground/background points keep their
 * `1`/`0` labels. When there is no box, SAM requires a padding point at `(0,0)`
 * with label `-1`. `mask_input` is zeroed with `has_mask_input = 0` (no prior
 * mask), and `orig_im_size` is `[H, W]`.
 */
export function buildDecoderFeeds(
  embedding: SamEmbedding,
  prompt: SegmentationPrompt,
  inputNames: DecoderInputNames = DEFAULT_DECODER_INPUT_NAMES,
): Record<string, SamTensor> {
  const transform = computeResizeTransform(
    embedding.origWidth,
    embedding.origHeight,
    embedding.inputSize,
  );

  const coords: number[] = [];
  const labels: number[] = [];

  const box = prompt.box;
  if (box) {
    const topLeft = imageToModel({ x: box.x, y: box.y }, transform);
    const bottomRight = imageToModel({ x: box.x + box.width, y: box.y + box.height }, transform);
    coords.push(topLeft.x, topLeft.y);
    labels.push(2);
    coords.push(bottomRight.x, bottomRight.y);
    labels.push(3);
  }

  for (const point of prompt.points ?? []) {
    const modelPoint = imageToModel({ x: point.x, y: point.y }, transform);
    coords.push(modelPoint.x, modelPoint.y);
    labels.push(point.label);
  }

  // SAM expects a padding point when no box anchors the prompt.
  if (!box) {
    coords.push(0, 0);
    labels.push(-1);
  }

  const numPoints = labels.length;

  return {
    [inputNames.imageEmbeddings]: embedding.embedding,
    [inputNames.pointCoords]: { data: Float32Array.from(coords), dims: [1, numPoints, 2] },
    [inputNames.pointLabels]: { data: Float32Array.from(labels), dims: [1, numPoints] },
    [inputNames.maskInput]: {
      data: new Float32Array(LOW_RES_MASK_SIZE * LOW_RES_MASK_SIZE),
      dims: [1, 1, LOW_RES_MASK_SIZE, LOW_RES_MASK_SIZE],
    },
    [inputNames.hasMaskInput]: { data: Float32Array.from([0]), dims: [1] },
    [inputNames.origImSize]: {
      data: Float32Array.from([embedding.origHeight, embedding.origWidth]),
      dims: [2],
    },
  };
}
