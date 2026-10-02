import { describe, expect, it } from 'vitest';
import { choosePopoverAlignment, type HorizontalSpan } from '../../src/popover-placement.js';

const span = (left: number, right: number): HorizontalSpan => ({ left, right });

describe('choosePopoverAlignment', () => {
  const bounds = span(0, 500);

  it('opens rightward when that fits', () => {
    // Anchor near the left edge: plenty of room to the right.
    expect(choosePopoverAlignment(span(20, 80), 120, bounds)).toBe('start');
  });

  it('opens rightward when it exactly reaches the edge', () => {
    // 380 + 120 = 500: touching the bound is not overflowing it.
    expect(choosePopoverAlignment(span(380, 440), 120, bounds)).toBe('start');
  });

  it('flips leftward when opening rightward would be clipped (#147)', () => {
    // A button at the right edge: 430 + 120 = 550 > 500, but 490 - 120 = 370.
    expect(choosePopoverAlignment(span(430, 490), 120, bounds)).toBe('end');
  });

  it('keeps opening rightward when a left flip would be clipped too, if it overflows less', () => {
    // Bounds narrower than the popover: neither fits. Start overflows by
    // 10 + 150 - 100 = 60; end by 0 - (40 - 150) = 110.
    expect(choosePopoverAlignment(span(10, 40), 150, span(0, 100))).toBe('start');
  });

  it('flips when neither fits but the left flip overflows less', () => {
    // Start overflows by 70 + 150 - 100 = 120; end by 0 - (95 - 150) = 55.
    expect(choosePopoverAlignment(span(70, 95), 150, span(0, 100))).toBe('end');
  });

  it('respects a left bound that is not zero', () => {
    // A clipping slot from 300 to 500. Opening rightward from 420 overflows;
    // opening leftward from 480 reaches 360, inside the slot.
    expect(choosePopoverAlignment(span(420, 480), 120, span(300, 500))).toBe('end');
    // ...but not if that would cross the slot's left edge.
    expect(choosePopoverAlignment(span(320, 380), 120, span(300, 500))).toBe('start');
  });
});
