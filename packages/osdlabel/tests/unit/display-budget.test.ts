import { describe, expect, it } from 'vitest';
import { MAX_MASK_CANVAS_PIXELS } from '@osdlabel/fabric-annotations';
import { displayBudget } from '../../src/display-budget.js';

describe('displayBudget', () => {
  it('reads an absent budget as the default', () => {
    expect(displayBudget(undefined)).toBe(MAX_MASK_CANVAS_PIXELS);
  });

  it('keeps a positive finite budget as given', () => {
    expect(displayBudget(1_000)).toBe(1_000);
    expect(displayBudget(0.5)).toBe(0.5);
  });

  it('reads anything else as no budget, so NaN compares equal to itself', () => {
    for (const value of [Number.NaN, 0, -1, Infinity, -Infinity]) {
      expect(displayBudget(value)).toBe(Infinity);
    }
  });
});
