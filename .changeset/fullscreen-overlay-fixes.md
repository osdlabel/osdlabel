---
'@osdlabel/fabric-osd': patch
---

Fix overlay behaviour around zooming and container resizes

- **Ctrl/Cmd+scroll now anchors the zoom at the pointer.** The handler passed
  `clientX`/`clientY` to `viewport.pointFromPixel`, which expects a pixel
  relative to the viewer element, so the anchor was off by wherever the viewer
  sat in the window and the view drifted away from the cursor as you zoomed.
  The anchor is also mirrored under horizontal flip now, matching what OSD's
  own `onCanvasScroll` does — a flipped cell previously zoomed toward the
  mirror image of the cursor.
- **A purely horizontal wheel no longer zooms out.** `-0 > 0` is false, so a
  trackpad shear or tilt wheel with Ctrl held was read as "scroll down".
- **Fabric's `devicePixelRatio` is resynced before the canvas is resized.**
  Fabric captures `window.devicePixelRatio` once, at module evaluation, and
  never re-reads it; OSD re-reads its own on window resize. After a
  display-scale change that left crisp tiles under a soft annotation overlay.
  Changes that do not alter the container's CSS size — dragging a window
  between monitors — are picked up with a re-arming `(resolution: Ndppx)`
  media query.
- **The overlay repaints from settled bounds after a resize.** OSD raises
  `resize` before `fitBounds` and before its follow-up pan/zoom, so the paint
  moved to `after-resize`; re-measuring the canvas stays on `resize`, where
  the container size is already current.

New exports: `computeScrollZoom`, `mirrorScreenX`, `syncFabricDevicePixelRatio`,
`observeDevicePixelRatio`, and their supporting types.
