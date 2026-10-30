---
'@osdlabel/fabric-annotations': minor
'osdlabel': minor
---

A click without a drag no longer saves an invisible shape.

With the rectangle, circle or line tool, a click without a drag committed a zero-size annotation. Nothing was painted, yet it carried decorations (a badge, a label, `r: 0.00 px`) at an empty spot, could be selected only by clicking that spot, and counted toward the context's `maxCount`: two stray clicks used up a context's two rectangles while the image showed none.

Now, on release, a shape smaller than 3 screen pixels is discarded and its preview removed: a rectangle whose shorter side is under 3 px, a circle whose diameter is, a line whose length is. The minimum is in screen pixels, so it means the same at every zoom; to draw something smaller, zoom in. The point tool is unchanged, since a click is how a point is placed.

The minimum is exported as `MIN_SHAPE_SCREEN_PX` from `@osdlabel/fabric-annotations`, `osdlabel` and both bindings. A host's own `ShapeTool` subclass keeps committing every gesture unless it overrides the new `previewScreenSize(preview)`, which can measure with `screenDistance(a, b)`.
