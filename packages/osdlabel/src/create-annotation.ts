import {
  createAnnotationId,
  generateId,
  DEFAULT_ANNOTATION_STYLE,
  type AnnotationId,
  type AnnotationStyle,
  type ToolType,
  type VectorGeometry,
} from '@osdlabel/annotation';
import type { AnnotationContextId } from '@osdlabel/annotation-context';
import type { ImageId } from '@osdlabel/viewer-api';
import {
  buildFabricObjectFromGeometry,
  getFabricOptions,
  serializeFabricObject,
} from '@osdlabel/fabric-annotations';
import type { OsdAnnotation } from './types.js';

/** Options for {@link createAnnotationFromGeometry}. */
export interface CreateAnnotationFromGeometryOptions {
  /** Image the annotation belongs to. */
  readonly imageId: ImageId;
  /** Annotation context (scope) the annotation belongs to. */
  readonly contextId: AnnotationContextId;
  /**
   * Tool type recorded on the annotation. Note this is independent of
   * `geometry.type`: e.g. a freehand path is `toolType: 'freeHandPath'` with
   * `geometry.type: 'polygon'` (closed) or `'polyline'` (open).
   */
  readonly toolType: ToolType;
  /** Visual style. Defaults to {@link DEFAULT_ANNOTATION_STYLE}. */
  readonly style?: AnnotationStyle | undefined;
  /** Explicit id. A fresh id is generated when omitted. */
  readonly id?: AnnotationId | undefined;
  /** Optional text label. */
  readonly label?: string | undefined;
}

/**
 * Build a complete {@link OsdAnnotation} from image-space
 * {@link VectorGeometry}, producing the Fabric `rawAnnotationData` envelope
 * for you.
 *
 * Masks are outside the parameter type: their pixels are not in the geometry,
 * so there is nothing to build. Use `createMaskAnnotation(snapshot, options)`
 * instead — the compiler points you there rather than a runtime error.
 *
 * This removes the manual round-trip otherwise required to seed annotations
 * from an external system (build a Fabric object → `serializeFabricObject` →
 * `getGeometryFromFabricObject`). The returned annotation can be passed
 * straight to `addAnnotation` / `loadAnnotations` or persisted via `serialize`.
 *
 * The `id` is guaranteed to be present in the serialized envelope regardless of
 * whether {@link initFabricModule} has registered it as a custom property, so
 * the result always round-trips through `deserialize` →
 * `createFabricObjectFromRawData`.
 *
 * @example
 * ```ts
 * const annotation = createAnnotationFromGeometry(
 *   { type: 'rectangle', origin: { x: 10, y: 20 }, width: 100, height: 50, rotation: 0 },
 *   { imageId, contextId, toolType: 'rectangle' },
 * );
 * actions.addAnnotation(annotation);
 * ```
 */
export function createAnnotationFromGeometry(
  geometry: VectorGeometry,
  options: CreateAnnotationFromGeometryOptions,
): OsdAnnotation {
  const id = options.id ?? createAnnotationId(generateId());
  const style = options.style ?? DEFAULT_ANNOTATION_STYLE;
  const fabricObject = buildFabricObjectFromGeometry(geometry, getFabricOptions(style, id));

  const raw = serializeFabricObject(fabricObject);
  // Self-contained: guarantee the id survives serialization even if
  // initFabricModule() has not registered `id` as a Fabric custom property.
  const rawAnnotationData = raw.data['id'] === id ? raw : { ...raw, data: { ...raw.data, id } };

  const now = new Date().toISOString();
  return {
    id,
    geometry,
    toolType: options.toolType,
    imageId: options.imageId,
    contextId: options.contextId,
    rawAnnotationData,
    createdAt: now,
    updatedAt: now,
    ...(options.label !== undefined ? { label: options.label } : {}),
  };
}
