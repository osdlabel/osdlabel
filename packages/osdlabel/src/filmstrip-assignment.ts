import type { ImageId } from '@osdlabel/viewer-api';

/**
 * How a filmstrip image relates to the grid cell the user is currently acting
 * on.
 *
 * - `'active'` — displayed in the active cell. Clicking it clears that cell.
 * - `'other'`  — displayed in some other cell, but not the active one.
 *                Clicking it assigns it into the active cell.
 * - `'none'`   — not displayed anywhere. Clicking it assigns it into the
 *                active cell.
 *
 * The distinction between `'active'` and `'other'` is what lets the filmstrip
 * highlight match the gesture it offers: only `'active'` toggles off.
 */
export type AssignmentState = 'active' | 'other' | 'none';

/**
 * Derives an image's {@link AssignmentState} from the current grid assignments.
 *
 * Framework-agnostic so the SolidJS and React filmstrips share one definition
 * of the three states rather than each re-deriving them.
 */
export function getCellAssignmentState(
  gridAssignments: Readonly<Record<number, ImageId>>,
  activeCellIndex: number,
  imageId: ImageId,
): AssignmentState {
  if (gridAssignments[activeCellIndex] === imageId) return 'active';
  return Object.values(gridAssignments).some((id) => id === imageId) ? 'other' : 'none';
}
