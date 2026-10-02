---
'osdlabel': minor
'@osdlabel/solid': minor
'@osdlabel/react': minor
---

Make the filmstrip usable from the keyboard and by assistive tech, and stop Enter on a focused button from also firing a shortcut (#189).

**Enter on a focused button no longer also fires a shortcut.** The keyboard shortcuts listen on `window`, so they saw the same Enter or Space that the browser turns into a click on a focused button. `Enter` is the polyline-finish binding: activating the filmstrip's clear button from the keyboard with a polyline in progress finished the polyline _and_ emptied the cell. The shortcuts now leave Enter and Space to a focused `<button>` or `role="button"` element. Every other key still reaches them from a focused button, so tabbing through the toolbar does not switch off `r`, `Delete` or the grid digits. The rule is exported as `shouldSkipKeyboardShortcut(target, key)`, and both framework hooks use it alongside the existing `<input>` / `<textarea>` / contenteditable skip, which it now also covers.

**Thumbnails are buttons.** Assigning an image was mouse-only: each thumbnail was a `<div onClick>`. It is now a `<button>`, reachable with Tab and operated with Enter or Space, named with the image and its assignment state for assistive tech (e.g. "Landscape, shown in the active cell") and marked `aria-current` when it is the active cell's image. `getCellAssignmentLabel` and `CELL_ASSIGNMENT_STATE_LABEL` export that wording. The thumbnail wrapper keeps its `data-testid`, `data-assignment` and border, and now holds two sibling buttons, assign and clear, so no control is nested inside another. Each thumbnail button also carries `data-testid="filmstrip-thumb-<imageId>"`.

**Focus after a keyboard clear.** The clear button unmounts with the assignment, so focus fell to `<body>`. When the clear was made from the keyboard, focus now moves to the same image's thumbnail, where Enter puts the image back. A mouse clear leaves focus where it was.

Like the toolbar, a mouse click on a thumbnail or the clear button no longer leaves keyboard focus on it (`preventButtonFocusSteal`), so a later Enter cannot re-press it.
