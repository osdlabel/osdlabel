---
'osdlabel': minor
'@osdlabel/solid': minor
'@osdlabel/react': minor
---

Let a grid cell be emptied again, from a dedicated clear button on the filmstrip thumbnail.

Once a cell had been assigned an image there was no way back to the empty state. Reassigning worked; unassigning did not exist at any layer (#183).

The empty state was never unsupported, only unreachable. `GridView` already renders the "Assign an image" placeholder for an unassigned cell, every cell starts that way, and `activeImageId` is `ImageId | undefined` throughout the stack — `getSelectableContexts` even documents the no-image case. What was missing was a way to re-enter it.

- `osdlabel` gains a `UNASSIGN_IMAGE_FROM_CELL` UI action, which deletes the cell's grid assignment and its view transform. Dropping the transform mirrors `ASSIGN_IMAGE_TO_CELL`, which resets it on every assignment.
- Both framework `actions` objects gain `unassignImageFromCell(cellIndex)`.
- `osdlabel` exports `getCellAssignmentState`, `getGridCellCount`, the `CellAssignmentState` / `CellAssignmentView` / `GridDimensions` types, and the shared `CELL_ASSIGNMENT_*` palette (including `CELL_ASSIGNMENT_CLEAR_LABEL` for the clear button's accessible name). The helpers take the UI state rather than pre-computed indices, so a caller cannot derive one of the inputs wrongly.
- **`activeCellIndex` is now an invariant of the reducer: it always addresses a cell the grid renders.** `SET_ACTIVE_CELL` and `SET_GRID_DIMENSIONS` both clamp into the current grid, from both ends, and `SET_GRID_DIMENSIONS` floors the grid at one cell — so no sequence of actions can leave the active cell pointing off screen. `setGridDimensions(0, 0)` now yields a 1×1 grid rather than a grid with no cells.

  Both take raw `number`s from public API, so both normalise before clamping: a fractional index is truncated (`setActiveCell(1.5)` selects cell 1 — a clamp alone would accept 1.5, which is in range by every comparison yet keys nothing in `gridAssignments`), and non-finite input falls back to a real cell rather than propagating (`Math.max(1, NaN)` is `NaN`, which would poison every clamp derived from the grid size). Everything keyed on the active cell — the image it shows, its view transform, the tools it enables — therefore reads state the user can actually see, with no scoping at the point of use. The clamp in both `GridControls` components is removed; the reducer owns this.

  **This imposes an ordering rule on hosts:** size the grid before restoring a saved active cell. `setActiveCell(3)` against a 1×1 grid clamps to 0 rather than being remembered until the grid grows.

- The cell-selection shortcuts (digits 1-9) are screened against the current grid size. They previously mapped a digit to a fixed cell index regardless of how many cells existed, so on the default 1x1 grid pressing `2` selected a cell that does not exist. Screened rather than clamped: pressing `9` on a 1×1 grid should do nothing, not snap the selection to cell 0.

Assignments for cells pruned by a shrink are still kept, so a shrink/expand round trip restores the image that cell was showing (its view transform is reset, as on any assignment). Note the asymmetry this creates with the clamp above: the same round trip does **not** restore the active cell, which stays where the shrink clamped it. The viewer-grid guide documents it, since `-` then `=` is an ordinary thing for a user to do. `getCellAssignmentState` scopes `'other'` by the grid's cell count for exactly that reason — a retained assignment must not make the filmstrip describe a cell nobody can see.

**Clearing is a separate control, not a second click on the thumbnail.** The `✕` badge on the active cell's thumbnail is a real `<button>`: focusable, labelled for assistive tech, and the only thing that empties a cell. A thumbnail click only ever assigns, so it stays idempotent and there is no behavioural change for existing callers. The reason is double-click: if a thumbnail both assigned and cleared, clicking an unassigned thumbnail twice — an extremely common habit — would assign and then immediately wipe the cell, discarding its rotation, flip, exposure and contrast with no undo.

The filmstrip highlight changed with it. It previously meant "assigned to _some_ cell"; it now distinguishes three states, exposed as a `data-assignment` attribute for testing: `active` (bright blue, carries the `✕` button), `other` (muted blue — shown in another cell), and `none` (grey). Only `active` offers the clear, so the highlight matches the controls the thumbnail actually has.

Annotations are unaffected by clearing a cell: `AnnotationState.byImage` is keyed by image, independent of grid placement, so they survive and reappear on reassignment. `selectedAnnotationId` is deliberately left intact, since another cell may still be displaying the image it belongs to.

Cell indices are normalised the same way by all three actions that take one (`SET_ACTIVE_CELL`, `ASSIGN_IMAGE_TO_CELL`, `UNASSIGN_IMAGE_FROM_CELL`): truncated to a whole number, floored at 0, with non-finite input mapped to cell 0. `gridAssignments` and `cellTransforms` are keyed by whole numbers, so `assignImageToCell(1.5, id)` previously wrote a `"1.5"` key that no reader ever looked up. Normalising is not screening — an index outside the current grid is still accepted, because a shrink deliberately keeps those assignments for a later expand. Only the _active_ cell is clamped into the grid.
