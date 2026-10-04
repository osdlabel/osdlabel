import { describe, it, expect, afterEach } from 'vitest';
import { DEFAULT_CELL_TRANSFORM } from '@osdlabel/viewer-api';
import { renderAnnotator, type AnnotatorHarness } from '../render-annotator.js';
import { unmountAll } from '../mount.js';
import { imageId } from '../fixtures.js';

/**
 * The React counterpart of Solid's `view-transform-actions.test.ts`. Every
 * view action targets `getUIState().activeCellIndex` — a ref the provider
 * refreshes on render — so these also pin that the getter follows the active
 * cell rather than the one current when `createActions` ran.
 */
describe('View Transform Actions', () => {
  afterEach(unmountAll);

  function createTestStore(): AnnotatorHarness {
    const h = renderAnnotator();
    h.run((a) => {
      a.setGridDimensions(2, 1);
      a.assignImageToCell(0, imageId);
    });
    return h;
  }

  it('rotateActiveImageCW rotates by 90 degrees', () => {
    const h = createTestStore();
    for (const rotation of [90, 180, 270, 0]) {
      h.run((a) => a.rotateActiveImageCW());
      expect(h.current.uiState.cellTransforms[0]).toEqual({ ...DEFAULT_CELL_TRANSFORM, rotation });
    }
  });

  it('rotateActiveImageCCW rotates by -90 degrees (270)', () => {
    const h = createTestStore();
    for (const rotation of [270, 180, 90, 0]) {
      h.run((a) => a.rotateActiveImageCCW());
      expect(h.current.uiState.cellTransforms[0]).toEqual({ ...DEFAULT_CELL_TRANSFORM, rotation });
    }
  });

  it('flipActiveImageH toggles horizontal flip', () => {
    const h = createTestStore();
    h.run((a) => a.flipActiveImageH());
    expect(h.current.uiState.cellTransforms[0]).toEqual({
      ...DEFAULT_CELL_TRANSFORM,
      flippedH: true,
    });
    h.run((a) => a.flipActiveImageH());
    expect(h.current.uiState.cellTransforms[0]).toEqual({
      ...DEFAULT_CELL_TRANSFORM,
      flippedH: false,
    });
  });

  it('flipActiveImageV toggles vertical flip', () => {
    const h = createTestStore();
    h.run((a) => a.flipActiveImageV());
    expect(h.current.uiState.cellTransforms[0]).toEqual({
      ...DEFAULT_CELL_TRANSFORM,
      flippedV: true,
    });
    h.run((a) => a.flipActiveImageV());
    expect(h.current.uiState.cellTransforms[0]).toEqual({
      ...DEFAULT_CELL_TRANSFORM,
      flippedV: false,
    });
  });

  it('resetActiveImageView resets to default transform', () => {
    const h = createTestStore();
    h.run((a) => {
      // Neither reads state, so one batch is fine.
      a.rotateActiveImageCW();
      a.flipActiveImageH();
    });
    h.run((a) => a.resetActiveImageView());
    expect(h.current.uiState.cellTransforms[0]).toEqual(DEFAULT_CELL_TRANSFORM);
  });

  it('only affects the active cell', () => {
    const h = createTestStore();
    h.run((a) => a.assignImageToCell(1, imageId));
    h.run((a) => a.flipActiveImageH());

    // Switch to cell 1 in its own commit, then rotate: the action must read
    // the refreshed active cell, not the one in force at creation.
    h.run((a) => a.setActiveCell(1));
    h.run((a) => a.rotateActiveImageCW());

    expect(h.current.uiState.cellTransforms[0]).toEqual({
      ...DEFAULT_CELL_TRANSFORM,
      flippedH: true,
    });
    expect(h.current.uiState.cellTransforms[1]).toEqual({
      ...DEFAULT_CELL_TRANSFORM,
      rotation: 90,
    });
  });
});
