---
'@osdlabel/annotation': minor
'@osdlabel/fabric-annotations': minor
'osdlabel': minor
'@osdlabel/solid': minor
'@osdlabel/react': minor
---

Honour `ToolConstraint.defaultStyle` in the polyline and free-hand previews, and mark vertices while drawing.

`PolylineTool` and `FreeHandPathTool` hardcoded a translucent black dashed preview and only reached `defaultStyle` once the annotation was committed, so on dark imagery the whole drawing interaction happened blind. No vertex marker was drawn either, which left the 10px close target on the first vertex — the only route to a closed polygon — invisible.

- Both tools now build their preview from the resolved style via the new `getPreviewOptions(style, zoom)` (exported from `@osdlabel/fabric-annotations`), the way `ShapeTool` already did. The preview stays distinguishable from a committed annotation by being unfilled and dashed; the dash pattern comes from the style's `strokeDashArray` when it sets one, otherwise from `DEFAULT_PREVIEW_DASH_SCREEN_PX`. Stroke width and dash lengths are divided by zoom, matching the screen-pixel semantics `AnnotationStyle.strokeWidth` documents — measured in image pixels they collapse to a sub-pixel hairline whenever the image is larger than its viewport.
- The style-resolution merge moved to a shared `BaseTool.resolveStyle()`, and is re-resolved when the annotation is committed rather than reused from draw time, so switching annotation context mid-draw no longer stores a shape under one context painted in another's colour.
- New `VertexMarkerLayer` draws a marker per clicked vertex while a polyline is in progress, with the first one a larger hollow ring that fills in once the pointer is within the close threshold. Appearance is configurable through `VertexMarkerOptions` — on the `PolylineTool` constructor, via `createAnnotationTool({ vertexMarkers })`, or as a `vertexMarkers` prop on `<Annotator>` in `@osdlabel/solid` and `@osdlabel/react`; `{ enabled: false }` turns the markers off. Radii default to `DEFAULT_VERTEX_MARKER_RADIUS_PX` / `DEFAULT_FIRST_VERTEX_MARKER_RADIUS_PX` and colours to the resolved style's `strokeColor`.
- `AnnotationStyle` gains an optional `pointRadius`, defaulting to the new `DEFAULT_POINT_RADIUS` (5) and included in `DEFAULT_ANNOTATION_STYLE`. It is honoured by `PointTool` and by `buildFabricObjectFromGeometry`, which takes it as a new optional third argument, so imported and drawn points scale identically. Point annotations previously could not be resized at all.
- Preview and marker objects carry no `id` and are flagged `_readOnly`. Previews previously lacked the flag, so `FabricOverlay.setMode('annotation')` would make an in-progress preview selectable.

Additive throughout: `pointRadius` and the `buildFabricObjectFromGeometry` argument are optional, and the new `style` argument to the protected `ShapeTool.createPreview` is appended, so existing subclasses continue to compile.
