---
title: OSD-Fabric Integration
description: How OpenSeadragon and Fabric.js work together in osdlabel
---

This guide explains the internals of how osdlabel synchronizes a Fabric.js annotation canvas with an OpenSeadragon (OSD) deep-zoom viewer. It covers the overlay architecture, affine matrix math, coordinate transforms, event routing, and the specific workarounds required for rotation and flip support.

## Architecture overview

OSD renders deep-zoom imagery on its own canvas. osdlabel creates a **second** canvas on top of it — managed by Fabric.js — for annotations. The two libraries know nothing about each other. The `FabricOverlay` class bridges them:

```
┌─────────────────────────────────────────┐
│  OSD Viewer Container (div)             │
│  ┌───────────────────────────────────┐  │
│  │  OSD Tile Canvas (managed by OSD) │  │
│  ├───────────────────────────────────┤  │
│  │  Fabric Canvas (managed by        │  │
│  │  FabricOverlay, absolutely        │  │
│  │  positioned over OSD canvas)      │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │  OSD MouseTracker (intercepts     │  │
│  │  pointer events, forwards to      │  │
│  │  Fabric or lets OSD handle them)  │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

The Fabric canvas element has `pointer-events: none` in CSS. All pointer event routing is handled by an OSD `MouseTracker`, not by CSS hit-testing. This ensures clean control over which library processes each event.

## The sync loop

When the user pans or zooms in OSD, the annotation canvas must move in lockstep. The `FabricOverlay` repaints on the events listed in `OSD_SYNC_EVENTS`:

| OSD Event          | When it fires                               |
| ------------------ | ------------------------------------------- |
| `animation`        | Every frame during a pan/zoom animation     |
| `animation-finish` | When an animation completes                 |
| `after-resize`     | After a container resize has settled bounds |
| `open`             | When a new image is loaded                  |
| `flip`             | When the horizontal flip is toggled         |
| `rotate`           | When the rotation changes                   |

On each event, `sync()` runs:

```ts
sync(): void {
  const vpt = computeViewportTransform(this._viewer);
  this._fabricCanvas.setViewportTransform(vpt);
  this._fabricCanvas.renderAll();
}
```

`sync()` uses **synchronous** `renderAll()`, not `requestRenderAll()`. This is critical because `sync()` runs inside OSD's own `requestAnimationFrame` callback. Using the async variant would defer the Fabric paint to the next frame, causing a visible 1-frame lag where the image has moved but annotations haven't.

### Why the resize path is split

`resize` is deliberately not in that list, even though it is the event that names the situation. OSD raises it from inside `viewport.resize()`, **before** that method calls `fitBounds`, and `doViewerResize` applies its follow-up `panTo` / `zoomTo` only after `viewport.resize()` returns. So when `resize` fires:

- `getContainerSize()` already reports the new size — the Fabric canvas must be re-measured here, and synchronously. Deferring `setDimensions` to a later tick would leave the canvas a frame at the old size, stretched against the new layout.
- the viewport's centre and zoom are still mid-update, so a paint here is immediately superseded.

`FabricOverlay._onResize` therefore measures without painting, and the paint happens on `after-resize`. Note that dropping the resize-path paint entirely and relying on `animation` would not work: `setDimensions` clears the backing store, so a resize tick whose springs did not move — and which therefore raises no `animation` — would leave the overlay blank.

### Device pixel ratio

Fabric reads `window.devicePixelRatio` exactly once, when its `config` module is evaluated, and `Canvas.setDimensions()` re-applies whatever was captured. OpenSeadragon re-reads its own `pixelDensityRatio` on window `resize` and force-resizes itself when it changed; Fabric has no equivalent. Left alone, a display-scale change leaves crisp OSD tiles under a soft annotation overlay.

The overlay resyncs Fabric's ratio immediately before every `setDimensions`, and watches for changes with a re-arming `(resolution: Ndppx)` media query — a `resize` listener would miss the case that matters, since dragging a window between a Retina and a non-Retina display changes the ratio without changing the container's CSS size.

## The affine viewportTransform

Fabric's `viewportTransform` is a 6-element array representing a 2D affine transformation matrix:

```
[a, b, c, d, tx, ty]
```

This encodes the matrix:

```
┌         ┐   ┌       ┐   ┌    ┐
│ screenX │   │ a   c │   │ ix │   ┌ tx ┐
│         │ = │       │ × │    │ + │    │
│ screenY │   │ b   d │   │ iy │   └ ty ┘
└         ┘   └       ┘   └    ┘
```

Where `(ix, iy)` is a point in image-space (pixels) and `(screenX, screenY)` is where it appears on screen (CSS pixels). The matrix encodes scale, rotation, and translation all at once.

### Computing the matrix: 3-point sampling

Rather than manually computing scale, rotation, and translation from OSD's internal state, `computeViewportTransform` uses **3-point sampling**. It maps three known image-space points through OSD's coordinate API and derives the full matrix from the results:

```ts
const origin = new OpenSeadragon.Point(0, 0); // image origin
const unitX = new OpenSeadragon.Point(1, 0); // 1 pixel right
const unitY = new OpenSeadragon.Point(0, 1); // 1 pixel down

