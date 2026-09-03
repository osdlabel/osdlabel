// Annotation model (re-exported from @osdlabel/annotation)
export type {
  AnnotationId,
  ToolType,
  GeometryType,
  Point,
  Geometry,
  AnnotationStyle,
  BaseAnnotation,
  Annotation,
  RawAnnotationData,
  MaskGeometry,
  MaskRawAnnotationData,
  MaskRawData,
  VectorGeometry,
} from '@osdlabel/annotation';

export {
  createAnnotationId,
  DEFAULT_ANNOTATION_STYLE,
  toolTypeToGeometryType,
  MASK_RAW_FORMAT,
} from '@osdlabel/annotation';

// Mask storage + codecs (re-exported from @osdlabel/mask)
export {
  BoundedDenseMaskBuffer,
  DEFAULT_MAX_MASK_PIXELS,
  MaskCapacityExceededError,
  emptySnapshot,
  snapshotPixelCount,
  stampCircle,
  strokeSegment,
  createMaskCodecRegistry,
  canonicalMaskCodec,
  encodeCanonical,
  decodeCanonical,
  cocoRleCodec,
  cocoRleUncompressedCodec,
  cocoBbox,
  cocoArea,
  isCocoInteropSafe,
  COCO_MAX_INTEROP_IMAGE_PIXELS,
  CANONICAL_MASK_FORMAT,
  COCO_RLE_FORMAT,
  COCO_RLE_UNCOMPRESSED_FORMAT,
} from '@osdlabel/mask';
export type {
  MaskBuffer,
  MaskRegion,
  MaskSnapshot,
  MaskCodec,
  MaskCodecRegistry,
  MaskDecodeOptions,
  BoundedDenseMaskBufferOptions,
  CanonicalMaskData,
  CocoRleSegmentation,
  CocoRleUncompressedSegmentation,
} from '@osdlabel/mask';

// Viewer API (re-exported from @osdlabel/viewer-api)
export type {
  ImageId,
  ImageIdFields,
  UIState,
  ViewerControlId,
  KeyboardShortcutMap,
  CellTransform,
  AnnotationState,
  ImageSource,
} from '@osdlabel/viewer-api';
export {
  createImageId,
  DEFAULT_CELL_TRANSFORM,
  getAllAnnotationsFlat,
  MIN_BRUSH_RADIUS,
  MAX_BRUSH_RADIUS,
  DEFAULT_BRUSH_RADIUS,
} from '@osdlabel/viewer-api';
export type { PixelSpacing } from '@osdlabel/viewer-api';

// Annotation context (re-exported from @osdlabel/annotation-context)
export type {
  AnnotationContext,
  AnnotationContextId,
  ToolConstraint,
  ConstraintStatus,
  ContextState,
  CountScope,
  ContextFields,
} from '@osdlabel/annotation-context';

export {
  createAnnotationContextId,
  isContextScopedToImage,
  getCountableImageIds,
} from '@osdlabel/annotation-context';

// Fabric annotations (re-exported from @osdlabel/fabric-annotations)
export {
  initFabricModule,
  BaseTool,
  ShapeTool,
  RectangleTool,
  CircleTool,
  LineTool,
  PointTool,
  PolylineTool,
  FreeHandPathTool,
  SelectTool,
  SegmentationBrushTool,
  getFabricOptions,
  serializeFabricObject,
  deserializeFabricObject,
  createFabricObjectFromRawData,
  getGeometryFromFabricObject,
  buildFabricObjectFromGeometry,
  buildMaskFabricObject,
  DEFAULT_MASK_FILL,
  PolyVertexEditor,
  DEFAULT_VERTEX_EDIT_LONG_PRESS_MS,
  DEFAULT_VERTEX_EDIT_MOVE_TOLERANCE_PX,
} from '@osdlabel/fabric-annotations';
export type {
  ToolOverlay,
  FabricFields,
  AnnotationRawData,
  FabricRawAnnotationData,
  FabricShapeOptions,
  AnnotationTool,
  ToolCallbacks,
  AddAnnotationParams,
  SegmentationBrushToolConfig,
  BrushStrokeCommit,
  BrushTarget,
  BuildMaskFabricObjectOptions,
  PolyVertexEditorOptions,
  VertexEditConfig,
} from '@osdlabel/fabric-annotations';

// Fabric-OSD overlay (re-exported from @osdlabel/fabric-osd)
export {
  FabricOverlay,
  computeViewportTransform,
  composeImageFilterCss,
  DecorationLayer,
  createDragValueControl,
  createDragVectorControl,
} from '@osdlabel/fabric-osd';
export type {
  OverlayOptions,
  OverlayMode,
  DomDecorationEntry,
  CustomControlEvent,
  CustomControlHandler,
  DragValueControlConfig,
  DragVectorControlConfig,
  DragAxisBehavior,
  ImageFilters,
} from '@osdlabel/fabric-osd';

