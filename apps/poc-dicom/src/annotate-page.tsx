/**
 * The end-to-end proof: DICOM in (WSI over DICOMweb, CT stack, US with
 * calibration regions, MONOCHROME1 DX) → the stock osdlabel <Annotator>,
 * unmodified → DICOM out (SR / SEG / ANN). Driven by scripts/bench.mjs.
 */
import { createSignal, For } from 'solid-js';
import { render } from 'solid-js/web';
import {
  Annotator,
  createAnnotationContextId,
  createMeasurementProvider,
  type AnnotationContext,
  type OsdAnnotation,
  type OsdFields,
} from '@osdlabel/solid';
import { withCalibrationRegions } from './calibration-regions.js';
import { loadDicomImages } from './dicom-images.js';
import { exportToDicom, type ExportedFile } from './export-annotations.js';

const loaded = await loadDicomImages();

const CONTEXTS: AnnotationContext[] = [
  {
    id: createAnnotationContextId('dicom'),
    label: 'DICOM',
    tools: [
      { type: 'rectangle' },
      { type: 'circle' },
      { type: 'line' },
      { type: 'polyline' },
      { type: 'point' },
      { type: 'segmentationBrush' },
    ],
  },
];

const measurements = createMeasurementProvider<OsdFields>({
  area: true,
  length: true,
  radius: true,
});
const provider = withCalibrationRegions(measurements, (id) => loaded.context.get(id)?.regions);

let annotations: OsdAnnotation[] = [];
const [files, setFiles] = createSignal<ExportedFile[]>([]);

function download(f: ExportedFile): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(
    new Blob([f.bytes as Uint8Array<ArrayBuffer>], { type: 'application/dicom' }),
  );
  a.download = f.name;
  a.click();
}

const api = {
  images: loaded.images.map((i) => ({ id: i.id, label: i.label, pixelSpacing: i.pixelSpacing })),
  timings: loaded.timings,
  annotations: () => annotations,
  /** Exports, returning base64 payloads for the bench to validate. */
  export(): { name: string; kind: string; items: number; base64: string }[] {
    const out = exportToDicom(annotations, loaded.context);
    setFiles(out);
    return out.map((f) => {
      let s = '';
      for (let i = 0; i < f.bytes.length; i += 0x8000)
        s += String.fromCharCode(...f.bytes.subarray(i, i + 0x8000));
      return { name: f.name, kind: f.kind, items: f.items, base64: btoa(s) };
    });
  },
};
(window as unknown as { __annot: typeof api }).__annot = api;

render(
  () => (
    <div style={{ display: 'flex', 'flex-direction': 'column', height: '100vh' }}>
      <div
        style={{
          padding: '4px 8px',
          background: '#222',
          color: '#eee',
          'font-family': 'sans-serif',
          'font-size': '13px',
        }}
      >
        <button data-testid="export" onClick={() => api.export()}>
          Export DICOM
        </button>
        <For each={files()}>
          {(f) => (
            <button style={{ 'margin-left': '6px' }} onClick={() => download(f)}>
              {f.name} ({f.items})
            </button>
          )}
        </For>
      </div>
      <div style={{ flex: '1', 'min-height': '0' }}>
        <Annotator
          images={loaded.images}
          contexts={CONTEXTS}
          decorationProviders={[provider]}
          onAnnotationsChange={(a) => {
            annotations = a;
          }}
          testMode
        />
      </div>
    </div>
  ),
  document.getElementById('app')!,
);
document.body.dataset['ready'] = '1';