const screenOrigin = viewer.viewport.imageToViewerElementCoordinates(origin);
const screenUnitX = viewer.viewport.imageToViewerElementCoordinates(unitX);
const screenUnitY = viewer.viewport.imageToViewerElementCoordinates(unitY);
```

The matrix elements are the vectors from the origin to each unit point:

```ts
a = screenUnitX.x - screenOrigin.x; // how much screenX changes per image pixel right
b = screenUnitX.y - screenOrigin.y; // how much screenY changes per image pixel right
c = screenUnitY.x - screenOrigin.x; // how much screenX changes per image pixel down
d = screenUnitY.y - screenOrigin.y; // how much screenY changes per image pixel down
tx = screenOrigin.x; // screen X of image origin
ty = screenOrigin.y; // screen Y of image origin
```

**Why 3 points instead of 2?** With only 2 points (origin + unitX), you can derive `a`, `b`, and `tx`/`ty`, but `c` and `d` must be inferred by assuming a 90° rotation relationship (`c = -b`, `d = a`). This assumption holds for pure rotation+scale but would break if OSD ever introduced skew or non-uniform scaling. The 3-point approach is robust against any affine transform OSD might produce.

### What the matrix looks like in practice

**Zoom only (scale=2, no rotation):**

```
[2, 0, 0, 2, tx, ty]
```

Moving 1 image pixel right → 2 screen pixels right. No skew.

**90° rotation at scale=1:**

```
[0, 1, -1, 0, tx, ty]
```

Moving 1 image pixel right → 1 screen pixel down. Moving 1 image pixel down → 1 screen pixel left.

**45° rotation at scale=2:**

```
[√2·2, √2·2, -√2·2, √2·2, tx, ty] ≈ [1.41, 1.41, -1.41, 1.41, tx, ty]
```

## How OSD handles rotation

OSD's `viewport.setRotation(degrees)` rotates the entire viewport. The rotation is handled inside the coordinate conversion pipeline:

1. `imageToViewerElementCoordinates(point)` converts image pixels → OSD viewport coordinates → viewer element coordinates
2. Inside `_pixelFromPoint()`, OSD applies rotation around the viewport center using the standard 2D rotation formula

This means the screen positions returned by `imageToViewerElementCoordinates` already account for rotation. The 3-point sampling captures this naturally — no special rotation handling is needed in `computeViewportTransform`.

**Important:** `setRotation(degrees)` uses a spring animation by default. When applying a view transform programmatically, pass `immediately=true` to snap instantly:

```ts
viewport.setRotation(rotation, true);
```

Without this, the rotation interpolates over several frames. If `sync()` runs before the animation completes, it computes a matrix for an intermediate rotation angle, causing a brief desync.

## How OSD handles flip — and why it's special

OSD's flip is fundamentally different from rotation. `viewport.setFlip(true)` sets an internal flag, but **`imageToViewerElementCoordinates` does NOT apply the flip.** The flip is implemented entirely in OSD's tile rendering pipeline:

```
OSD Drawer:
  context.save()
  context.scale(-1, 1)         // mirror the canvas horizontally
  context.translate(-canvasWidth, 0)
  // ... draw tiles ...
  context.restore()
```

This means the tiles appear flipped on screen, but `imageToViewerElementCoordinates` still returns the **unflipped** position. The 3-point sampling would produce a matrix that doesn't account for flip.

### Composing flip into the matrix

`computeViewportTransform` reads OSD's flip state and manually composes a horizontal mirror:

```ts
if (viewport.getFlip()) {
  const W = viewer.viewport.getContainerSize().x;
  return [-a, b, -c, d, W - tx, ty];
}
```

The math: a horizontal flip mirrors the X coordinate around the container center. For a point at screen position `x`, the flipped position is `W - x`. Substituting the affine formula:

```
Unflipped:  screenX = a·ix + c·iy + tx
Flipped:    screenX = W - (a·ix + c·iy + tx)
          = -a·ix + -c·iy + (W - tx)
