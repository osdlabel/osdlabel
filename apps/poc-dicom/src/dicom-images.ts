import type { ImageId, ImageSource } from '@osdlabel/viewer-api';
import {
  deriveDisplayDefaults,
  readPart10,
  readUltrasoundRegions,
  renderNativeFrame,
  toCalibrationRegions,
  toImageSources,
  type CalibrationRegion,
  type DicomDataset,
  type Part10File,
} from '@osdlabel/dicom';
import { imageRefFrom, type ImageRef } from '@osdlabel/dicom-export';
import { wsiImageSource } from '@osdlabel/dicom-wsi';
import { loadWsi, type LoadedWsi } from './wsi-source.js';

/** What the host keeps per osdlabel image to speak DICOM again on export. */
export interface DicomImageContext {
  readonly ref: ImageRef;
  readonly source: DicomDataset;
  readonly series: string;
  readonly regions?: readonly CalibrationRegion[] | undefined;
}

export interface LoadedImages {
  readonly images: ImageSource[];
  readonly context: Map<ImageId, DicomImageContext>;
  readonly wsi: LoadedWsi;
  readonly timings: Record<string, number>;
}

async function fetchRole(role: string): Promise<Part10File[]> {
  const index = (await (await fetch('/data-index.json')).json()) as Record<string, string[]>;
  const files = index[role] ?? [];
  return Promise.all(
    files.map(async (f) =>
      readPart10(new Uint8Array(await (await fetch(`/data/${role}/${f}`)).arrayBuffer())),
    ),
  );
}

/** Native pixels → display-ready PNG blob URL (the stand-in for a pixel pipeline). */
async function renderToUrl(
  file: Part10File,
  frame: number,
): Promise<{ url: string; renderMs: number }> {
  const t0 = performance.now();
  const r = renderNativeFrame(file, frame, undefined, deriveDisplayDefaults(file.dataset));
  const canvas = new OffscreenCanvas(r.width, r.height);
  canvas
    .getContext('2d')!
    .putImageData(new ImageData(r.rgba as Uint8ClampedArray<ArrayBuffer>, r.width, r.height), 0, 0);
  const renderMs = performance.now() - t0;
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { url: URL.createObjectURL(blob), renderMs };
}

/**
 * Loads the PoC's DICOM data as osdlabel images: a WSI (DICOMweb), a CT
 * stack, an ultrasound frame with calibration regions and a MONOCHROME1
 * radiograph. Everything osdlabel receives is an ordinary `ImageSource`;
 * the DICOM context stays here, with the host.
 */
export async function loadDicomImages(): Promise<LoadedImages> {
  const timings: Record<string, number> = {};
  const context = new Map<ImageId, DicomImageContext>();
  const images: ImageSource[] = [];

  let t0 = performance.now();
  const wsi = await loadWsi('sm-jpeg', 'dicomweb');
  const base = wsi.pyramid.levels[wsi.pyramid.levels.length - 1]!;
  const baseDs = wsi.instances.find(
    (i) => i.dataset.strings(0x00080018)?.[0] === base.sopInstanceUid,
  )!.dataset;
  const wsiSource = wsiImageSource(wsi.pyramid, wsi.tileSource, { label: 'WSI (DICOMweb)' });
  images.push(wsiSource);
  context.set(wsiSource.id, { ref: imageRefFrom(baseDs), source: baseDs, series: 'sm' });
  timings['wsi-metadata'] = performance.now() - t0;

  for (const [role, label] of [
    ['ct', 'CT'],
    ['us-ge', 'US'],
    ['dx', 'DX (MONOCHROME1)'],
  ] as const) {
    t0 = performance.now();
    const files = await fetchRole(role);
    const byUid = new Map(files.map((f) => [f.dataset.strings(0x00080018)?.[0] ?? '', f]));
    const renders: number[] = [];
    // Render first, then let toImageSources order the stack geometrically.
    const urls = new Map<string, string>();
    for (const [uid, f] of byUid) {
      const { url, renderMs } = await renderToUrl(f, 0);
      renders.push(renderMs);
      urls.set(uid, url);
    }
    const sources = toImageSources(
      files.map((f) => f.dataset),
      {
        frames: 'first',
        tileSource: (ref) => ({
          type: 'image',
          url: urls.get(ref.dataset.strings(0x00080018)?.[0] ?? '')!,
        }),
        label: (ref) => `${label} ${ref.dataset.numbers(0x00200013)?.[0] ?? ''}`.trim(),
      },
    );
    for (const s of sources) {
      const f = byUid.get(s.id)!;
      const regions = toCalibrationRegions(readUltrasoundRegions(f.dataset));
      // With regions, calibration is per region (see withCalibrationRegions),
      // so the image-wide spacing is dropped rather than applied everywhere.
      images.push(regions.length ? { ...s, pixelSpacing: undefined } : s);
      context.set(s.id, { ref: imageRefFrom(f.dataset), source: f.dataset, series: role, regions });
    }
    timings[`${role}-load+render`] = performance.now() - t0;
    timings[`${role}-render-median-ms`] =
      [...renders].sort((a, b) => a - b)[renders.length >> 1] ?? 0;
  }
  return { images, context, wsi, timings };
}
