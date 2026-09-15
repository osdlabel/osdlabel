---
'osdlabel': minor
'@osdlabel/solid': minor
'@osdlabel/react': minor
---

Let a grid cell be emptied again: clicking the image the active cell already shows now clears it.

Once a cell had been assigned an image there was no way back to the empty state. Reassigning worked, unassigning did not, and the natural toggle — a second click on the same thumbnail — was a no-op (#183).

The empty state was never unsupported, only unreachable. `GridView` already renders the "Assign an image" placeholder for an unassigned cell, every cell starts that way, and `activeImageId` is `ImageId | undefined` throughout the stack — `getSelectableContexts` even documents the no-image case. What was missing was a way to re-enter it.

- `osdlabel` gains a `UNASSIGN_IMAGE_FROM_CELL` UI action, which deletes the cell's grid assignment and its view transform. Dropping the transform mirrors `ASSIGN_IMAGE_TO_CELL`, which resets it on every assignment.
- Both framework `actions` objects gain `unassignImageFromCell(cellIndex)`.
- `osdlabel` exports `getCellAssignmentState`, `resolveFilmstripClick`, `getGridCellCount`, the `CellAssignmentState` / `CellAssignmentView` / `FilmstripClickAction` types, and the shared `CELL_ASSIGNMENT_*` palette. Both filmstrips route their click through `resolveFilmstripClick`, so the two frameworks cannot disagree about what a click does — or about which cell it acts on. The helpers take the UI state rather than pre-computed indices, so a caller cannot derive one of the inputs wrongly.
- `SET_GRID_DIMENSIONS` now clamps `activeCellIndex` into the resized grid, from both ends, so a zero-cell grid cannot leave it negative and unrepairable. The clamp in both `GridControls` components is removed: the reducer owns the invariant, and the React copy was reading a pre-dispatch snapshot.
- The cell-selection shortcuts (digits 1-9) are screened against the current grid size. They previously mapped a digit to a fixed cell index regardless of how many cells existed, so on the default 1x1 grid pressing `2` activated a cell nobody could see — which left the filmstrip's clear affordance unreachable and turned every thumbnail click into a write that only surfaced when the grid was later widened. `SET_ACTIVE_CELL` itself stays unvalidated, so callers may still restore a saved active cell before sizing the grid.

Assignments for cells pruned by a shrink are still kept, so a shrink/expand round trip restores them; the cell-assignment helpers scope by the grid's cell count and ignore cells outside it.

The filmstrip highlight had to change with it. It previously meant "assigned to _some_ cell", while the toggle is necessarily keyed on the _active_ cell — so a blue thumbnail belonging to a different cell would have promised a clear and delivered an assign. Thumbnails now distinguish three states, exposed as a `data-assignment` attribute for testing: `active` (bright blue, with a `✕` badge — clicking clears the active cell), `other` (muted blue — shown elsewhere, clicking assigns it here), and `none` (grey).

Annotations are unaffected by clearing a cell: `AnnotationState.byImage` is keyed by image, independent of grid placement, so they survive and reappear on reassignment. `selectedAnnotationId` is deliberately left intact, since another cell may still be displaying the image it belongs to.

Note for existing callers: a click on the thumbnail already in the active cell used to be a redundant re-assign and is now a clear. Code or tests that clicked a thumbnail to guarantee assignment should check the state first, or assign through `assignImageToCell` directly.
