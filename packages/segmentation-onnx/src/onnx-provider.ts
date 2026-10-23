import { readRegion, type TileIO, type TilePyramid } from '@osdlabel/region-reader';
import {
  composeSegmentationProvider,
  modelFrame,
  throwIfAborted,
  type ComposeOptions,
  type EncodedView,
  type SegmentationDecoder,
  type SegmentationEncoder,
  type SegmentationImageKey,
  type SegmentationProvider,
} from '@osdlabel/segmentation';
import { embeddingBytes, type SamEmbedding } from './families.js';
import type { OnnxSamModel } from './onnx-sam-model.js';
import type { OrtTensorLike } from './ort-like.js';

/** Resolves an image key to the pyramid its pixels are read from. */
export type PyramidResolver = (imageKey: SegmentationImageKey) => TilePyramid | undefined;

/**
 * An encoder that reads the view's pixels from the image's tile pyramid at
 * model resolution (never from the screen) and runs the ONNX image encoder.
 */
export function createOnnxEncoder<T extends OrtTensorLike>(
  model: OnnxSamModel<T>,
  pyramids: PyramidResolver,
  io: TileIO,
): SegmentationEncoder<SamEmbedding> {
  return {
    inputSize: model.inputSize,
    async encode(view, signal): Promise<EncodedView<SamEmbedding>> {
      const pyramid = pyramids(view.imageKey);
      if (!pyramid) throw new Error(`no pyramid registered for image '${view.imageKey}'`);
      const frame = modelFrame(view, model.inputSize, model.adapter.layout);
      const pixels = await readRegion(pyramid, view.region, frame.contentWidth, frame.contentHeight, io, signal);
      throwIfAborted(signal);
      const { embedding, timings } = await model.encode(pixels, frame);
      return {
        view,
        embedding,
        bytes: embeddingBytes(embedding),
        timings: {
          readFetch: pixels.timings.fetch,
          readComposite: pixels.timings.composite,
          readback: pixels.timings.readback,
          tiles: pixels.tileCount,
          level: pixels.plan?.level ?? -1,
          ...timings,
        },
      };
    },
  };
}

/** The per-prompt half: runs the decoder on a cached embedding. */
export function createOnnxDecoder<T extends OrtTensorLike>(model: OnnxSamModel<T>): SegmentationDecoder<SamEmbedding> {
  return {
    capabilities: { box: true, negativePoints: true, multimask: true, maskInput: model.family !== 'efficientsam' },
    async decode(encoded, prompt, signal) {
      throwIfAborted(signal);
      return model.decode(encoded.embedding, prompt);
    },
  };
}

/** All-in-one: the browser (or worker) both encodes and decodes. */
export function createOnnxSamProvider<T extends OrtTensorLike>(
  model: OnnxSamModel<T>,
  pyramids: PyramidResolver,
  io: TileIO,
  options?: ComposeOptions,
): SegmentationProvider {
  return composeSegmentationProvider(createOnnxEncoder(model, pyramids, io), createOnnxDecoder(model), options);
}
