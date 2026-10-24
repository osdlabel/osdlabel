import type { RgbaImage } from '@osdlabel/region-reader';

export type PixelNormalization = 'imagenet' | 'unit';

const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;

/**
 * RGBA pixels (already at model resolution) -> a `[1, 3, S, S]` float tensor,
 * placed top-left with zero padding (SAM pads *after* normalising, so padding
 * is the mean colour). `imagenet` is (x/255 - mean) / std; `unit` is x/255
 * for models that normalise internally (EfficientSAM).
 */
export function rgbaToChw(
  image: RgbaImage,
  inputSize: number,
  normalization: PixelNormalization,
): Float32Array {
  if (image.width > inputSize || image.height > inputSize) {
    throw new RangeError(`image ${image.width}x${image.height} exceeds model input ${inputSize}`);
  }
  const plane = inputSize * inputSize;
  const out = new Float32Array(3 * plane);
  const src = image.data;
  const w = image.width;
  if (normalization === 'imagenet') {
    const s0 = 1 / (255 * STD[0]);
    const s1 = 1 / (255 * STD[1]);
    const s2 = 1 / (255 * STD[2]);
    const b0 = -MEAN[0] / STD[0];
    const b1 = -MEAN[1] / STD[1];
    const b2 = -MEAN[2] / STD[2];
    for (let y = 0; y < image.height; y++) {
      let si = y * w * 4;
      let di = y * inputSize;
      for (let x = 0; x < w; x++, si += 4, di++) {
        out[di] = src[si]! * s0 + b0;
        out[plane + di] = src[si + 1]! * s1 + b1;
        out[2 * plane + di] = src[si + 2]! * s2 + b2;
      }
    }
  } else {
    const k = 1 / 255;
    for (let y = 0; y < image.height; y++) {
      let si = y * w * 4;
      let di = y * inputSize;
      for (let x = 0; x < w; x++, si += 4, di++) {
        out[di] = src[si]! * k;
        out[plane + di] = src[si + 1]! * k;
        out[2 * plane + di] = src[si + 2]! * k;
      }
    }
  }
  return out;
}
