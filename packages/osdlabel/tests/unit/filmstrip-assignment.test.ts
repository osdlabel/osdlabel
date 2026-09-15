import { describe, expect, it } from 'vitest';
import type { ImageId } from '@osdlabel/viewer-api';
import { createImageId } from '@osdlabel/viewer-api';
import { getCellAssignmentState } from '../../src/filmstrip-assignment.js';

const IMG_A = createImageId('img-a');
const IMG_B = createImageId('img-b');
const IMG_C = createImageId('img-c');

const assignments = (entries: Record<number, ImageId>): Readonly<Record<number, ImageId>> =>
  entries;

describe('getCellAssignmentState', () => {
  it("reports 'active' for the image in the active cell", () => {
    expect(getCellAssignmentState(assignments({ 0: IMG_A, 1: IMG_B }), 0, IMG_A)).toBe('active');
  });

  it("reports 'other' for an image displayed only in a non-active cell", () => {
    expect(getCellAssignmentState(assignments({ 0: IMG_A, 1: IMG_B }), 0, IMG_B)).toBe('other');
  });

  it("reports 'none' for an image displayed nowhere", () => {
    expect(getCellAssignmentState(assignments({ 0: IMG_A, 1: IMG_B }), 0, IMG_C)).toBe('none');
  });

  it("prefers 'active' when the same image fills both the active cell and another", () => {
    // Otherwise the clear affordance would vanish whenever the user put the
    // same image side by side with itself.
    expect(getCellAssignmentState(assignments({ 0: IMG_A, 1: IMG_A }), 0, IMG_A)).toBe('active');
  });

  it("reports 'none' for every image when the active cell is empty", () => {
    expect(getCellAssignmentState(assignments({}), 0, IMG_A)).toBe('none');
  });

  it("reports 'other' when the active cell is empty but another cell shows the image", () => {
    // The active cell holding nothing must not make a used image look free —
    // the click assigns, and the border has to say so.
    expect(getCellAssignmentState(assignments({ 1: IMG_A }), 0, IMG_A)).toBe('other');
  });
});
