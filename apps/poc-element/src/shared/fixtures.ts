import {
  createAnnotationContextId,
  createAnnotationFromGeometry,
  createImageId,
  createMeasurementProvider,
} from 'osdlabel';
import type {
  AnnotationContext,
  DecorationProvider,
  ImageSource,
  OsdAnnotation,
  OsdFields,
} from 'osdlabel';

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

/**
 * One rectangle on the first image, for the hosts' "load from the host" path
 * (host state -> `annotations` property -> the element's store).
 */
export function sampleAnnotations(): OsdAnnotation[] {
  return [
    createAnnotationFromGeometry(
      { type: 'rectangle', origin: { x: 100, y: 80 }, width: 200, height: 120, rotation: 0 },
      { imageId: FIRST_IMAGE_ID, contextId: CONTEXTS[0]!.id, toolType: 'rectangle' },
    ),
  ];
}

/**
 * The decoration providers every host binds through its own syntax. Angular
 * applies property bindings after the element is connected, and the vanilla
 * host assigns them after `append`, so this exercises a write after mount.
 */
export const DECORATION_PROVIDERS: readonly DecorationProvider<OsdFields>[] = [
  createMeasurementProvider<OsdFields>({ area: true }),
];
