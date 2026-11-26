/**
 * The state the Rust shell draws from. Built by a pure function so its shape
 * can be checked against `contract/snapshot.json`, which the crate's tests
 * decode.
 */
// Leaf packages rather than `@osdlabel/solid`, so the unit tests can import
// this without loading Fabric and OpenSeadragon.
import type { ToolType } from '@osdlabel/annotation';
import type { ConstraintStatus, ContextState } from '@osdlabel/annotation-context';
import {
  DEFAULT_CELL_TRANSFORM,
  type AnnotationState,
  type ImageSource,
  type UIState,
} from '@osdlabel/viewer-api';
import type { OsdFields } from 'osdlabel';

export interface Snapshot {
  readonly activeTool: ToolType | 'select' | null;
  readonly activeContextId: string | null;
  readonly contexts: readonly { readonly id: string; readonly label: string }[];
  readonly images: readonly {
    readonly id: string;
    readonly label: string;
    readonly count: number;
  }[];
  readonly activeImageId: string | null;
  readonly selectedAnnotationId: string | null;
  readonly constraints: Readonly<
    Record<
      string,
      { readonly enabled: boolean; readonly current: number; readonly max: number | null }
    >
  >;
  /** The active image's annotations, oldest first. */
  readonly annotations: readonly {
    readonly id: string;
    readonly tool: string;
    readonly context: string;
    /** Painted on the canvas: its context is the active or a displayed one (ViewerCell's rule). */
    readonly visible: boolean;
  }[];
  readonly transform: {
    readonly rotation: number;
    readonly flippedH: boolean;
    readonly flippedV: boolean;
    readonly inverted: boolean;
    readonly exposure: number;
    readonly contrast: number;
  };
  readonly grid: { readonly columns: number; readonly rows: number };
  readonly activeCell: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** The outcome of something that finished after its command returned (an import). */
  readonly notice: { readonly seq: number; readonly text: string } | null;
}

export interface SnapshotInput {
  readonly ui: UIState;
  readonly contexts: ContextState;
  readonly annotations: AnnotationState<OsdFields>;
  readonly constraints: ConstraintStatus;
  readonly images: readonly ImageSource[];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly notice: Snapshot['notice'];
}

export function buildSnapshot(input: SnapshotInput): Snapshot {
  const {
    ui,
    contexts: ctx,
    annotations: { byImage },
  } = input;
  const imageId = ui.gridAssignments[ui.activeCellIndex] ?? null;
  const shown = new Set<string>(ctx.displayedContextIds);
  if (ctx.activeContextId) shown.add(ctx.activeContextId);
  const labelOf = (id: string) => ctx.contexts.find((c) => c.id === id)?.label ?? id;
  const t = ui.cellTransforms[ui.activeCellIndex] ?? DEFAULT_CELL_TRANSFORM;
  return {
    activeTool: ui.activeTool,
    activeContextId: ctx.activeContextId,
    contexts: ctx.contexts.map((c) => ({ id: c.id, label: c.label })),
    images: input.images.map((img) => ({
      id: img.id,
      label: img.label ?? img.id,
      count: Object.keys(byImage[img.id] ?? {}).length,
    })),
    activeImageId: imageId,
    selectedAnnotationId: ui.selectedAnnotationId,
    constraints: Object.fromEntries(
      Object.entries(input.constraints).map(([tool, s]) => [
        tool,
        { enabled: s.enabled, current: s.currentCount, max: s.maxCount },
      ]),
    ),
    annotations: Object.values(imageId ? (byImage[imageId] ?? {}) : {})
      .sort((x, y) => x.createdAt.localeCompare(y.createdAt))
      .map((ann) => ({
        id: ann.id,
        tool: ann.toolType,
        context: labelOf(ann.contextId),
        visible: shown.size === 0 || shown.has(ann.contextId),
      })),
    transform: {
      rotation: t.rotation,
      flippedH: t.flippedH,
      flippedV: t.flippedV,
      inverted: t.inverted,
      exposure: t.exposure,
      contrast: t.contrast,
    },
    grid: { columns: ui.gridColumns, rows: ui.gridRows },
    activeCell: ui.activeCellIndex,
    canUndo: input.canUndo,
    canRedo: input.canRedo,
    notice: input.notice,
  };
}
