// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  exitFullscreen,
  getFullscreenElement,
  isDocumentFullscreen,
  isFullscreenSupported,
  onFullscreenChange,
  requestFullscreen,
  shouldSuppressEscapeKey,
  toggleFullscreen,
} from '../../src/fullscreen.js';

type Mutable = Record<string, unknown>;

/** jsdom implements no part of the Fullscreen API, so every bit is stubbed. */
function defineOnDocument(property: string, value: unknown): void {
  Object.defineProperty(document, property, { configurable: true, value });
}

function defineGetterOnDocument(property: string, get: () => unknown): void {
  Object.defineProperty(document, property, { configurable: true, get });
}

afterEach(() => {
  for (const property of [
    'fullscreenElement',
    'webkitFullscreenElement',
    'fullscreenEnabled',
    'webkitFullscreenEnabled',
    'exitFullscreen',
    'webkitExitFullscreen',
  ]) {
    delete (document as unknown as Mutable)[property];
  }
  delete (Element.prototype as unknown as Mutable).requestFullscreen;
  delete (Element.prototype as unknown as Mutable).webkitRequestFullscreen;
});

describe('getFullscreenElement', () => {
  it('returns null when the API is absent entirely', () => {
    // The regression this normalization exists for: jsdom leaves the property
    // undefined, and `undefined !== null` is true. Without `?? null`, every
    // test environment — and Firefox before the API is touched — would look
    // like it was in fullscreen.
    expect((document as unknown as Mutable).fullscreenElement).toBeUndefined();
    expect(getFullscreenElement()).toBeNull();
    expect(isDocumentFullscreen()).toBe(false);
  });

  it('returns null when nothing is fullscreen', () => {
    defineGetterOnDocument('fullscreenElement', () => null);
    expect(getFullscreenElement()).toBeNull();
    expect(isDocumentFullscreen()).toBe(false);
  });

  it('returns the fullscreen element when one is set', () => {
    const el = document.createElement('div');
    defineGetterOnDocument('fullscreenElement', () => el);
    expect(getFullscreenElement()).toBe(el);
    expect(isDocumentFullscreen()).toBe(true);
  });

  it('falls back to the webkit-prefixed property', () => {
    const el = document.createElement('div');
    defineGetterOnDocument('webkitFullscreenElement', () => el);
    expect(getFullscreenElement()).toBe(el);
  });
});

describe('shouldSuppressEscapeKey', () => {
  it('suppresses Escape only while an element is fullscreen', () => {
    expect(shouldSuppressEscapeKey('Escape')).toBe(false);
    defineGetterOnDocument('fullscreenElement', () => document.createElement('div'));
    expect(shouldSuppressEscapeKey('Escape')).toBe(true);
  });

  it('never suppresses other keys', () => {
    defineGetterOnDocument('fullscreenElement', () => document.createElement('div'));
    for (const key of ['r', 'v', 'Enter', 'Delete', 'Backspace']) {
      expect(shouldSuppressEscapeKey(key)).toBe(false);
    }
  });

  it('keys off the browser key, not a configurable cancel binding', () => {
    // A consumer who rebinds `cancel` to 'q' must keep 'q' working while
    // fullscreen — the browser only reserves Escape.
    defineGetterOnDocument('fullscreenElement', () => document.createElement('div'));
    expect(shouldSuppressEscapeKey('q')).toBe(false);
  });
});

describe('requestFullscreen', () => {
  it('resolves true for the standard promise-returning form', async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    (Element.prototype as unknown as Mutable).requestFullscreen = request;
    const el = document.createElement('div');
    await expect(requestFullscreen(el)).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("resolves true for Safari's prefixed form, which returns undefined", async () => {
    (Element.prototype as unknown as Mutable).webkitRequestFullscreen = vi.fn(() => undefined);
    await expect(requestFullscreen(document.createElement('div'))).resolves.toBe(true);
  });

  it('resolves false instead of rejecting when the browser refuses', async () => {
    // No user gesture, or a fullscreen=() permissions policy. An unhandled
    // rejection inside a click handler helps nobody.
    (Element.prototype as unknown as Mutable).requestFullscreen = vi
      .fn()
      .mockRejectedValue(new Error('NotAllowedError'));
    await expect(requestFullscreen(document.createElement('div'))).resolves.toBe(false);
  });

  it('resolves false when the method throws synchronously', async () => {
    (Element.prototype as unknown as Mutable).requestFullscreen = vi.fn(() => {
      throw new Error('boom');
    });
    await expect(requestFullscreen(document.createElement('div'))).resolves.toBe(false);
  });

  it('resolves false when no API exists', async () => {
    await expect(requestFullscreen(document.createElement('div'))).resolves.toBe(false);
  });
});

describe('exitFullscreen', () => {
  it('calls the standard method', async () => {
    const exit = vi.fn().mockResolvedValue(undefined);
    defineOnDocument('exitFullscreen', exit);
    await expect(exitFullscreen()).resolves.toBe(true);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('falls back to the webkit-prefixed method', async () => {
    const exit = vi.fn(() => undefined);
    defineOnDocument('webkitExitFullscreen', exit);
    await expect(exitFullscreen()).resolves.toBe(true);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('resolves false when no API exists', async () => {
    await expect(exitFullscreen()).resolves.toBe(false);
  });
});

describe('toggleFullscreen', () => {
  it('enters when nothing is fullscreen', async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn().mockResolvedValue(undefined);
    (Element.prototype as unknown as Mutable).requestFullscreen = request;
    defineOnDocument('exitFullscreen', exit);

    await toggleFullscreen(document.createElement('div'));

    expect(request).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits when something is fullscreen', async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn().mockResolvedValue(undefined);
    (Element.prototype as unknown as Mutable).requestFullscreen = request;
    defineOnDocument('exitFullscreen', exit);
    defineGetterOnDocument('fullscreenElement', () => document.createElement('div'));

    await toggleFullscreen(document.createElement('div'));

    expect(exit).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('onFullscreenChange', () => {
  it('registers and removes both the standard and prefixed events', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const listener = vi.fn();

    const unsubscribe = onFullscreenChange(listener);
    expect(add.mock.calls.map(([name]) => name)).toEqual([
      'fullscreenchange',
      'webkitfullscreenchange',
    ]);

    unsubscribe();
    expect(remove.mock.calls.map(([name]) => name)).toEqual([
      'fullscreenchange',
      'webkitfullscreenchange',
    ]);

    add.mockRestore();
    remove.mockRestore();
  });

  it('invokes the listener when the event fires', () => {
    const listener = vi.fn();
    const unsubscribe = onFullscreenChange(listener);
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('isFullscreenSupported', () => {
  it('is false when the element-level API is missing', () => {
    // iPhone Safari: no Element.requestFullscreen at all.
    expect(isFullscreenSupported()).toBe(false);
  });

  it('is true with the standard method', () => {
    (Element.prototype as unknown as Mutable).requestFullscreen = vi.fn();
    expect(isFullscreenSupported()).toBe(true);
  });

  it('is true with only the prefixed method', () => {
    (Element.prototype as unknown as Mutable).webkitRequestFullscreen = vi.fn();
    expect(isFullscreenSupported()).toBe(true);
  });

  it('is false when a permissions policy disabled fullscreen', () => {
    // e.g. an <iframe> without allow="fullscreen".
    (Element.prototype as unknown as Mutable).requestFullscreen = vi.fn();
    defineGetterOnDocument('fullscreenEnabled', () => false);
    expect(isFullscreenSupported()).toBe(false);
  });
});