```

So the flipped matrix is `[-a, b, -c, d, W-tx, ty]` — negate `a` and `c`, and replace `tx` with `W - tx`. The Y components (`b`, `d`, `ty`) are unchanged.

### Vertical flip

OSD only has horizontal flip (`setFlip`). Vertical flip is achieved by combining horizontal flip with a 180° rotation:

```ts
// In applyViewTransform (receives CellTransform):
const isFlipped = transform.flippedH !== transform.flippedV; // XOR
if (transform.flippedV) {
  rotation = (rotation + 180) % 360;
}
viewport.setFlip(isFlipped);
viewport.setRotation(rotation, true);
```

A 180° rotation inverts both axes. Combined with a horizontal flip (which inverts X), the net effect is inverting only Y — a vertical flip.

## The getZoom() override

Fabric.js internally calls `canvas.getZoom()` in several places, most critically in `_getCacheCanvasDimensions()` which sizes the per-object cache canvases used for rendering. The default implementation is:

```ts
// Fabric's default:
getZoom() {
  return this.viewportTransform[0];  // element 'a'
}
```

This is correct when the viewportTransform is a simple scale+translate matrix (`[scale, 0, 0, scale, tx, ty]`), where `a = scale`. But with rotation:

```
a = cos(θ) × scale
```

| Rotation | a             | Problem                                        |
| -------- | ------------- | ---------------------------------------------- |
| 0°       | 1 × scale     | Correct                                        |
| 45°      | 0.707 × scale | Too small — objects render undersized          |
| 90°      | 0 × scale = 0 | Cache dimensions = 0 — objects invisible       |
| 180°     | -1 × scale    | Negative cache dimensions — clipping artifacts |

The fix overrides `getZoom()` to compute the actual scale as the magnitude of the first column vector of the matrix:

```ts
this._fabricCanvas.getZoom = () => {
  const vpt = this._fabricCanvas.viewportTransform;
  return Math.sqrt(vpt[0] * vpt[0] + vpt[1] * vpt[1]); // √(a² + b²)
};
```

This is the Euclidean length of the vector `(a, b)`, which equals `scale` regardless of rotation angle. It equals `|cos²(θ)·scale² + sin²(θ)·scale²| = scale`.

## skipOffscreen: false

Fabric's default `skipOffscreen: true` skips rendering objects whose bounding boxes don't intersect the visible canvas area. However, Fabric's offscreen culling doesn't account for rotation in the `viewportTransform`. An object that's visible on the rotated canvas may have a bounding box (computed in unrotated space) that falls outside the canvas rectangle, causing it to be incorrectly culled.

Setting `skipOffscreen: false` disables this optimization, ensuring all objects render regardless of the viewport transform.

## Event routing

The `FabricOverlay` uses an OSD `MouseTracker` to intercept pointer events before OSD processes them. The routing depends on the current mode:

### Navigation mode

The MouseTracker is disabled (`setTracking(false)`). Events fall through to OSD's own tracker for pan/zoom. Fabric objects are set to `selectable: false` and `evented: false`.

### Annotation mode

The MouseTracker intercepts events in `preProcessEventHandler`:

```
pointerdown:
  ├── Ctrl/Cmd held? → Pan passthrough: enable OSD nav, let event propagate
  └── Normal click?  → Stop propagation, forward to Fabric

pointermove:
  ├── Pan gesture active? → Let OSD handle it
  └── Otherwise?          → Stop propagation, forward to Fabric

pointerup:
  ├── Pan gesture active? → End gesture, re-disable OSD nav
  └── Otherwise?          → Stop propagation, forward to Fabric

scroll:
  └── Ctrl/Cmd held? → Manual viewport.zoomBy() (OSD scroll-zoom is disabled)
