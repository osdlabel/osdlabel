// Annotation model (re-exported from @osdlabel/annotation)
export type {
  AnnotationId,
  ImageId,
  ToolType,
  GeometryType,
  Point,
  Geometry,
  AnnotationStyle,
  BaseAnnotation,
  Annotation,
  ImageSource,
  RawAnnotationData,
} from '@osdlabel/annotation';

export {
  createAnnotationId,
  createImageId,
  DEFAULT_ANNOTATION_STYLE,
  toolTypeToGeometryType,
} from '@osdlabel/annotation';

// Viewer API (re-exported from @osdlabel/viewer-api)
export type {
  UIState,
  KeyboardShortcutMap,
  CellTransform,
  AnnotationState,
} from '@osdlabel/viewer-api';
export { DEFAULT_CELL_TRANSFORM, getAllAnnotationsFlat } from '@osdlabel/viewer-api';

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
export { FabricOverlay, computeViewportTransform } from '@osdlabel/fabric-osd';
export type { OverlayOptions, OverlayMode } from '@osdlabel/fabric-osd';

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

// State
export {
  createAnnotationStore,
  createUIStore,
  createContextStore,
  createActions,
  AnnotatorProvider,
  useAnnotator,
  createConstraintStatus,
} from './state/index.js';
export type { AnnotatorProviderProps } from './state/annotator-context.js';

// Components
export { default as ViewerCell } from './components/ViewerCell.js';
export { default as Toolbar } from './components/Toolbar.js';
export { default as StatusBar } from './components/StatusBar.js';
export { default as ContextSwitcher } from './components/ContextSwitcher.js';
export { default as GridView } from './components/GridView.js';
export { default as Filmstrip } from './components/Filmstrip.js';
export { default as GridControls } from './components/GridControls.js';
export { ViewControls } from './components/ViewControls.js';
export { default as Annotator } from './components/Annotator.js';
export type { AnnotatorProps } from './components/Annotator.js';

// Hooks
export { useConstraints } from './hooks/useConstraints.js';
export { useKeyboard, DEFAULT_KEYBOARD_SHORTCUTS } from './hooks/useKeyboard.js';
