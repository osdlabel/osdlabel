import { describe, expect, it } from 'vitest';
import { History } from '../../src/history.js';

describe('History', () => {
  it('has nothing to undo or redo before two states', () => {
    const h = new History<string>();
    expect(h.undo()).toBeUndefined();
    h.record('a');
    expect(h.canUndo).toBe(false);
    expect(h.undo()).toBeUndefined();
    expect(h.redo()).toBeUndefined();
  });

  it('undoes and redoes in order', () => {
    const h = new History<string>();
    for (const s of ['a', 'b', 'c']) h.record(s);
    expect(h.undo()).toBe('b');
    expect(h.undo()).toBe('a');
    expect(h.undo()).toBeUndefined();
    expect(h.canRedo).toBe(true);
    expect(h.redo()).toBe('b');
    expect(h.redo()).toBe('c');
    expect(h.redo()).toBeUndefined();
  });

  it('a new step discards what was undone', () => {
    const h = new History<string>();
    for (const s of ['a', 'b', 'c']) h.record(s);
    h.undo();
    h.record('d');
    expect(h.canRedo).toBe(false);
    expect(h.undo()).toBe('b');
  });

  it('keeps at most `limit` steps back', () => {
    const h = new History<number>(2);
    for (let i = 0; i < 5; i++) h.record(i);
    expect(h.undo()).toBe(3);
    expect(h.undo()).toBe(2);
    expect(h.undo()).toBeUndefined();
  });
});
