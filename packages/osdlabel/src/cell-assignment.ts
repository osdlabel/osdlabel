import type { ImageId } from '@osdlabel/viewer-api';

/**
 * How a filmstrip image relates to the grid cell the user is currently acting
 * on.
 *
 * - `'active'` — displayed in the active cell. Clicking it clears that cell.
 * - `'other'`  — displayed in some other visible cell, but not the active one.
 *                Clicking it assigns it into the active cell.
 * - `'none'`   — not displayed in any visible cell. Clicking it assigns it into
 *                the active cell.
 *
 * The distinction between `'active'` and `'other'` is what lets the filmstrip
 * highlight match the gesture it offers: only `'active'` toggles off.
 */
export type CellAssignmentState = 'active' | 'other' | 'none';

/** What a click on a filmstrip thumbnail should do. */
export type FilmstripClickAction =
  | { readonly type: 'assign'; readonly cellIndex: number; readonly imageId: ImageId }
  | { readonly type: 'unassign'; readonly cellIndex: number };

/**
 * Whether `imageId` occupies any cell inside the visible grid.
 *
 * Scanning indices below `cellCount` rather than enumerating the record matters:
 * `SET_GRID_DIMENSIONS` deliberately leaves assignments for pruned cells in
 * place so a shrink/expand round trip restores them, so the record outlives the
 * grid and `Object.values` would count a cell nobody can see.
 */
function isShownInAnyCell(
  gridAssignments: Readonly<Record<number, ImageId>>,
  imageId: ImageId,
  cellCount: number,
): boolean {
  for (let index = 0; index < cellCount; index += 1) {
    if (gridAssignments[index] === imageId) return true;
  }
  return false;
}

/**
 * Derives an image's {@link CellAssignmentState}.
 *
 * Framework-agnostic so the SolidJS and React filmstrips share one definition
 * of the three states rather than each re-deriving them.
 *
 * `cellCount` is the number of cells the grid currently renders
 * (`gridColumns * gridRows`). An `activeCellIndex` outside it cannot be acted
 * on, so no image reports `'active'` against it — otherwise the filmstrip would
 * offer a clear affordance for a cell that is not on screen.
 */
export function getCellAssignmentState(
  gridAssignments: Readonly<Record<number, ImageId>>,
  activeCellIndex: number,
  imageId: ImageId,
  cellCount: number,
): CellAssignmentState {
  if (activeCellIndex >= 0 && activeCellIndex < cellCount) {
    if (gridAssignments[activeCellIndex] === imageId) return 'active';
  }
  return isShownInAnyCell(gridAssignments, imageId, cellCount) ? 'other' : 'none';
}

/**
 * Resolves a click on a filmstrip thumbnail into the state change it should
 * cause: clicking the image the active cell already shows clears that cell,
 * anything else assigns into it.
 *
 * Pure and shared so both framework filmstrips route a click through one tested
 * decision — in particular one that always names the *active* cell, which a
 * component computing the index itself can silently get wrong.
 */
export function resolveFilmstripClick(
  gridAssignments: Readonly<Record<number, ImageId>>,
  activeCellIndex: number,
  imageId: ImageId,
  cellCount: number,
): FilmstripClickAction {
  const state = getCellAssignmentState(gridAssignments, activeCellIndex, imageId, cellCount);
  return state === 'active'
    ? { type: 'unassign', cellIndex: activeCellIndex }
    : { type: 'assign', cellIndex: activeCellIndex, imageId };
}

/**
 * Thumbnail border colour per state. Bright blue is reserved for the cell a
 * click will act on; the muted blue means "in use, but in another cell".
 *
 * These live here, rather than in each framework's `Filmstrip`, so the two
 * cannot drift into disagreeing about what a colour means — the same reason
 * `VIEWER_CONTROL_SPECS` is shared. Keying them on {@link CellAssignmentState}
 * also makes a newly added state a compile error at every map.
 */
export const CELL_ASSIGNMENT_BORDER_COLOR: Readonly<Record<CellAssignmentState, string>> = {
  active: '#2196F3',
  other: '#1565C0',
  none: '#333',
};

/** Background for a thumbnail with no image, per state. */
export const CELL_ASSIGNMENT_PLACEHOLDER_BACKGROUND: Readonly<Record<CellAssignmentState, string>> =
  {
    active: '#2a3a5e',
    other: '#252d42',
    none: '#2a2a3e',
  };

/** Tooltip describing what a click will do, per state. */
export const CELL_ASSIGNMENT_TITLE: Readonly<Record<CellAssignmentState, string>> = {
  active: 'Click to remove this image from the active cell',
  other: 'Shown in another cell — click to also show it in the active cell',
  none: 'Click to show this image in the active cell',
};
