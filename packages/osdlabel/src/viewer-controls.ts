import type { CellTransform, ViewerControlId } from '@osdlabel/viewer-api';

/**
 * Drag parameters for one {@link ViewerControlId}. Framework-agnostic so the
 * Solid and React `useAnnotationTool` hooks configure the drag identically —
 * only the dispatch of the new value is framework-specific.
 */
export interface ViewerControlSpec {
  /** Drag axis driving the value. */
  readonly axis: 'x' | 'y';
  /**
   * Reverse the axis's default direction (x increases rightward, y increases
   * upward), so "more" is leftward / downward instead.
   */
  readonly invert: boolean;
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
 * Registry of the drag-driven viewer controls. The two axes are split so both
 * can be adjusted without re-arming: exposure drags horizontally (left =
 * brighter) and contrast drags vertically (up = more contrast).
 */
export const VIEWER_CONTROL_SPECS: Readonly<Record<ViewerControlId, ViewerControlSpec>> = {
  exposure: {
    axis: 'x',
    // Leftward = brighter, so the x-axis's rightward default is reversed.
    invert: true,
    sensitivity: 0.01,
    step: 0.025,
    min: -1,
    max: 1,
    getValue: (transform) => transform.exposure,
  },
  contrast: {
    axis: 'y',
    // Upward = more contrast, which is the y-axis default.
    invert: false,
    sensitivity: 0.01,
    step: 0.025,
    min: -1,
    max: 1,
    getValue: (transform) => transform.contrast,
  },
} as const;
