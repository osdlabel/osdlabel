import init, { start } from 'osdlabel-tui-wasm';
import {
  createImageId,
  type AnnotationContext,
  type AnnotationContextId,
  type ImageSource,
} from '@osdlabel/solid';
import { mountBridge } from './bridge.js';

// The same local sample images the dev apps use (served from apps/dev/sample-data).
const IMAGES: ImageSource[] = [
  { id: createImageId('landscape'), tileSource: './landscape.png', label: 'Landscape' },
  { id: createImageId('portrait'), tileSource: './portrait.png', label: 'Portrait' },
  { id: createImageId('wide'), tileSource: './wide.png', label: 'Wide image' },
  { id: createImageId('tiled'), tileSource: './tiled.dzi', label: 'Tiled (DZI)' },
];

const CONTEXTS: AnnotationContext[] = [
  {
    id: 'ctx-1' as AnnotationContextId,
    label: 'Fracture',
    imageIds: [createImageId('landscape'), createImageId('portrait')],
    tools: [
      { type: 'line', maxCount: 3, countScope: 'per-image' },
      { type: 'rectangle', maxCount: 2 },
    ],
  },
  {
    id: 'ctx-2' as AnnotationContextId,
    label: 'Pneumothorax',
    tools: [
      { type: 'polyline', maxCount: 3 },
      { type: 'freeHandPath', maxCount: 3 },
      { type: 'circle', maxCount: 2 },
    ],
  },
  {
    id: 'ctx-3' as AnnotationContextId,
    label: 'General',
    tools: [
      { type: 'rectangle' },
      { type: 'circle' },
      { type: 'line' },
      { type: 'point' },
      { type: 'polyline' },
      { type: 'freeHandPath' },
    ],
  },
];

const host = document.getElementById('viewer');
if (!host) throw new Error('#viewer missing');

const bridge = mountBridge({
  host,
  gridElement: () => document.getElementById('tui_ratzilla_grid'),
  images: IMAGES,
  contexts: CONTEXTS,
});

// Test hook: the bridge handle, so a spec can drive and inspect it.
(window as unknown as { __bridge: typeof bridge }).__bridge = bridge;

await init();
start(bridge);
