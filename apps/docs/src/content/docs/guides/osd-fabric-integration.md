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

### Annotation and paint mode

The MouseTracker intercepts events in `preProcessEventHandler`. Paint mode, for a tool that paints into an annotation (the segmentation brush), routes input as annotation mode does, with every object inert and group selection off, and differs in one rule, marked below:

```
pointerdown:
  ├── A pen or mouse, while a touch
  │   press (or pan) is in progress?      → The touch is a hand at rest: undo
  │                                         its press (see "Cancelled
  │                                         presses") or end its pan, hold
  │                                         it, then route this press as below
  ├── Paint mode, a second contact of the
  │   press's own type?                   → End and commit the stroke, then
  │                                         hold the newcomer (next rule)
  ├── A second pointer? → Stop propagation, hold it (see "A second pointer")
  ├── Ctrl/Cmd held?    → Pan passthrough: enable OSD nav, let event propagate
  └── Normal click?     → Stop propagation, forward to Fabric (ending a pan
                          whose lift went unseen, OSD nav included)

pointermove:
  ├── A held pointer's, a button down? → Stop propagation, nothing else
  ├── Pan gesture active?              → Let OSD handle it
  ├── The pressing mouse or pen's,
  │   primary button up (a chord)?     → End the press (see "Releases OSD
  │                                      never reports"), then as below
  └── Otherwise?                       → Stop propagation; forward to Fabric
                                         if it is the pressing pointer's, or,
                                         with no press in progress, any but a
                                         held pointer's

pointerup:
  ├── A held pointer's?   → Stop propagation, nothing else
  ├── Pan gesture active? → End gesture, re-disable OSD nav
  └── Otherwise?          → Stop propagation; the pressing pointer's is
                            forwarded to Fabric at once, ending the gesture

pointercancel:
  ├── A held pointer's?   → Stop propagation, nothing else
  ├── Pan gesture active? → End gesture, re-disable OSD nav
  └── Otherwise?          → Stop propagation, undo the press (see "Cancelled presses")

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

A **re-entrancy guard** (`_forwarding` flag) prevents infinite loops: a synthetic event that bubbles from Fabric's upper canvas reaches the container div, where the MouseTracker would intercept it again. The guard ensures the bubbled-back event is ignored.

That guard has a second, less obvious role: it is what makes double-click detection possible, below.

The guard is not enough on its own, which is why the press is dispatched **non-bubbling** while the move and release are not. OSD's `onPointerDown` calls `GesturePointList.addContact()` _before_ it honours `eventInfo.stopPropagation`, so the guard cannot keep the bubbled press out of OSD's contact bookkeeping — only not dispatching it into the container can. Fabric loses nothing, because it binds `pointerdown` on the upper canvas itself and the event arrives AT_TARGET.

The symptom was touch-only because `addContact()` clamps an implausible count back to one for `"mouse"` and `"pen"` and warns, but not for `"touch"`. Mouse input therefore worked while logging `GesturePointList.addContact() Implausible contacts value` on every press in annotation mode; touch was left at two contacts, and OSD's handlers key off exact counts.

The move must keep bubbling. Fabric moves `pointermove` from the canvas to the document for the duration of a press, so a non-bubbling move would reach Fabric only between presses. The bubbled copy re-enters the tracker's element, but only updates a position OSD already has.

The release must reach the document too — Fabric binds `pointerup` there — but it must **not pass through the tracker's element on the way**. OSD's `updatePointerUp` removes a contact before it honours `stopPropagation`, exactly as `onPointerDown` adds one. That was survivable while every release was forwarded from `releaseHandler`, which OSD calls _after_ removing the contact, so the bubbled copy hit `removeContact()`'s floor at zero. But the releases described below are forwarded from `preProcessEventHandler`, _before_ OSD has processed the real event, and there the bubbled copy removed a live contact: the second finger that revealed a lost release was then counted as a fresh first contact and reported as a press of its own. So the release is dispatched on the container's **parent**, the viewer canvas. It bubbles to the document from there, and the viewer canvas's own OSD tracker is disabled in every mode that forwards. See [#175](https://github.com/osdlabel/osdlabel/issues/175).

```ts
private _forwardToFabric(type: string, originalEvent: PointerEvent, pressSeq?: number): void {
  if (this._forwarding) return;  // Guard: ignore bubbled-back events
  this._forwarding = true;
  try {
    const syntheticEvent = new PointerEvent(type, {
      clientX: originalEvent.clientX,
      clientY: originalEvent.clientY,
      // ... all other properties copied from original
      // Only the press is withheld from the container; see above.
      bubbles: type !== 'pointerdown',
      // A release always reports the primary button up, whatever revealed it.
      button: type === 'pointerup' ? 0 : originalEvent.button,
      cancelable: true,
    });
    // Presses carry their sequence, keyed on the event the tool receives.
    if (pressSeq !== undefined) this._pressSeqByEvent.set(syntheticEvent, pressSeq);
    // The release starts above the tracker's element; see above.
    const target =
      type === 'pointerup' ? this._fabricContainer.parentElement : this._fabricCanvas.upperCanvasEl;
    target.dispatchEvent(syntheticEvent);
  } finally {
    this._forwarding = false;
  }
}
```

**Releases OSD never reports.** `releaseHandler` fires only when OSD's contact count for the pointer type returns to zero, and never for a `pointercancel`. The lift of the pointer that pressed and a cancel are therefore handled in `preProcessEventHandler` (see "A second pointer" and "Cancelled presses"), and two more inputs end a press there with a forwarded release, `_endPendingPress`, which **carries the pressing pointer's id**, because Fabric drops every non-primary pointer:

- **A second finger in paint mode.** A second contact of the press's own type landing mid-stroke turns the gesture into a pinch that would keep feeding moves to the stroke, and it would be committed only when the first finger lifted, with a streak along the pinch. So in paint mode the stroke ends, and is committed as it stands, at that press; the newcomer is then held like any other second pointer. Annotation mode keeps the rule of "A second pointer": the first finger's gesture goes on until its own lift.
- **A chord.** With a mouse or pen, releasing the primary button while another is held arrives as a `pointermove` with the primary bit of `buttons` clear, and the eventual `pointerup` names the other button, which OSD ignores (`updatePointerUp` returns early for any `button` but 0). No release would ever be reported, so the pending press is ended on that move. Touch is excluded: a touch contact reports `buttons: 1` for its whole life.

Such a release is consumed as a plain release, never paired into a double click, and, like every forwarded release, it reports `button: 0`, because Fabric drops a `pointerup` with any other button and the event that revealed the end (a chord's move, say) need not carry 0 itself. The brush adds a belt to these braces: it tracks the pointer that started a stroke, ignores moves from any other, and treats a move with the primary button up as a lost release, committing the stroke rather than painting on.

### Double clicks

Neither of the two obvious sources works here, and both are worth ruling out explicitly before reaching for them again.

**Fabric's `mouse:dblclick`** is raised from a native `dblclick` listener on the upper canvas — but that canvas is `pointerEvents: 'none'`, so the browser's `dblclick` targets the container instead and the upper canvas only ever receives the synthetic _pointer_ events forwarded above. For the same reason `PointerEvent.detail` is `0` on every event a tool sees, so a tool cannot detect the gesture itself. Testing `event.detail === 2` in `onPointerDown` compiles, type-checks, and can never be true — that was [#168](https://github.com/osdlabel/osdlabel/issues/168).

**The MouseTracker's own `dblClickHandler`** is worse: the synthetic event dispatched by `_forwardToFabric` bubbles back to the container the tracker is attached to, and OSD counts that copy as a second click. Every _single_ click fires it.

**The container's native `dblclick`** does fire — that is where the browser's own event lands, and it carries the platform's timing and movement thresholds, which is genuinely attractive. It is rejected for a different reason: it is a bare notification. It does not say which two presses produced it, and its thresholds are not inspectable, so a tool that accumulated points on those presses cannot work out which of its vertices belong to the gesture. That correlation is the hard part of this problem (see below), and it is the one thing the platform event cannot give.

So `FabricOverlay` pairs releases itself, in `_detectDoubleClick`, called when the pointer that pressed lifts (from `preProcessEventHandler`; see "A second pointer") — where the `_forwarding` guard has already excluded the synthetic copies, leaving exactly the real stream. Subscribe with `overlay.onDoubleClick(cb)`; the framework hooks route it to the active tool's optional `onDoubleClick`.

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

So the count is two, one, or none, and a tool cannot simply pop.

The overlay therefore says which presses they were, rather than leaving the tool to infer it. Every forwarded `pointerdown` carries a monotonic **press sequence**, readable with `ToolOverlay.pressSeqOf(event)`, and `onDoubleClick` receives the pair of sequences that formed the gesture. A tool that accumulates on press stamps each entry with the sequence that placed it, and drops the tail entry only when it carries the _second_ press's sequence and the entry before it carries the first's. The path therefore still ends at the double-clicked point: the gesture's first press places a real vertex, and only its second is redundant.

That makes all three counts one rule. A suppressed press never reached the tool, so no entry carries its sequence — and a gesture that contributed only one vertex leaves it alone, because that vertex is the endpoint the user asked for rather than an artefact. A press that closed the path added no entry to drop. There are no bounds to compose and no window in which a user's own vertex can be mistaken for the gesture's — which the previous screen-distance test did have, narrowly, when the first press was suppressed and the preceding vertex fell inside its bound ([#176](https://github.com/osdlabel/osdlabel/issues/176)).

Two details carry the guarantee. `pressSeqOf` is keyed on the **synthetic** event the overlay dispatched — the one the tool actually receives — and is populated only for presses, so any other event returns `undefined`. And `undefined` needs no special case: it fails the same equality check as any other non-match, so an entry the overlay did not place is never removed.

#### Touch

Touch reaches this layer as of [#175](https://github.com/osdlabel/osdlabel/issues/175). It previously did not: the synthetic `pointerdown` bubbled back to the container, OSD counted the contact twice, and `GesturePointList.addContact` clamps that only for mouse and pen — so a touch list never returned to zero contacts and `releaseHandler`, which this detection then ran from, was never called. The press is now dispatched non-bubbling, so the count is correct and a double tap pairs like a double click. That was a property of the forwarding design rather than of this pairing.

### Cancelled presses

When the OS or the browser takes a touch or pen contact away mid-gesture (an edge swipe, palm rejection, a system dialog, an orientation change), the browser sends `pointercancel` for it and no `pointerup`. The viewer's elements are `touch-action: none`, so the browser never cancels a touch to scroll the page: a cancel always comes from outside it.

Nothing downstream handles the event on its own. OSD's `MouseTracker` answers a cancel with `stopTrackingPointer` and never calls `releaseHandler`, and Fabric has no `pointercancel` handling. Before the overlay handled it, Fabric's transform stayed open. The shape stayed where the finger had left it while the stored geometry kept the old one, so labels, measurements and exports disagreed with the screen. The `pointermove` and `pointerup` listeners Fabric adds to the document on a press stayed attached, so the next movement of any pointer (a hover, a drag on empty canvas) carried the shape on, and the next release anywhere committed it there. A drawing tool's preview stayed painted, and a tap on the toolbar committed it.

**Cancel means revert**, the platform's meaning for the event. `_cancelPress` runs from `preProcessEventHandler`, which is where OSD hands the overlay a `pointercancel`. It acts only for the pointer that pressed (but see "A palm, or a resting finger", below), in annotation and paint mode alike, in three steps:

1. **Put the object back.** Fabric's `transform.original` holds the transformed object's placement at the press (position, scale, skew, angle, flip); its `originX` / `originY` are the transform's anchor, not the object's origin, so they are left alone. A polyline or polygon's points are not in it, so the overlay copies them on Fabric's `before:transform`, which fires before a control's `mouseDownHandler` and so also before the vertex the editor's insert handle adds on the press. Clearing `actionPerformed` keeps Fabric from firing `object:modified`.
2. **Tell subscribers**, through `overlay.onPointerCancel(cb)`, with the event and the press's sequence. The framework hooks route it to the active tool's optional `onPointerCancel`. A shape tool or the free-hand tool drops its preview (`BaseTool`'s default calls `cancel()`). A polyline drops the vertex that press placed, found by its sequence as for a double click, and keeps the rest. The select tool passes it to the vertex editor, which drops a pending long press, rebuilds its handles for the restored points, and puts back the vertex `Delete` targeted before the press: an insert handle's press targets the vertex it inserted, and once the revert has taken that vertex out, the key would name the one that slid back into its index. `enableLiveDecorationUpdates` subscribes too: state never changed, so nothing else would re-run the providers, and the last live frame (a label where the finger was) would outlive the gesture. It re-derives the decorations from state on the next frame.
3. **End Fabric's gesture** with a forwarded `pointerup`, after placing the object's controls. A release is the only way to run Fabric's own cleanup of the transform, its document listeners and its rubber band. It is built from the press rather than copied from the cancel, because Chrome's `pointercancel` carries `button` -1, which `__onMouseUp` takes for a right or middle button and returns on. It lands at the press's position, on what the press landed on, and `selection` is off while it runs, so it applies no rubber-band selection. With `actionPerformed` cleared it commits nothing. Nothing marks it: to Fabric, and to the tool's `onPointerUp`, it is an ordinary release, so step 2 is a tool's only notice of the cancel.

The order is load-bearing twice over. The release fires Fabric's `mouse:up`, on which a shape tool commits its preview, so the tool must have dropped the preview before it. And the controls are placed only after the subscribers: the editor's handles may still be the ones built for the vertex the revert has just taken away, and placing them would read past the end of `points`.

The release starts above the tracker's element, as every forwarded release does ("Forwarding to Fabric"), so OSD does not count it; OSD's own `updatePointerCancel`, which runs after `preProcessEventHandler`, removes the contact. The `_forwarding` guard keeps it out of `releaseHandler`, so it is no click.

The segmentation brush discards a cancelled stroke rather than committing it, because the platform cancels a pointer when it decides the input was not meant for the page. On an iPad that is palm rejection: iPadOS delivers a resting hand as a touch and cancels it a moment later, and committing on that cancel left a dot in the mask. The brush inherits `BaseTool`'s `onPointerCancel`, which discards the stroke, so the release that follows finds nothing to commit.

**A palm, or a resting finger.** A touch never wins over a pen or a mouse. The platform does not always cancel a palm before the pen lands: on an iPad the hand often rests first, and is still an ordinary touch press when the pencil touches down. And it has no cause to cancel a finger left on a touchscreen while the other hand takes the mouse. Either way the touch was a hand at rest, so a pen or a mouse pressing while a touch press is in progress reveals it: the overlay cancels the touch's press exactly as above, with that `pointerdown` as the event subscribers receive (its type, `pointerId` and `pointerType` are the new pointer's, so a subscriber identifies the cancelled press by its sequence), holds the rest of the touch to its lift (see "A second pointer"), and lets the new press through as the real one. A touch's Ctrl/Cmd pan gives way the same way, except that it is ended rather than undone (the view stays where it went), and no subscriber hears of it, since no tool saw it. Holding the pen or mouse instead would swallow the whole of its stroke, and the finger's lift would then commit what the finger did: the dot a resting finger leaves in a mask, a shape it nudged. Any press of the pen or mouse counts, whatever its button or modifiers, since a right-button or Ctrl/Cmd press shows as plainly where the hand is; the press then does what it would anyway (a Ctrl/Cmd press pans, and a right or middle press starts nothing, since OSD passes it to no handler the overlay registers). The rule runs one way: a finger beside a pen or mouse press (a pan included) is held, and so are a pen and a mouse beside each other's.

What the press did outside the gesture stands, as focus does after a cancelled press: an object it selected stays selected, and a polyline press that closed the path committed the polygon on the press, before the cancel. The press's pairing state is dropped, so the clicks either side of a cancelled press cannot pair into a double click.

`lostpointercapture` is not treated as a cancel. The browser sends it after the `pointerup` or `pointercancel` that ends a press, and nothing in the overlay releases capture mid-press. Custom-control mode is untouched: its handlers hear no cancel, and the drag controls disarm on the next move with no button held.

`apps/dev/tests/e2e/touch-cancel.spec.ts` drives all of this through CDP's `touchCancel`, which produces a genuine `pointercancel`.

### A second pointer

OSD's `MouseTracker` counts contacts per pointer type. It calls `pressHandler` only for the first contact of a type to go down, and `releaseHandler` only for the last to lift. So when the finger that pressed lifts while a second finger is still down, OSD calls no `releaseHandler`. The second finger's lift, later, is the one it reports, and the platform marks that finger non-primary (`isPrimary: false`), which Fabric ignores (`_isMainEvent`). When the overlay forwarded releases only from `releaseHandler`, neither lift reached Fabric as a release, and its transform stayed open. The result was the drift of an unhandled cancel. The canvas showed the edit while the stored geometry kept the old shape. The next movement of any pointer (a mouse hover, a later touch) carried the shape on, and the next release committed it there. A drawing tool's preview stayed uncommitted until a tap on the toolbar committed it, stretched to the button.

**The lift of the pointer that pressed is a release.** `preProcessEventHandler` sees every `pointerup` before OSD's own bookkeeping, so `_releasePress` ends the gesture there for the pointer that pressed. It forwards the release, which commits through `object:modified` or a drawing tool's `mouse:up` as a mouse release would, and qualifies it as a click. It does so for every such release, not only when another pointer is down, so there is one path. When OSD then reports the same `pointerup` to `releaseHandler`, as it does for a lone contact, the event is marked handled and skipped. Forwarding it twice would cost Fabric nothing, since it unbinds its release listener after the first. Qualifying it twice would not be harmless: the second finds no press and clears the click the first recorded, so no two taps would pair.

**Any other pointer that goes down meanwhile is held.** `_isSecondPointer` decides on `pointerdown`. A pointer is held if the platform does not call it primary (a finger put down while another touches the screen), or if it is of another type while a press is in progress (a palm beside a pen, a finger beside a mouse, a pen beside a mouse). OSD counts each type apart, so it reports that second press, and the platform calls it primary, so Fabric would take it for the gesture's own pointer. A Ctrl/Cmd pan is its pointer's press here: a finger or a pen landing while the mouse pans is held too. It used to take Fabric's gesture over, so it painted or moved what it landed on, the pan stopped, and OSD's navigation stayed on in annotation mode, since only the pan's own lift turned it off. A right or middle press is no press in progress: OSD reports it to no handler the overlay registers, so it starts nothing, and a pointer pressing beside it is routed as if alone. The one exception is a pen or mouse beside a touch press or pan, which wins ("A palm, or a resting finger", above). Nothing a held pointer does reaches Fabric, OSD's gesture handling or the page: not its press, its moves or its lift. Its events carry `preventGesture`, so OSD neither captures it nor calls its press or release handlers for it nor starts a pinch with it; OSD still counts its contact, and removes it again on its lift. It starts nothing until it lifts and presses again. Two related rules hold while a press is in progress. Only the pressing pointer's moves reach Fabric, so a mouse hovering beside a finger's drag does not pull the shape after it. And a release OSD reports for a pointer the overlay never saw press (pressed outside the viewer, released over it) does not end the press.

Annotation mode defines no two-finger gesture. The overlay's tracker registers no `pinchHandler`, OSD's own navigation is off, and a held finger's events stop at the overlay, so a second finger does not pinch-zoom. Paint mode differs in one respect: a second finger ends the stroke where it lands ("Releases OSD never reports"), and is then held.

A missed lift cannot leave the overlay refusing input. A held pointer is let go on its `pointerup` or `pointercancel`, and, should that go unseen, on its next `pointerdown` or on a move with no button down, either of which means it has lifted. `setMode` forgets them all. A pointer of the press's own type that the platform calls primary is never held: it can only be pressing because the press's pointer has lifted unseen, so it starts a gesture of its own, as it always has. A pan whose lift went unseen ends the same way, at its pointer's next press, and turns OSD's navigation off again.

Nothing here reads OSD's contact count. A held pointer is still counted, so a path that waited for the count to drop would miss the pressing pointer's lift whenever another contact of its type rests, and with it the click that lift qualifies: a double tap whose first tap overlapped a brief touch of another finger would never pair. Forwarded releases are dispatched above the tracker's element, so they leave the count alone, and it is exact throughout.

Custom-control mode is untouched: its handler hears what OSD reports.

`apps/dev/tests/e2e/touch-second-finger.spec.ts` drives this with two CDP touch points. One finger moves, resizes or draws; a second goes down and moves; the first lifts; then the second moves and lifts. A CDP `touchEnd` that lists touch points lifts only those, which the spec checks the page saw.

## Saving edits

Fabric reports a finished move, resize or rotation with `object:modified`. Both bindings save it through `enableObjectModifiedCommits` (from `osdlabel`). Three properties of that event decide how:

- **It fires while the transform is still current.** Fabric ends the transform only after its listeners return. A commit that rebuilds the canvas at once removes the edited object mid-transform; Solid's store runs the rebuild synchronously, so it did. Fabric's discard then ended the transform itself and reported the same edit again, and every Solid drag was committed twice. So every commit waits for a microtask, by which time Fabric has finished the pointer release.
- **A multi-selection is reported as one event about the selection.** The target is the `ActiveSelection` itself, which has no annotation id. Every member is still inside it, its `left`/`top`/scale/angle relative to the group. Fabric does not dissolve the selection first. It bakes the group's transform into each member only when the selection is discarded, and fires nothing then. So the commit dissolves it (`dissolveGroupSelection`) and reads each member on its own. It saves them all with one `UPDATE_ANNOTATIONS`, so the canvas is rebuilt once. Then it selects the same annotations again once the rebuild has added their new objects (`reselectWhenAdded`). A selection discarded before the event, say by a tool switch mid-drag, commits the members it held when the transform began (`before:transform`).
- **A stretch baked into a rotated member skews it.** A rectangle would become a parallelogram and a circle an ellipse, which their geometry cannot record. So every selection is uniform-only (`configureGroupSelection`): four corner handles that keep proportions whatever the modifier, the rotation handle, no side handles, and skew locked. Uniform scale commutes with rotation, so each baked member is still the shape it was. A point's dot does take the scale, though a point has no size: `processObjectModified` redraws any point whose object is scaled or skewed at its style's radius, the `radius` its `Circle` was saved with.

Group selection itself, by drag-box or Shift+click, belongs to the select tool. `setMode('annotation')` turns Fabric's `canvas.selection` off each time it enters annotation mode, paint mode keeps it off, and `SelectTool` turns it on while active. A host driving the overlay without the library's tools, and wanting drag-box selection, sets it after each `setMode('annotation')`. When it was on for every tool, a drawing drag across existing shapes also ran Fabric's drag-box. It left them selected, and, once the canvas was rebuilt, the selection held objects no longer on it.

A mask never joins a group transform. Painting is the only way to change a mask, so its Fabric image is locked against moving, scaling and rotating, but Fabric checks only the transform target's locks, and the target of a group drag is the `ActiveSelection`. A drag-box that touched a mask's box carried the mask's image along with the shapes, while its geometry and pixels stayed where they were, and since a mask's object is reused across rebuilds while its pixels are unchanged, the displaced image outlived the commit. So `SelectTool` drops every member locked against moving from a multi-selection before configuring it: if one member is left it becomes the active object, and if none is left the selection is discarded. A mask is still selected, and deleted, on its own. The cache that reuses mask objects also rebuilds one that no longer sits where its payload places it.

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
