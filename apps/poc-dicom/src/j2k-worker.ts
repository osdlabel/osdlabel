/// <reference lib="webworker" />
/**
 * JPEG 2000 frame decoder worker: OpenJPEG compiled to WASM
 * (@cornerstonejs/codec-openjpeg), returning a transferable ImageBitmap so the
 * main thread never touches pixels.
 */
import factory from '@cornerstonejs/codec-openjpeg/decodewasmjs';
import wasmUrl from '@cornerstonejs/codec-openjpeg/decodewasm?url';

interface J2KDecoder {
  getEncodedBuffer(length: number): Uint8Array;
  getDecodedBuffer(): Uint8Array;
  decode(): void;
  getFrameInfo(): { width: number; height: number; bitsPerSample: number; componentCount: number };
}
interface OpenJpegModule {
  J2KDecoder: new () => J2KDecoder;
}
type Factory = (opts: Record<string, unknown>) => Promise<OpenJpegModule>;

const ready = (factory as unknown as Factory)({
  locateFile: () => wasmUrl,
  print: () => undefined,
  printErr: () => undefined,
});
let decoder: J2KDecoder | undefined;

self.onmessage = async (ev: MessageEvent<{ id: number; bytes: Uint8Array }>) => {
  const { id, bytes } = ev.data;
  try {
    const mod = await ready;
    decoder ??= new mod.J2KDecoder();
    const t0 = performance.now();
    const enc = decoder.getEncodedBuffer(bytes.length);
    enc.set(bytes);
    decoder.decode();
    const info = decoder.getFrameInfo();
    const px = decoder.getDecodedBuffer();
    const n = info.width * info.height;
    const rgba = new Uint8ClampedArray(n * 4);
    const c = info.componentCount;
    for (let p = 0, s = 0; p < n; p++, s += c) {
      const o = p * 4;
      rgba[o] = px[s]!;
      rgba[o + 1] = px[c > 1 ? s + 1 : s]!;
      rgba[o + 2] = px[c > 2 ? s + 2 : s]!;
      rgba[o + 3] = 255;
    }
    const bitmap = await createImageBitmap(new ImageData(rgba, info.width, info.height));
    const ms = performance.now() - t0;
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, bitmap, ms }, [bitmap]);
  } catch (err) {
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, error: String(err) });
  }
};
