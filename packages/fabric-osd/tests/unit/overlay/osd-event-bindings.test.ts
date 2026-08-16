import { describe, it, expect } from 'vitest';
import {
  OSD_AFTER_RESIZE,
  OSD_ANIMATION,
  OSD_ANIMATION_FINISH,
  OSD_FLIP,
  OSD_OPEN,
  OSD_RESIZE,
  OSD_ROTATE,
  OSD_SYNC_EVENTS,
} from '../../../src/overlay/constants.js';

describe('OSD_SYNC_EVENTS', () => {
  it('repaints after the bounds have settled following a resize', () => {
    expect(OSD_SYNC_EVENTS).toContain(OSD_AFTER_RESIZE);
  });

  it('does not repaint on `resize` itself', () => {
    // OSD raises `resize` from inside `viewport.resize()`, before `fitBounds`
    // and before `doViewerResize`'s follow-up panTo/zoomTo, so the viewport's
    // centre and zoom are mid-update and any paint there is immediately
    // superseded. `FabricOverlay._onResize` re-measures the canvas — which
    // must happen there, since the container size is already current — and
    // leaves the painting to `after-resize`.
    expect(OSD_SYNC_EVENTS).not.toContain(OSD_RESIZE);
  });

  it('covers every viewport change that moves the image on screen', () => {
    // Guards against an event being dropped from the table during a refactor:
    // each of these leaves the overlay misaligned if it does not resync.
    expect([...OSD_SYNC_EVENTS]).toEqual([
      OSD_ANIMATION,
      OSD_ANIMATION_FINISH,
      OSD_AFTER_RESIZE,
      OSD_OPEN,
      OSD_FLIP,
      OSD_ROTATE,
    ]);
  });
});
