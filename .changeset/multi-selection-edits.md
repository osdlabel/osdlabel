---
'osdlabel': patch
'@osdlabel/fabric-annotations': patch
'@osdlabel/fabric-osd': patch
'@osdlabel/solid': patch
'@osdlabel/react': patch
---

Editing several annotations at once is saved.

Moving, resizing or rotating a multi-selection (a drag-box, or Shift+click, with the select tool) used to change only the canvas. Fabric reports such an edit about the selection, not its members, and nothing was committed: state, `serialize()` and `onAnnotationsChange` kept the old shapes, and the next rebuild of the canvas (switching image and back, an import, committing another edit) put them back. Each member is now committed with the geometry and Fabric data it is painted with, all as one change, and the selection stays selected.

**A multi-selection keeps its proportions.** It has corner and rotation handles only, its corners scale it uniformly even with Shift held, and it cannot be skewed. Stretching a selection used to bake a skew into a rotated rectangle, or turn a circle into an ellipse, which their geometry cannot record.

**Only the select tool selects by drag-box.** Dragging a drawing tool across existing annotations no longer leaves them selected as a group. `FabricOverlay.setMode('annotation')` now leaves Fabric's `canvas.selection` off, and `SelectTool` turns it on while it is active. A host that drives `FabricOverlay` without the library's tools and wants drag-box selection sets `overlay.canvas.selection = true` itself.

**One drag is one commit, in both bindings.** Solid committed a drag of a single annotation twice: its rebuild removed the object while Fabric was still reporting the edit, and Fabric reported it again. A commit now waits for a microtask, until Fabric has finished the pointer release, so the state update follows `object:modified` a microtask later in both bindings.

**New API.** `actions.updateAnnotations(imageId, updates)`, in both bindings, updates several annotations of one image as one change (one rebuild, one `onAnnotationsChange`). It dispatches the new `UPDATE_ANNOTATIONS` member of `AnnotationAction`, typed with the new `AnnotationPatch` and `AnnotationUpdate`; a host that switches exhaustively over `AnnotationAction` needs a case for it. `osdlabel` exports the commit both bindings run, `enableObjectModifiedCommits`, and `processGroupModified`. `@osdlabel/fabric-annotations` exports the Fabric half: `isGroupSelection`, `configureGroupSelection`, `dissolveGroupSelection` and `reselectWhenAdded`. A multi-selection names no single annotation as selected (`selectedAnnotationId` is `null`); one made by Shift+click used to name the annotation clicked last.
