/* @refresh reload */
import { render } from 'solid-js/web';
import { Annotator, createImageId } from '@osdlabel/solid';
import type { AnnotationContext, AnnotationContextId, ImageSource } from '@osdlabel/solid';
import { createOnnxSamProvider } from '@osdlabel/segmentation-onnx';

const DECODER_URL = import.meta.env.VITE_SAM_DECODER_URL ?? '/models/mobile_sam_decoder.onnx';
const EMBED_ENDPOINT = import.meta.env.VITE_SAM_EMBED_ENDPOINT ?? '/api/sam/embed';

// Server-encode (Vite middleware) → client-decode (onnxruntime-web). The decoder
// model and ORT WASM are served same-origin from public/ (see the asset scripts).
const segmentationProvider = createOnnxSamProvider({
  encoder: { endpoint: EMBED_ENDPOINT },
  decoder: {
    modelUrl: DECODER_URL,
    session: { executionProviders: ['webgpu', 'wasm'], wasmPaths: '/ort/' },
    // The MobileSAM decoder export upscales masks to orig_im_size, so contours are
    // already in image space. Switch to 'model' for a decoder that returns
    // model-resolution masks.
    maskSpace: 'original',
  },
});

// A single LOCAL image keeps Cross-Origin-Embedder-Policy happy (no remote tiles).
const IMAGES: ImageSource[] = [
  { id: createImageId('sample'), tileSource: '/sample-data/test-image.jpg', label: 'Sample' },
];

const CONTEXTS: AnnotationContext[] = [
  {
    id: 'segment' as AnnotationContextId,
    label: 'Segment',
    tools: [{ type: 'segmentation' }, { type: 'rectangle' }, { type: 'polyline' }],
  },
];

function App() {
  return (
    <Annotator
      images={IMAGES}
      contexts={CONTEXTS}
      segmentationProvider={segmentationProvider}
      showFilmstrip={false}
      defaultPixelSpacing={{ x: 1, y: 1, unit: 'px' }}
    />
  );
}

const root = document.getElementById('app');
if (root) render(() => <App />, root);
