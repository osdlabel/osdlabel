---
'osdlabel': minor
'@osdlabel/annotation': minor
'@osdlabel/annotation-context': minor
'@osdlabel/decoration': minor
'@osdlabel/fabric-annotations': minor
'@osdlabel/fabric-osd': minor
'@osdlabel/osd-helper': minor
'@osdlabel/react': minor
'@osdlabel/solid': minor
'@osdlabel/validation': minor
'@osdlabel/viewer-api': minor
---

Add a `customControl` overlay mode that forwards mouse click/drag input to a registered handler instead of OpenSeadragon or the Fabric annotation layer.

- `FabricOverlay` gains the `customControl` mode, a `CustomControlHandler` contract, and `setCustomControlHandler()`. A `setMode` no-op guard prevents redundant re-applies from clobbering an in-progress gesture.
- New framework-agnostic `createDragValueControl()` helper maps drag distance onto a clamped numeric value, reusable for any drag-driven viewer function.
- New `UIState.activeViewerControl` (`ViewerControlId`) field, mutually exclusive with `activeTool`, drives the mode via the single existing mode-authority effect in both the SolidJS and React `useAnnotationTool` hooks.
- `ViewControls` (Solid + React) gains a drag-to-adjust-exposure toggle button as the first use case.
