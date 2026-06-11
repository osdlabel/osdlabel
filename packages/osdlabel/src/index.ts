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
} from '@osdlabel/annotation';

export {
  createAnnotationId,
  DEFAULT_ANNOTATION_STYLE,
  toolTypeToGeometryType,
} from '@osdlabel/annotation';

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
export { createImageId, DEFAULT_CELL_TRANSFORM, getAllAnnotationsFlat } from '@osdlabel/viewer-api';
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
  getFabricOptions,
  serializeFabricObject,
  deserializeFabricObject,
  createFabricObjectFromRawData,
  getGeometryFromFabricObject,
} from '@osdlabel/fabric-annotations';
export type {
  ToolOverlay,
  FabricFields,
  FabricShapeOptions,
  AnnotationTool,
  ToolCallbacks,
  AddAnnotationParams,
} from '@osdlabel/fabric-annotations';

// Fabric-OSD overlay (re-exported from @osdlabel/fabric-osd)
export {
  FabricOverlay,
  computeViewportTransform,
  DecorationLayer,
  createDragValueControl,
} from '@osdlabel/fabric-osd';
export type {
  OverlayOptions,
  OverlayMode,
  DomDecorationEntry,
  CustomControlEvent,
  CustomControlHandler,
  DragValueControlConfig,
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
  withSelectionEmphasis,
} from '@osdlabel/decoration';

// Validation schemas (re-exported from @osdlabel/validation)
export {
  GeometrySchema,
  PointSchema,
  BaseAnnotationSchema,
  FabricRawAnnotationDataSchema,
  ToolTypeSchema,
} from '@osdlabel/validation';

// Own types
export type { OsdAnnotation, OsdFields } from './types.js';

// Pre-configured serialization (uses OSD validators)
export { serialize, deserialize, SerializationError } from './serialization-configured.js';
export type { DeserializeResult } from './serialization-configured.js';

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

// Keyboard mapping
export { DEFAULT_KEYBOARD_SHORTCUTS, MAX_GRID_SIZE, mapKeyEventToActions } from './keyboard.js';
export type { KeyboardMappingState } from './keyboard.js';

// Tool factory and helpers
export {
  createAnnotationTool,
  buildToolCallbacks,
  getScenePointFromEvent,
  processObjectModified,
  processToolAddAnnotation,
  processToolUpdateAnnotation,
} from './tool-factory.js';
export type { ToolCallbackAccessors, ToolCallbackDispatchers } from './tool-factory.js';

// Live decoration update wiring
export { enableLiveDecorationUpdates } from './live-decoration-updates.js';
export type { LiveDecorationUpdateOptions } from './live-decoration-updates.js';
