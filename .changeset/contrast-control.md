---
'osdlabel': minor
'@osdlabel/solid': minor
'@osdlabel/react': minor
'@osdlabel/viewer-api': minor
'@osdlabel/fabric-osd': minor
---

Add per-cell contrast control alongside the existing brightness (exposure) control.

- `CellTransform` gains `contrast` (−1…1, `0` = unchanged, mapped to CSS `contrast(0…2)`), with new `INCREASE_CONTRAST` / `DECREASE_CONTRAST` / `SET_CONTRAST` UI actions and `increaseActiveImageContrast` / `decreaseActiveImageContrast` / `setActiveImageContrast` on both framework action sets.
- `ViewControls` (Solid + React) gains decrease / value / increase buttons and a drag-to-adjust toggle for contrast; `Reset` now also clears contrast. New shortcuts: `Shift+C` (increase) and `Shift+X` (decrease).
- `ViewerControlId` is now `'exposure' | 'contrast'`, and the drag parameters for both live in the new shared `VIEWER_CONTROL_SPECS` registry so Solid and React behave identically. Contrast drags along the x-axis (right = more contrast); exposure keeps its y-axis drag.
- **Breaking (low-level API):** `FabricOverlay.applyImageFilters` now takes a single object — `applyImageFilters({ exposure, contrast, inverted })` — instead of positional `(exposure, inverted)` arguments. The filter string itself is composed by the newly exported pure helper `composeImageFilterCss`, which emits `brightness()`, then `contrast()`, then `invert()`.
