import { createImageId, createAnnotationContextId } from '@osdlabel/solid';
import type { ImageSource, AnnotationContext } from '@osdlabel/solid';

export const DEFAULT_IMAGES: ImageSource[] = [
  {
    id: createImageId('highsmith'),
    tileSource: 'https://openseadragon.github.io/example-images/highsmith/highsmith.dzi',
    label: 'Highsmith',
  },
  {
    id: createImageId('duomo'),
    tileSource: 'https://openseadragon.github.io/example-images/duomo/duomo.dzi',
    label: 'Duomo',
  },
  {
    id: createImageId('wide'),
    tileSource:
      'https://openseadragon.github.io/example-images/pnp/pan/6a32000/6a32400/6a32487.dzi',
    label: 'Wide image',
  },
];

export const DEFAULT_CONTEXTS: AnnotationContext[] = [
  {
    id: createAnnotationContextId('ctx-1'),
    label: 'Fracture',
    imageIds: [createImageId('highsmith'), createImageId('duomo')],
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

export const TOOL_TYPES = [
  'rectangle',
  'circle',
  'line',
  'point',
  'polyline',
  'freeHandPath',
] as const;
