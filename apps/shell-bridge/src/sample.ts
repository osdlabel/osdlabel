/** The images and annotation contexts both Rust shell PoCs open with. */
import {
  createAnnotationContextId,
  createImageId,
  type AnnotationContext,
  type ImageSource,
} from '@osdlabel/solid';

// The same local sample images the dev apps use. Each app serves
// apps/dev/sample-data at its root (Vite's publicDir).
export const IMAGES: ImageSource[] = [
  { id: createImageId('landscape'), tileSource: './landscape.png', label: 'Landscape' },
  { id: createImageId('portrait'), tileSource: './portrait.png', label: 'Portrait' },
  { id: createImageId('wide'), tileSource: './wide.png', label: 'Wide image' },
  { id: createImageId('tiled'), tileSource: './tiled.dzi', label: 'Tiled (DZI)' },
];

export const CONTEXTS: AnnotationContext[] = [
  {
    id: createAnnotationContextId('ctx-1'),
    label: 'Fracture',
    imageIds: [createImageId('landscape'), createImageId('portrait')],
    tools: [
      { type: 'line', maxCount: 3, countScope: 'per-image' },
      { type: 'rectangle', maxCount: 2 },
    ],
  },
  {
    id: createAnnotationContextId('ctx-2'),
    label: 'Pneumothorax',
    tools: [
      { type: 'polyline', maxCount: 3 },
      { type: 'freeHandPath', maxCount: 3 },
      { type: 'circle', maxCount: 2 },
    ],
  },
  {
    id: createAnnotationContextId('ctx-3'),
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
