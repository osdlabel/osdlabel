import type { CellTransform, ViewerControlId } from '@osdlabel/viewer-api';

/**
 * Drag parameters for one {@link ViewerControlId}. Framework-agnostic so the
 * Solid and React `useAnnotationTool` hooks configure the drag identically —
 * only the dispatch of the new value is framework-specific.
 */
export interface ViewerControlSpec {
  /** Drag axis driving the value. */
  readonly axis: 'x' | 'y';
  /** Value-units changed per CSS pixel of drag. */
  readonly sensitivity: number;
  /** Resolution of change the drag quantizes to. */
  readonly step: number;
  readonly min: number;
  readonly max: number;
  /** Read the control's current value from a cell transform. */
  readonly getValue: (transform: CellTransform) => number;
}

/**
 * Registry of the drag-driven viewer controls. Exposure drags vertically
 * (up = brighter); contrast drags horizontally (right = more contrast),
 * matching the window/level convention of medical image viewers.
 */
export const VIEWER_CONTROL_SPECS: Readonly<Record<ViewerControlId, ViewerControlSpec>> = {
  exposure: {
    axis: 'y',
    sensitivity: 0.01,
    step: 0.025,
    min: -1,
    max: 1,
    getValue: (transform) => transform.exposure,
  },
  contrast: {
    axis: 'x',
    sensitivity: 0.01,
    step: 0.025,
    min: -1,
    max: 1,
    getValue: (transform) => transform.contrast,
  },
} as const;
