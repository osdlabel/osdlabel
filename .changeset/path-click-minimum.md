---
'@osdlabel/fabric-annotations': patch
---

Clicks at one spot no longer save an invisible polyline or polygon.

With the polyline tool, a click followed by a double click at the same spot, or two clicks there and `Enter`, saved a zero-length polyline, and three clicks there followed by `c` (or by a click back on the first point) saved a zero-area polygon. Nothing was painted, yet the annotation carried decorations at the spot and counted toward the context's `maxCount`.

Now a path whose points all lie within 3 screen pixels of one another (`MIN_SHAPE_SCREEN_PX`, the minimum the rectangle, circle and line tools already apply) is discarded when it is finished, however it is finished, and the tool is ready for a new path. A path that reaches 3 pixels in any direction is kept. The size is judged in screen pixels in the view at the moment the path is finished, so to draw something smaller, zoom in. The free-hand tool applies the same rule on release: at its default sampling a stroke that never leaves one spot was already dropped, but one sampled more finely (`minSampleDistancePx`) or zoomed out under the minimum before the release is now discarded too.

`BaseTool` gains two protected helpers for a host's own tools: `screenDistance(a, b)`, the on-screen distance a `ShapeTool` subclass measures its preview with, and `isSmallerOnScreenThan(points, minimum)`, the check both path tools use.
