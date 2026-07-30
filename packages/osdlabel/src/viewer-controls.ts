import type { CellTransform, ViewerControlId } from '@osdlabel/viewer-api';

/** A cell-transform field a drag axis can drive. */
export type ToneField = 'exposure' | 'contrast';

/** Read the tonal field a drag axis drives from a cell transform. */
export function getToneValue(transform: CellTransform, field: ToneField): number {
  return field === 'exposure' ? transform.exposure : transform.contrast;
}

/** How one axis of a drag-driven viewer control maps onto a value. */
export interface ViewerControlAxisSpec {
  /** The cell-transform field this axis adjusts. */
  readonly field: ToneField;
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
}

/**
 * Drag parameters for one {@link ViewerControlId}. Framework-agnostic so the
 * Solid and React `useAnnotationTool` hooks configure the drag identically —
 * only the dispatch of the new value is framework-specific. A control may drive
 * one value per axis; omit an axis to ignore drags along it.
 */
export interface ViewerControlSpec {
  readonly x?: ViewerControlAxisSpec | undefined;
  readonly y?: ViewerControlAxisSpec | undefined;
}

/**
 * Registry of the drag-driven viewer controls.
 *
 * `tone` is a single two-axis gesture: horizontal drag adjusts exposure (left =
 * brighter), vertical drag adjusts contrast (up = more contrast). Because each
 * axis only writes when its own value changes, one armed control covers both —
 * drag diagonally to adjust both at once, or along a single axis to adjust just
 * that one, with no mode switch in between.
 */
export const VIEWER_CONTROL_SPECS: Readonly<Record<ViewerControlId, ViewerControlSpec>> = {
  tone: {
    x: {
      field: 'exposure',
      // Leftward = brighter, so the x-axis's rightward default is reversed.
      invert: true,
      sensitivity: 0.01,
      step: 0.025,
      min: -1,
      max: 1,
    },
    y: {
      field: 'contrast',
      // Upward = more contrast, which is the y-axis default.
      invert: false,
      sensitivity: 0.01,
      step: 0.025,
      min: -1,
      max: 1,
    },
  },
} as const;
