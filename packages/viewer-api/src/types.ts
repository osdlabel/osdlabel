import type { Annotation, AnnotationId, ToolType, ImageId } from '@osdlabel/annotation';

// ── Cell Transform ───────────────────────────────────────────────────────

/** Per-cell visual adjustments (not serialized) */
export interface CellTransform {
  readonly rotation: number; // degrees (0, 90, 180, 270)
  readonly flippedH: boolean;
  readonly flippedV: boolean;
  readonly exposure: number; // -1 to 1 (0 = default, maps to CSS brightness 0.0–2.0)
  readonly inverted: boolean; // false = normal, true = CSS invert(1)
}

export const DEFAULT_CELL_TRANSFORM: CellTransform = {
  rotation: 0,
  flippedH: false,
  flippedV: false,
  exposure: 0,
  inverted: false,
};

// ── State Types ──────────────────────────────────────────────────────────
// Note: State container types intentionally omit `readonly` — SolidJS store
// proxies enforce immutability at runtime, and `readonly` here would conflict
// with SolidJS's `SetStoreFunction` path-based API. Data model types above
// (Annotation, Geometry, etc.) remain fully `readonly`.

/** UI state */
export interface UIState {
  activeTool: ToolType | 'select' | null;
  activeCellIndex: number;
  gridColumns: number;
  gridRows: number;
  gridAssignments: Record<number, ImageId>;
  selectedAnnotationId: AnnotationId | null;
  cellTransforms: Record<number, CellTransform>;
}

/** Root state for the annotation system */
export interface AnnotationState<E extends object = Record<string, never>> {
  byImage: Record<ImageId, Record<AnnotationId, Annotation<E>>>;
  /** Monotonically increasing counter; incremented on every mutation for O(1) change detection */
  changeCounter: number;
}

// ── Keyboard Shortcuts ───────────────────────────────────────────────────

/** Keyboard shortcut map */
export interface KeyboardShortcutMap {
  readonly selectTool: string;
  readonly rectangleTool: string;
  readonly circleTool: string;
  readonly lineTool: string;
  readonly pointTool: string;
  readonly polylineTool: string;
  readonly freeHandPathTool: string;
  readonly cancel: string;
  readonly delete: string;
  readonly deleteAlt: string;
  readonly gridCell1: string;
  readonly gridCell2: string;
  readonly gridCell3: string;
  readonly gridCell4: string;
  readonly gridCell5: string;
  readonly gridCell6: string;
  readonly gridCell7: string;
  readonly gridCell8: string;
  readonly gridCell9: string;
  readonly increaseGridColumns: string;
  readonly decreaseGridColumns: string;
  readonly increaseGridRows: string;
  readonly decreaseGridRows: string;
  readonly polylineFinish: string;
  readonly polylineClose: string;
  readonly polylineCancel: string;
  readonly rotateCW: string;
  readonly rotateCCW: string;
  readonly flipHorizontal: string;
  readonly flipVertical: string;
  readonly resetView: string;
  readonly toggleNegative: string;
  readonly increaseExposure: string;
  readonly decreaseExposure: string;
}