// Decorations (re-exported from @osdlabel/decoration)
export type {
  Decoration,
  DecorationType,
  TextDecoration,
  TextDecorationStyle,
  TextPlacement,
  LineDecoration,
  LineDecorationStyle,
  DomDecoration,
  DomDecorationStyle,
  DecorationContext,
  DecorationProvider,
  Measurement,
  SpacingAxis,
  FormatMeasurementOptions,
  MeasurementProviderOptions,
  LabelProviderOptions,
  DistanceProviderOptions,
  AnnotationPair,
} from '@osdlabel/decoration';
export {
  composeProviders,
  createMeasurementProvider,
  createLabelProvider,
  createDistanceProvider,
  toPhysicalLength,
  toPhysicalArea,
  formatMeasurement,
  area,
  perimeter,
  length,
  radius,
  distance,
  centroid,
  midpoint,
  boundingBox,
  circleToBoundingRectangle,
  withSelectionEmphasis,
} from '@osdlabel/decoration';

// Validation schemas (re-exported from @osdlabel/validation)
export {
  GeometrySchema,
  PointSchema,
  BaseAnnotationSchema,
  FabricRawAnnotationDataSchema,
  MaskGeometrySchema,
  MaskRawAnnotationDataSchema,
  ToolTypeSchema,
} from '@osdlabel/validation';

// Own types
export type { OsdAnnotation, OsdFields } from './types.js';

// Annotation construction helpers
export { createAnnotationFromGeometry } from './create-annotation.js';
export { createMaskAnnotation, maskAnnotationFields } from './create-mask-annotation.js';
export { buildSegmentationBrushConfig, nextBrushRadius } from './brush-config.js';
export type { BrushOptions } from './brush-options.js';
export type { BrushConfigAccessors, BrushConfigDispatchers } from './brush-config.js';
export type {
  CreateMaskAnnotationOptions,
  MaskAnnotationFields,
} from './create-mask-annotation.js';
export type { CreateAnnotationFromGeometryOptions } from './create-annotation.js';

// Pre-configured serialization (uses OSD validators)
export {
  serialize,
  deserialize,
  SerializationError,
  DEFAULT_MAX_TOTAL_MASK_PIXELS,
} from './serialization-configured.js';
export type {
  DeserializeResult,
  SerializeOptions,
  DeserializeOptions,
  ExportedAnnotation,
} from './serialization-configured.js';

// Pure action types and reducers
export {
  applyAnnotationAction,
  applyUIAction,
  applyContextAction,
  validateAddAnnotation,
} from './actions.js';
export type { AnnotationAction, UIAction, ContextAction } from './actions.js';

// Initial state factories
export {
  createInitialAnnotationState,
  createInitialUIState,
  createInitialContextState,
} from './initial-state.js';

// Pure constraint computation
export { computeConstraintStatus, countAnnotationsForContextAndType } from './constraints.js';

// Drag-driven viewer control registry
export { VIEWER_CONTROL_SPECS, getToneValue } from './viewer-controls.js';
export type { ViewerControlSpec, ViewerControlAxisSpec, ToneField } from './viewer-controls.js';

// Keyboard mapping
export { DEFAULT_KEYBOARD_SHORTCUTS, MAX_GRID_SIZE, mapKeyEventToActions } from './keyboard.js';
export type { KeyboardMappingState } from './keyboard.js';

// Annotation context cycling
export { getSelectableContexts, getCycledContextId } from './context-cycling.js';
export type { ContextCycleDirection } from './context-cycling.js';

// Tool factory and helpers
export {
  createAnnotationTool,
  buildToolCallbacks,
  getScenePointFromEvent,
  processObjectModified,
  processToolAddAnnotation,
  processToolUpdateAnnotation,
  processConvertCircleToRectangle,
} from './tool-factory.js';
export type {
  ToolCallbackAccessors,
  ToolCallbackDispatchers,
  CreateAnnotationToolOptions,
} from './tool-factory.js';

// Live decoration update wiring
export { enableLiveDecorationUpdates } from './live-decoration-updates.js';
export type { LiveDecorationUpdateOptions } from './live-decoration-updates.js';

// Fullscreen
export {
  getFullscreenElement,
  isDocumentFullscreen,
  isFullscreenSupported,
  requestFullscreen,
  exitFullscreen,
  toggleFullscreen,
  onFullscreenChange,
  shouldSuppressEscapeKey,
} from './fullscreen.js';
export { resolveFullscreenTarget } from './fullscreen-target.js';

// Chrome focus behaviour
export { preventButtonFocusSteal } from './prevent-button-focus-steal.js';
export type { ResolveFullscreenTargetOptions } from './fullscreen-target.js';
