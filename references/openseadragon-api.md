# Reference: OpenSeaDragon Viewer API (v5.0.1)

## Creating a viewer

```typescript
import OpenSeadragon from 'openseadragon';

// Create viewer attached to a DOM element
const viewer = OpenSeadragon({
  element: containerDiv, // DOM element (not id string)
  prefixUrl: '', // disable default button images
  showNavigationControl: false, // disable default zoom buttons
  animationTime: 0.3, // pan/zoom animation duration (seconds)
  minZoomImageRatio: 0.5, // zoom-out floor, relative to home zoom
  maxZoomLevel: 40,
  visibilityRatio: 0.5,
  constrainDuringPan: true,
  gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: true },
});
```

`@osdlabel/osd-helper` exports these as `DEFAULT_VIEWER_OPTIONS`; the viewer
cells spread it and add their own `element`.

Two of those options are load-bearing:

- **`minZoomImageRatio`, never `minZoomLevel`.** `minZoomLevel` is an absolute
  zoom (`1` = image width fills the viewport width), but home zoom — the
  "fit the image" zoom — is `imageAspect / containerAspect` whenever the image
  is taller than its container, which can be far below any fixed floor. An
  absolute floor above home zoom makes `applyConstraints()` (called on every
  mouse-up) snap the view in and then refuse to zoom back out to fit.
  `minZoomImageRatio` is relative to home zoom, so fitting always stays
  reachable.
- **`clickToZoom: false`.** OSD zooms in by `zoomPerClick` (2x) on a plain
  click by default, so clicking a cell to activate it would move the view.

```typescript
// Open a DZI tile source
viewer.open({
  Image: {
    xmlns: 'http://schemas.microsoft.com/deepzoom/2008',
    Url: 'https://example.com/my-image_files/',
    Format: 'jpg',
    Overlap: '1',
    TileSize: '254',
    Size: { Height: '7200', Width: '5400' },
  },
});

// Or open a simple image (useful for dev/testing — no tile server needed)
viewer.open({
  type: 'image',
  url: '/sample-data/test-image.jpg',
});

// Destroy (important for cleanup in SolidJS onCleanup)
viewer.destroy();
```

## Coordinate Systems

OSD has three coordinate systems:

1. **Image coordinates** — actual pixels of the source image (0,0 to width,height)
2. **Viewport coordinates** — normalized space where image width = 1.0, y is aspect-ratio-dependent
3. **Web coordinates** — CSS pixels relative to the viewer element

```typescript
// Convert between them:
const viewportPoint = viewer.viewport.imageToViewportCoordinates(imageX, imageY);
const webPoint = viewer.viewport.viewportToViewerElementCoordinates(viewportPoint);
const imagePoint = viewer.viewport.viewerElementToImageCoordinates(webPoint);

// Direct image ↔ web element:
const webFromImage = viewer.viewport.imageToViewerElementCoordinates(
  new OpenSeadragon.Point(imgX, imgY),
);
const imageFromWeb = viewer.viewport.viewerElementToImageCoordinates(
  new OpenSeadragon.Point(webX, webY),
);
```

## Key Events

```typescript
// Fires every animation frame during pan/zoom — use this for overlay sync
viewer.addHandler('animation', () => {
  // Called on every frame while animating
  const center = viewer.viewport.getCenter(true); // true = current (not target)
  const zoom = viewer.viewport.getZoom(true);
  const rotation = viewer.viewport.getRotation();
});

// Fires when animation completes
viewer.addHandler('animation-finish', () => {});

// Fires on viewer resize
viewer.addHandler('resize', (event) => {
  // event.newContainerSize, event.maintain
});

// Fires when tile source is loaded
viewer.addHandler('open', () => {
  // viewer.world.getItemAt(0) is now available
  const tiledImage = viewer.world.getItemAt(0);
  const contentSize = tiledImage.getContentSize(); // { x: width, y: height } in image pixels
});

// Canvas click (for hit testing)
viewer.addHandler('canvas-click', (event) => {
  const webPoint = event.position;
  const viewportPoint = viewer.viewport.pointFromPixel(webPoint);
  const imagePoint = viewer.viewport.viewportToImageCoordinates(viewportPoint);
});
```

## Mouse Navigation Control

```typescript
// Disable mouse/touch navigation (for annotation mode)
viewer.setMouseNavEnabled(false);

// Re-enable (for navigation mode)
viewer.setMouseNavEnabled(true);

// Check current state
const isEnabled = viewer.isMouseNavEnabled();
```

## Viewport Queries

```typescript
// Get current zoom level (true = current, false = target during animation)
viewer.viewport.getZoom(true);

// Get viewport bounds in viewport coordinates
viewer.viewport.getBounds(true);

// Get center in viewport coordinates
viewer.viewport.getCenter(true);

// Get rotation in degrees
viewer.viewport.getRotation();

// Get container size in web coordinates
viewer.viewport.getContainerSize(); // { x: width, y: height }
```

## Resize Sequence (verified against OSD 5.0.1 source)

OSD installs a `ResizeObserver` on `viewer.container` and handles the change on
its next update tick, in `doViewerResize`. The order matters for anything that
paints in lockstep with the viewport:

```
doViewerResize(viewer, containerSize)
  ├── viewport.resize(containerSize, preserveImageSizeOnResize)
  │     ├── containerSize updated  →  getContainerSize() is already current
  │     ├── raiseEvent('resize')   ←  bounds NOT yet refitted
  │     ├── fitBounds(...)
  │     └── raiseEvent('after-resize')
  ├── viewport.panTo(center, true)
  └── viewport.zoomTo(zoom * resizeRatio, null, true)

  … later in the same update tick, if the springs moved:
  └── raiseEvent('animation')      ←  fully settled
```

So `resize` is the event to _measure_ on and `after-resize` the event to
_paint_ on. With `preserveImageSizeOnResize` false (the default), the centre is
preserved and `resizeRatio` works out such that on-screen image scale changes
by the ratio of the container **diagonals** — which makes an
enter/exit fullscreen round trip exactly reversible.

OSD separately listens to window `resize` to recompute its own
`pixelDensityRatio`, calling `forceResize()` when it changed. There is no
equivalent for a display-scale change that does not alter the container's CSS
size (dragging a window between monitors); `viewer.forceResize()` is the public
way to re-enter the path.

## Pointer Coordinates

`viewport.pointFromPixel(pixel, current)` subtracts only OSD's own margins — the
pixel must be **relative to the viewer element**, not client/window
coordinates. MouseTracker events already deliver this as `event.position`
(`getMouseRelative(event, tracker.element)`).

OSD's own `onCanvasScroll` mirrors that position before converting when the
viewport is flipped:

```javascript
if (this.viewport.flipped) {
  event.position.x = this.viewport.getContainerSize().x - event.position.x;
}
```

Any hand-rolled zoom-to-pointer must do the same, since none of OSD's
coordinate conversions account for flip (it lives in the drawer's render pass).