```

#### The scroll-zoom anchor

Two rules govern the point that manual zoom anchors on, both encoded in the pure `computeScrollZoom`:

- **The anchor is element-relative.** `viewport.pointFromPixel` subtracts only OSD's own margins; it expects a pixel in the viewer element's coordinate space. Passing `clientX` / `clientY` offsets the anchor by wherever the viewer sits in the window, so the view drifts away from the cursor — and the offset changes when the page enters fullscreen or scrolls.
- **The anchor is flip-mirrored.** When the viewport is flipped, x has to be mirrored around the container width before conversion, exactly as OSD's own `onCanvasScroll` does. `mirrorScreenX` is shared with `imageToScreenFlipAware` and `screenToImageFlipAware` so the three sites cannot disagree.

A wheel event with no vertical delta produces no zoom at all — a purely horizontal trackpad shear must not be read as "scroll down".

### Forwarding to Fabric

Events are forwarded by dispatching a synthetic `PointerEvent` on Fabric's upper canvas element. This is necessary because the original DOM event targets the MouseTracker's element, not Fabric's canvas.

A **re-entrancy guard** (`_forwarding` flag) prevents infinite loops: the synthetic event bubbles from Fabric's upper canvas up to the container div, where the MouseTracker would intercept it again. The guard ensures the bubbled-back event is ignored.

That guard has a second, less obvious role: it is what makes double-click detection possible, below.

```ts
private _forwardToFabric(type: string, originalEvent: PointerEvent): void {
  if (this._forwarding) return;  // Guard: ignore bubbled-back events
  this._forwarding = true;
  try {
    const syntheticEvent = new PointerEvent(type, {
      clientX: originalEvent.clientX,
      clientY: originalEvent.clientY,
      // ... all other properties copied from original
      bubbles: true,
      cancelable: true,
    });
    this._fabricCanvas.upperCanvasEl.dispatchEvent(syntheticEvent);
  } finally {
    this._forwarding = false;
  }
}
```

### Double clicks

Neither of the two obvious sources works here, and both are worth ruling out explicitly before reaching for them again.

**Fabric's `mouse:dblclick`** is raised from a native `dblclick` listener on the upper canvas — but that canvas is `pointerEvents: 'none'`, so the browser's `dblclick` targets the container instead and the upper canvas only ever receives the synthetic _pointer_ events forwarded above. For the same reason `PointerEvent.detail` is `0` on every event a tool sees, so a tool cannot detect the gesture itself. Testing `event.detail === 2` in `onPointerDown` compiles, type-checks, and can never be true — that was [#168](https://github.com/osdlabel/osdlabel/issues/168).

**The MouseTracker's own `dblClickHandler`** is worse: the synthetic event dispatched by `_forwardToFabric` bubbles back to the container the tracker is attached to, and OSD counts that copy as a second click. Every _single_ click fires it.

**The container's native `dblclick`** does fire — that is where the browser's own event lands, and it carries the platform's timing and movement thresholds, which is genuinely attractive. It is rejected for a different reason: it is a bare notification. It does not say which two presses produced it, and its thresholds are not inspectable, so a tool that accumulated points on those presses cannot work out which of its vertices belong to the gesture. That correlation is the hard part of this problem (see below), and it is the one thing the platform event cannot give.

So `FabricOverlay` pairs releases itself, in `_detectDoubleClick`, called from the `releaseHandler` — where the `_forwarding` guard has already excluded the synthetic copies, leaving exactly the real stream. Subscribe with `overlay.onDoubleClick(cb)`; the framework hooks route it to the active tool's optional `onDoubleClick`.

#### The gates

A release counts as a click only if it is _quick_ — close in time and space to **its own** press, so a drag is not a click — and two clicks pair only if they are close to **each other**. All four thresholds are read off the tracker rather than redeclared, so they follow OSD's defaults:

| gate                       | threshold                                         | default        |
| -------------------------- | ------------------------------------------------- | -------------- |
| release → its own press    | `clickTimeThreshold` / `clickDistThreshold`       | 300 ms / 5 px  |
| release → previous release | `dblClickTimeThreshold` / `dblClickDistThreshold` | 300 ms / 20 px |

The tracker is constructed without `dblClick*` options, so a viewer-level override does not reach it. Ctrl/Cmd releases are excluded — that is the pan pass-through trigger, not a click. Bookkeeping runs even with no subscribers, so `_lastClick` always reflects the most recent click rather than whatever was left when the last subscriber went away.

#### Pairing state and tool switches

Subscribing resets any pending pairing, so a click made before the call cannot pair with the first click after it. The framework hooks resubscribe whenever the effect that owns the subscription re-runs — on a change of overlay, active cell, active viewer control, image, or tool — and `setMode` cannot cover the last of those, since switching tools stays in annotation mode and its own reset early-returns. Of those inputs, the tool switch is the only one that can plausibly land between the two clicks of a gesture; the rest require a separate user action.

That trade is deliberate. A tool switch driven from _inside_ a click — a drawing tool hitting its constraint limit and reverting to select — also resubscribes, and swallows a pair that was genuinely in progress. Losing a double click there is the smaller harm; the alternative is a click made under the previous tool finishing and cancelling a path the user has only just started.

Subscribers are dispatched from a snapshot of the set, with a membership check. A `Set` iterator visits entries added while it runs, so a callback that resubscribes synchronously would otherwise hand the gesture to a tool created after it; the membership check restores what live iteration gave for free, skipping a subscriber that was removed — by unsubscribing, or by `destroy()` — before the loop reached it. Membership is by identity, so re-subscribing the _same_ function reference mid-dispatch still receives the gesture; both framework hooks pass a fresh closure per subscription.

#### What tools receive, and the vertex it costs them

The gesture delivers both of its `pointerdown`s — and the second `pointerup`, so `onPointerUp` also precedes `onDoubleClick` — before the tool hears about the double click, so a tool that accumulates points on press has already picked up extra vertices. Not always two, though — which is what makes this subtle:

- a press landing on an existing annotation is suppressed by the hooks and never reaches the tool;
- a press may have closed the path instead.

So the count is two, one, or none, and a tool cannot simply pop. `PolylineTool` establishes geometrically that _both_ presses landed, measuring the last two vertices against the release point reported to `onDoubleClick`. The bounds compose from the table above: the second press is within `clickDistThreshold` (5 px) of that release, and the first is at most that plus `dblClickDistThreshold` plus another 5 — 25 px — which also means the two presses can be up to 30 px apart while still pairing.

Both halves of that test are load-bearing. Measuring only against the release pops the single vertex a gesture contributed when its _first_ press was suppressed; measuring only between the last two vertices misses a pair that drifted, and fires on two deliberate vertices that happen to sit close on screen.

#### Touch

Touch never reaches this layer. The synthetic `pointerdown` bubbles back to the container, OSD counts the contact twice, and `GesturePointList.addContact` clamps that only for mouse and pen — so a touch list never returns to zero contacts and `releaseHandler` is never called. That is a property of the forwarding design rather than of this pairing, and is tracked in [#175](https://github.com/osdlabel/osdlabel/issues/175).

## How annotations stay correct under rotation/flip

Annotations are stored in **image-space** — pixel coordinates relative to the full-resolution image. The `viewportTransform` matrix maps these to screen-space for rendering. This design means:

1. **Existing annotations** visually rotate/flip with the image automatically — the same matrix transforms both tiles and annotation objects.

2. **New annotations** drawn while rotated/flipped get correct image-space coordinates. Fabric's `scenePoint` (used by annotation tools via `getScenePoint()`) is computed by inverse-transforming the screen pointer through the `viewportTransform`. The inverse of a rotation+scale+flip matrix yields the original image-space coordinates.

3. **Moved/resized annotations** report their properties (left, top, width, height) in image-space because Fabric objects live in scene-space (which is image-space in this setup). The `viewportTransform` is a view transform only — it doesn't modify object coordinates.

No annotation data is ever modified by rotation or flip. The view transform is purely a rendering concern.

## Lifecycle summary

```
1. ViewerCell mounts
   └── Creates OSD Viewer
       └── OSD fires 'open'
           └── FabricOverlay constructor:
               ├── Creates <canvas> element over OSD
               ├── Creates Fabric.Canvas on it
               ├── Overrides getZoom()
               ├── Creates OSD MouseTracker
               ├── Subscribes to animation/resize/open/flip/rotate events
               └── Initial sync()

2. User pans/zooms
   └── OSD fires 'animation' (every frame)
       └── sync()
           ├── computeViewportTransform(viewer)  → 6-element matrix
           ├── fabricCanvas.setViewportTransform(matrix)
           └── fabricCanvas.renderAll()          → synchronous

3. User applies rotation/flip
   └── applyViewTransform(cellTransform)
       ├── Compute effective rotation (add 180° for vertical flip)
       ├── viewport.setFlip(isFlipped)           → immediately
       ├── viewport.setRotation(rotation, true)  → immediately (no spring)
       └── sync()                                → recompute matrix

4. ViewerCell unmounts
   └── overlay.destroy()
       ├── MouseTracker.destroy()
       ├── Remove all OSD event handlers
       ├── Fabric canvas.dispose()
       └── Remove <canvas> from DOM
```
