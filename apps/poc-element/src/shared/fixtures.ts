import { createAnnotationContextId, createImageId } from 'osdlabel';
import type { AnnotationContext, ImageSource } from 'osdlabel';

/** Local images only (the dev app's committed sample data, served as this app's publicDir). */
export const IMAGES: readonly ImageSource[] = [
  { id: createImageId('landscape'), tileSource: '/landscape.png', label: 'Landscape' },
  { id: createImageId('portrait'), tileSource: '/portrait.png', label: 'Portrait' },
  { id: createImageId('tiled'), tileSource: '/tiled.dzi', label: 'Tiled (DZI)' },
];

export const CONTEXTS: readonly AnnotationContext[] = [
  {
    id: createAnnotationContextId('general'),
    label: 'General',
    tools: [
      { type: 'rectangle' },
      { type: 'circle' },
      { type: 'line' },
      { type: 'point' },
      { type: 'polyline' },
    ],
  },
];

/** The image every host assigns to cell 0 on startup, so all of them reach the same "interactive" state. */
export const FIRST_IMAGE_ID = IMAGES[0]!.id;
