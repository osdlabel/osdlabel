import type { ImageId, UIState } from '@osdlabel/viewer-api';

/**
 * The slice of {@link UIState} the cell-assignment helpers read.
 *
 * The helpers take this state rather than pre-computed indices so that no
 * caller derives an input itself — in particular the cell count, which is
 * `gridColumns * gridRows` and silently wrong for every cell below the first
 * row if either factor is forgotten.
 */
export type CellAssignmentView = Pick<
  UIState,
  'gridAssignments' | 'activeCellIndex' | 'gridColumns' | 'gridRows'
>;

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

/** The grid's size, as {@link getGridCellCount} needs it. */
export type GridDimensions = Pick<UIState, 'gridColumns' | 'gridRows'>;

/** What a click on a filmstrip thumbnail should do. */
export type FilmstripClickAction =
  | { readonly type: 'assign'; readonly cellIndex: number; readonly imageId: ImageId }
  | { readonly type: 'unassign'; readonly cellIndex: number };

/**
 * Number of cells the grid currently renders.
 *
 * Takes only the dimensions so every caller that needs the count — including
 * the keyboard mapper, which has no grid assignments — can share it rather than
 * multiplying the two fields itself.
 */
export function getGridCellCount(grid: GridDimensions): number {
  return grid.gridColumns * grid.gridRows;
}

/**
 * Whether `imageId` occupies any cell inside the visible grid.
 *
 * Scanning indices below the cell count rather than enumerating the record
 * matters: `SET_GRID_DIMENSIONS` deliberately leaves assignments for pruned
 * cells in place so a shrink/expand round trip restores them, so the record
 * outlives the grid and enumeration would count a cell nobody can see.
 */
function isShownInAnyCell(view: CellAssignmentView, imageId: ImageId): boolean {
  const cellCount = getGridCellCount(view);
  for (let index = 0; index < cellCount; index += 1) {
    if (view.gridAssignments[index] === imageId) return true;
  }
  return false;
}

/**
 * Derives an image's {@link CellAssignmentState}.
 *
 * Framework-agnostic so the SolidJS and React filmstrips share one definition
 * of the three states rather than each re-deriving them.
 */
export function getCellAssignmentState(
  view: CellAssignmentView,
  imageId: ImageId,
): CellAssignmentState {
  // Both states are scoped by the cell count, for two different reasons.
  //
  // `'other'` must be, because assignments outlive the cells a shrink pruned —
  // a retained assignment must not make the filmstrip describe a cell nobody
  // can see.
  //
  // `'active'` must be because this helper takes a plain `CellAssignmentView`,
  // not the store: `osdlabel` is the framework-agnostic package, and a host
  // driving it with its own state is not bound by the reducer's in-grid
  // invariant. Trusting that invariant here would let a stray
  // `activeCellIndex` of 7 on a 1x1 grid report `'active'`, painting a
  // thumbnail bright blue with a clear affordance for a cell nobody renders.
  //
  // Note what this does and does not fix. Once the active cell is out of the
  // grid, every outcome names an invisible cell — `resolveFilmstripClick`
  // targets `activeCellIndex` for the assign too, and there is no better cell
  // to substitute, since the host's index is simply wrong. What the scope buys
  // is that the *destructive* outcome is not chosen on the strength of a cell
  // nobody can see: `UNASSIGN_IMAGE_FROM_CELL` deletes the cell's view
  // transform, an assign only overwrites it. Keeping the reducer's invariant
  // intact is what keeps this branch unreachable in the shipped UI.
  const cellCount = getGridCellCount(view);
  const activeIndex = view.activeCellIndex;
  if (activeIndex >= 0 && activeIndex < cellCount) {
    if (view.gridAssignments[activeIndex] === imageId) return 'active';
  }
  return isShownInAnyCell(view, imageId) ? 'other' : 'none';
}

/**
 * Resolves a click on a filmstrip thumbnail into the state change it should
 * cause: clicking the image the active cell already shows clears that cell,
 * anything else assigns into it.
 *
 * Pure and shared so both framework filmstrips route a click through one tested
 * decision — in particular one that always names the *active* cell.
 */
export function resolveFilmstripClick(
  view: CellAssignmentView,
  imageId: ImageId,
): FilmstripClickAction {
  const state = getCellAssignmentState(view, imageId);
  return state === 'active'
    ? { type: 'unassign', cellIndex: view.activeCellIndex }
    : { type: 'assign', cellIndex: view.activeCellIndex, imageId };
}

/**
 * Thumbnail border colour per state. Bright blue is reserved for the cell a
 * click will act on; the muted blue means "in use, but in another cell".
 *
 * These live here, rather than in each framework's `Filmstrip`, so the two
 * cannot drift into disagreeing about what a colour means, for the same reason
 * `VIEWER_CONTROL_SPECS` is shared from here. Keying them on
 * {@link CellAssignmentState} also makes a newly
 * added state a compile error at every map. Note the copy below is not
 * localizable yet; there is no i18n seam in the library.
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
