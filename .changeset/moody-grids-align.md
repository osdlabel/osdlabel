---
'@osdlabel/solid': patch
'@osdlabel/react': patch
---

Move the annotator's grid-layout button out of the toolbar's right edge

`<Annotator showGridControls>` pinned the grid-layout button to the far right of
the toolbar with `margin-left: auto`. Its hover popover is anchored to the
button's left edge and opens rightward, so in a narrow annotator container the
popover ran past the right edge and was clipped. The button now sits in the
toolbar's normal flow, right after the drawing tools, leaving the popover room
to open inside the container at any width.
