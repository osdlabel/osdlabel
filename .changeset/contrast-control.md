---
'osdlabel': minor
'@osdlabel/solid': minor
'@osdlabel/react': minor
'@osdlabel/viewer-api': minor
'@osdlabel/fabric-osd': minor
---

Add per-cell contrast control alongside the existing brightness (exposure) control.

- `CellTransform` gains `contrast` (−1…1, `0` = unchanged, mapped to CSS `contrast(0…2)`), with new `INCREASE_CONTRAST` / `DECREASE_CONTRAST` / `SET_CONTRAST` UI actions and `increaseActiveImageContrast` / `decreaseActiveImageContrast` / `setActiveImageContrast` on both framework action sets.
- `ViewControls` (Solid + React) gains decrease / value / increase buttons for contrast; `Reset` now also clears contrast. New shortcuts: `Shift+C` (increase) and `Shift+X` (decrease).
- **One unified drag control for both tonal axes.** A single toggle arms `tone`: horizontal drag adjusts exposure (left = brighter), vertical drag adjusts contrast (up = more contrast). Drag diagonally to change both in one gesture, or along a single axis to change just that one — no switching between controls. **Breaking:** `ViewerControlId` is now `'tone'`, replacing `'exposure'`; callers passing `'exposure'` to `setActiveViewerControl` must pass `'tone'`.
- New `createDragVectorControl` drives one value per axis in a single gesture, with per-axis sensitivity, step, clamp, direction and redundant-write suppression (so a horizontal-only drag never writes the vertical value). `createDragValueControl` keeps its single-axis API and now shares the same per-axis math.
- `createDragValueControl` also gains an `invert` option that reverses the axis's default direction (x rightward, y upward), so direction stays separable from the sensitivity magnitude.
- The drag parameters live in the new shared `VIEWER_CONTROL_SPECS` registry — now per-axis, each axis naming the `CellTransform` field it drives — so Solid and React behave identically.
- **Breaking (low-level API):** `FabricOverlay.applyImageFilters` now takes a single object — `applyImageFilters({ exposure, contrast, inverted })` — instead of positional `(exposure, inverted)` arguments. The filter string itself is composed by the newly exported pure helper `composeImageFilterCss`, which emits `brightness()`, then `contrast()`, then `invert()`.
