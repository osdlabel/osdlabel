# Backlog — osdlabel

Tracked issues, improvements, and deferred work items.

---

## Open

### BL-001: Overlay vibration during browser window resize

**Severity:** Low (cosmetic)
**Observed in:** Task 02 — OSD–Fabric overlay integration
**Status:** Open — one hypothesis investigated and ruled out (see below)

**Description:**
When the browser window is resized (especially rapidly), the Fabric annotation overlay exhibits a brief vibration/jitter before settling to the correct position. The annotations end up in the correct final position but the transient movement is visually noticeable.

**Context:**

- Zoom and fast panning were fixed by switching from async `requestRenderAll()` to synchronous `renderAll()` in the sync handler (the async version deferred the Fabric paint to the next rAF, causing a 1-frame lag).
- The resize path calls `fabricCanvas.setDimensions()` followed by `sync()`, both synchronous. The remaining vibration likely comes from the browser's own resize event batching — `resize` events may fire at a different cadence than OSD's internal rAF loop, and OSD's own viewport state may not be fully settled when the resize handler runs.

**Investigated — "the overlay paints from mid-update viewport bounds" (ruled out as the cause):**

Confirmed in OSD 5.0.1's source that `viewport.resize()` raises `resize` _before_ it calls
`fitBounds`, and that `doViewerResize` applies its follow-up `panTo` / `zoomTo` only _after_
`viewport.resize()` returns. The overlay's `resize` handler therefore painted from a viewport
whose centre and zoom were still mid-update. The paint has been moved to `after-resize` (see
`OSD_SYNC_EVENTS` in `packages/fabric-osd/src/overlay/constants.ts`); `setDimensions` stays on
`resize`, where the container size is already current, because deferring it would leave the
canvas a frame at the wrong size.

**This did not fix the visible jitter.** Both paints land in the same animation frame, before
the browser composites, so the superseded one was never actually shown. Measured with
`apps/dev/tests/e2e/resize-jitter.spec.ts`, which samples the disagreement between the Fabric
`viewportTransform` and OSD's own `imageToScreen` conversion on every animation frame across a
sequence of resizes: `maxDiff` is 0 both before and after the change. The ordering change was
kept as a correctness tidy-up, and the harness as a regression guard, but neither closes this
issue.

**Remaining hypotheses:**

1. OSD's tile-repaint cadence, not the overlay's. During a resize OSD redraws tiles at a
   different rate than it updates the viewport, so the _image_ may lag while the overlay tracks
   correctly — which would read as the overlay vibrating relative to the image. Testable by
   probing the drawer canvas rather than the overlay transform.
2. Browser compositing of the two stacked canvases at different times during a live drag-resize,
   which `page.setViewportSize` (a discrete resize) cannot reproduce.

**Rejected investigation paths (previously listed here):**

1. ~~Debounce/throttle the resize handler with rAF~~ — would defer `setDimensions`, leaving the
   canvas a frame at the wrong size. Worse than the symptom.
2. ~~A `ResizeObserver` on the OSD container~~ — OSD 5.0.1 already installs one on
   `viewer.container`; a second observer races it and fires against a state OSD has not yet
   reacted to.
3. ~~Hide the Fabric canvas during resize~~ — trades a subtle jitter for a visible flash.
4. ~~Determine whether OSD's `resize` fires before or after it updates its viewport~~ — answered
   above: the container size is updated, the bounds are not.

---

### BL-002: Sample image selector in demo app

**Severity:** Low (developer experience)
**Observed in:** Dev environment
**Status:** Deferred

**Description:**
The demo application currently hardcodes a single DZI image (`highsmith`). To facilitate testing with various image types, aspect ratios, and edge cases, a dropdown selector should be added to the header to allow switching between multiple sample images.

**Context:**

- Current implementation in `dev/App.tsx` has a hardcoded source.
- Adding more variety will help ensure the overlay system (Fabric.js + OpenSeadragon) is robust across different image dimensions and tile sets.

**Proposed Tasks:**

1. Define a list of DZI sources (id, url, label) in `dev/App.tsx`.
2. Add a dropdown selector in the header using a SolidJS signal.
3. Include additional DZI URLs such as:
   - Duomo: `https://openseadragon.github.io/example-images/duomo/duomo.dzi`
   - Grand Canyon: `https://openseadragon.github.io/example-images/grand-canyon/grand-canyon.dzi`
   - Currier: `https://openseadragon.github.io/example-images/currier/currier.dzi`

---

## Resolved

_(None yet)_
