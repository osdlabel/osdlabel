import {
  browserJpegDecoder,
  createDicomWebFrameSource,
  createFrameDecoderRegistry,
  createPart10FrameSource,
  createRangeFrameSource,
  createWsiTileSource,
  describePyramid,
  nativeDecoder,
  type FrameFetchStat,
  type FrameSource,
  type PyramidInstance,
  type TileStat,
  type WsiPyramid,
  type WsiTileSourceSpec,
} from '@osdlabel/dicom-wsi';
import { createJ2kWorkerDecoder } from './j2k-decoder.js';

export type WsiMode = 'part10' | 'range' | 'dicomweb';

export interface LoadedWsi {
  readonly instances: readonly PyramidInstance[];
  readonly pyramid: WsiPyramid;
  readonly tileSource: WsiTileSourceSpec;
  readonly frames: FrameSource;
  readonly tiles: (TileStat & { readonly t: number })[];
  readonly fetches: FrameFetchStat[];
  readonly metadataMs: number;
  readonly j2kWorkerMs: number[];
}

/** Loads a WSI series served by the PoC dev server, by role, through one of three frame sources. */
export async function loadWsi(role: string, mode: WsiMode): Promise<LoadedWsi> {
  const t0 = performance.now();
  let frames: FrameSource;
  if (mode === 'dicomweb') {
    const { study, series } = (await (await fetch(`/series-of.json?role=${role}`)).json()) as {
      study: string;
      series: string;
    };
    frames = createDicomWebFrameSource({
      baseUrl: '/dicomweb',
      studyInstanceUid: study,
      seriesInstanceUid: series,
    });
  } else {
    const index = (await (await fetch('/data-index.json')).json()) as Record<string, string[]>;
    const urls = (index[role] ?? []).map((f) => `/data/${role}/${f}`);
    frames =
      mode === 'part10' ? createPart10FrameSource({ urls }) : createRangeFrameSource({ urls });
  }
  const fetches: FrameFetchStat[] = [];
  frames.onFetch = (s) => fetches.push(s);
  const instances = await frames.instances();
  const metadataMs = performance.now() - t0;
  const pyramid = describePyramid(instances);
  const j2k = createJ2kWorkerDecoder();
  const decoders = createFrameDecoderRegistry([browserJpegDecoder, nativeDecoder, j2k]);
  const tiles: (TileStat & { t: number })[] = [];
  const tileSource = createWsiTileSource({
    pyramid,
    frames,
    decoders,
    onTile: (s) => tiles.push({ ...s, t: performance.now() }),
  });
  return {
    instances,
    pyramid,
    tileSource,
    frames,
    tiles,
    fetches,
    metadataMs,
    j2kWorkerMs: j2k.workerMs,
  };
}
