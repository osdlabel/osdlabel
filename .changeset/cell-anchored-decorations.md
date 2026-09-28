---
'osdlabel': minor
'@osdlabel/annotation': minor
'@osdlabel/annotation-context': minor
'@osdlabel/decoration': minor
'@osdlabel/fabric-annotations': minor
'@osdlabel/fabric-osd': minor
'@osdlabel/geometry': minor
'@osdlabel/osd-helper': minor
'@osdlabel/react': minor
'@osdlabel/solid': minor
'@osdlabel/validation': minor
'@osdlabel/viewer-api': minor
---

Add cell-anchored ("HUD") decorations (#185).

`TextDecoration` and `DomDecoration` gain an optional `anchorSpace: 'image' | 'cell'`. The new `'cell'` space expresses `anchor` as a fraction of the cell's own size (`{x:0,y:0}` top-left, `{x:1,y:1}` bottom-right) instead of image pixels, so the decoration stays fixed in the cell's viewport through pan, zoom, rotate, and flip — ideal for a fixed readout in a corner of the view. `offset` and `placement` apply identically in both spaces.

`TextPlacement` grows three corner values (`'top-right'`, `'bottom-left'`, `'bottom-right'`), for nine placements total, usable with either `anchorSpace`.

Additive and backward-compatible: `anchorSpace` defaults to `'image'`, matching all existing decorations unchanged.
