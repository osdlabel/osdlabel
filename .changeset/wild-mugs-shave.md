---
'@osdlabel/osd-helper': patch
'@osdlabel/solid': patch
'@osdlabel/react': patch
---

Fix viewer zoom: the fitted view is reachable again, and a click no longer zooms

The viewer cells configured OpenSeadragon with an absolute `minZoomLevel: 0.5`.
Home zoom (the "fit the image" zoom) is `imageAspect / containerAspect` whenever
the image is taller than its cell, which is often well below `0.5`, so OSD's
`applyConstraints()` — which runs on every mouse-up — snapped the view in and
then refused to zoom back out far enough to fit the image again. The floor is now
`minZoomImageRatio: 0.5`, which is relative to home zoom.

Plain clicks also zoomed in 2x via OSD's default `clickToZoom`. Clicking a cell
now leaves the view where it is; double-click and the scroll wheel still zoom.

Both defaults now live in the new `DEFAULT_VIEWER_OPTIONS` export from
`@osdlabel/osd-helper`, shared by the SolidJS and React viewer cells.
