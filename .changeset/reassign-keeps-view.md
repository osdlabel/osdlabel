---
'osdlabel': patch
'@osdlabel/solid': patch
'@osdlabel/react': patch
---

Re-assigning the image a cell already shows no longer resets the cell's view (#212).

`ASSIGN_IMAGE_TO_CELL` reset the cell's view transform even when the cell already showed that image. So pressing the active cell's own filmstrip thumbnail (a click, or Enter or Space on the focused thumbnail) silently threw away its rotation, flip, negative, exposure and contrast, with nothing visible changing and no undo. Assigning the same image is now a no-op. Assigning a different image still starts it from a fresh view.

Also, `onAnnotationRenderError`'s parameter is now named `failure` in its type, since it receives an `AnnotationRenderFailure` record whose `error` field holds what was thrown. Nothing changes at runtime or in types.
