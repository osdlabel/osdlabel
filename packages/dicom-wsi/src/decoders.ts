/** What a decoder needs to know about the frame it decodes. */
export interface DecodeInfo {
  readonly width: number;
  readonly height: number;
  readonly photometric: string;
  readonly samplesPerPixel: number;
  readonly transferSyntaxUid: string;
}

/**
 * Turns one frame's bytes into something OpenSeadragon can draw. The
 * extension point for codecs: JPEG decodes natively in every browser, JPEG
 * 2000 / HTJ2K / JPEG-LS need WASM, which a host registers only if its data
 * needs it — the same registry shape as `@osdlabel/mask`'s codecs.
 */
export interface FrameDecoder {
  readonly name: string;
  canDecode(transferSyntaxUid: string): boolean;
  decode(frame: Uint8Array, info: DecodeInfo, signal?: AbortSignal): Promise<ImageBitmap>;
}

export interface FrameDecoderRegistry {
  register(decoder: FrameDecoder): void;
  find(transferSyntaxUid: string): FrameDecoder | undefined;
}

export function createFrameDecoderRegistry(
  decoders: readonly FrameDecoder[] = [],
): FrameDecoderRegistry {
  const list = [...decoders];
  return {
    register: (d) => void list.unshift(d),
    find: (ts) => list.find((d) => d.canDecode(ts)),
  };
}

const JPEG_BASELINE = '1.2.840.10008.1.2.4.50';
const JPEG_EXTENDED = '1.2.840.10008.1.2.4.51';
const NATIVE: ReadonlySet<string> = new Set(['1.2.840.10008.1.2', '1.2.840.10008.1.2.1']);

/**
 * A JPEG frame whose Photometric Interpretation is RGB must not be colour-
 * converted, but a decoder assumes YCbCr unless an Adobe APP14 marker says
 * otherwise. Inserts `APP14 transform=0` when there is neither APP14 nor JFIF.
 */
export function ensureRgbJpeg(frame: Uint8Array): Uint8Array {
  let i = 2;
  while (i + 4 <= frame.length && frame[i] === 0xff) {
    const m = frame[i + 1]!;
    if (m === 0xee || m === 0xe0) return frame; // APP14 or JFIF present
    if (m === 0xda) break; // start of scan
    i += 2 + ((frame[i + 2]! << 8) | frame[i + 3]!);
  }
  const app14 = new Uint8Array([
    0xff, 0xee, 0x00, 0x0e, 0x41, 0x64, 0x6f, 0x62, 0x65, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  const out = new Uint8Array(frame.length + app14.length);
  out.set(frame.subarray(0, 2));
  out.set(app14, 2);
  out.set(frame.subarray(2), 2 + app14.length);
  return out;
}

/** JPEG baseline / extended via the browser's own decoder (off the main thread in Chromium). */
export const browserJpegDecoder: FrameDecoder = {
  name: 'browser-jpeg',
  canDecode: (ts) => ts === JPEG_BASELINE || ts === JPEG_EXTENDED,
  async decode(frame, info) {
    const bytes = info.photometric === 'RGB' ? ensureRgbJpeg(frame) : frame;
    return createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }));
  },
};

/** Expands decoded samples (8-bit gray or RGB, interleaved) to an ImageBitmap. */
export function samplesToBitmap(
  samples: Uint8Array,
  width: number,
  height: number,
  spp: number,
): Promise<ImageBitmap> {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, s = 0; p < width * height; p++, s += spp) {
    const o = p * 4;
    if (spp === 1) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = samples[s]!;
    } else {
      rgba[o] = samples[s]!;
      rgba[o + 1] = samples[s + 1]!;
      rgba[o + 2] = samples[s + 2]!;
    }
    rgba[o + 3] = 255;
  }
  return createImageBitmap(new ImageData(rgba, width, height));
}

/** Uncompressed 8-bit frames (interleaved). */
export const nativeDecoder: FrameDecoder = {
  name: 'native-8bit',
  canDecode: (ts) => NATIVE.has(ts),
  decode: (frame, info) => samplesToBitmap(frame, info.width, info.height, info.samplesPerPixel),
};
