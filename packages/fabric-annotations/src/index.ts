export * from './fabric-module.js';
export * from './fabric-utils.js';
export { buildFabricObjectFromGeometry } from './build-fabric-object.js';
export type { ToolOverlay, FabricFields, FabricRawAnnotationData } from './types.js';
export type { AnnotationTool, ToolCallbacks, AddAnnotationParams } from './tools/base-tool.js';
export { BaseTool } from './tools/base-tool.js';
export { ShapeTool } from './tools/shape-tool.js';
export { RectangleTool } from './tools/rectangle-tool.js';
export { CircleTool } from './tools/circle-tool.js';
export { LineTool } from './tools/line-tool.js';
export { PointTool } from './tools/point-tool.js';
export { PolylineTool } from './tools/polyline-tool.js';
export { FreeHandPathTool } from './tools/free-hand-path-tool.js';
export { SelectTool } from './tools/select-tool.js';
export { SegmentationTool } from './tools/segmentation-tool.js';
export type { SegmentationToolConfig } from './tools/segmentation-tool.js';
export {
  PolyVertexEditor,
  DEFAULT_VERTEX_EDIT_LONG_PRESS_MS,
  DEFAULT_VERTEX_EDIT_MOVE_TOLERANCE_PX,
} from './poly-vertex-editor.js';
export type { PolyVertexEditorOptions, VertexEditConfig } from './poly-vertex-editor.js';
