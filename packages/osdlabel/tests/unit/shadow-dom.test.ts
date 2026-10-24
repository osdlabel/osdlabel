import { describe, expect, it } from 'vitest';
import { getEventOrigin, isFocusedInItsRoot } from '../../src/shadow-dom.js';

// No DOM in this package's test environment: the helpers only read
// `target`, `composedPath()`, `shadowRoot`, `getRootNode()` and `activeElement`,
// so plain objects stand in for them.
const fakeEvent = (target: object | null, path: readonly object[]): Event =>
  ({ target, composedPath: () => [...path] }) as unknown as Event;

describe('getEventOrigin', () => {
  it('is the target for an event from the light DOM', () => {
    const input = { tagName: 'INPUT' };
    expect(getEventOrigin(fakeEvent(input, [input, {}]))).toBe(input);
  });

  it('looks through a shadow host to the original target', () => {
    const inner = { tagName: 'INPUT' };
    const host = { tagName: 'OSDLABEL-ANNOTATOR', shadowRoot: {} };
    expect(getEventOrigin(fakeEvent(host, [inner, {}, host]))).toBe(inner);
  });

  it('keeps a stand-in target even when the path starts elsewhere', () => {
    // Unit tests dispatch on window with `target` redefined; the path then
    // starts at window, which must not replace the stand-in.
    const standIn = { tagName: 'TEXTAREA' };
    expect(getEventOrigin(fakeEvent(standIn, [{ window: true }]))).toBe(standIn);
  });

  it('falls back to the host when the path is empty (outside dispatch)', () => {
    const host = { shadowRoot: {} };
    expect(getEventOrigin(fakeEvent(host, []))).toBe(host);
  });
});

describe('isFocusedInItsRoot', () => {
  it("compares against the element's own root's activeElement", () => {
    const root: { activeElement: unknown } = { activeElement: null };
    const el = { getRootNode: () => root } as unknown as Element;
    expect(isFocusedInItsRoot(el)).toBe(false);
    root.activeElement = el;
    expect(isFocusedInItsRoot(el)).toBe(true);
  });

  it('is false for a detached element, whose root has no activeElement', () => {
    const el = { getRootNode: () => ({}) } as unknown as Element;
    expect(isFocusedInItsRoot(el)).toBe(false);
  });
});
