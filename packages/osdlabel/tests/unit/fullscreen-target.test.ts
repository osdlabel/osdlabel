// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { resolveFullscreenTarget } from '../../src/fullscreen-target.js';

afterEach(() => {
  document.body.innerHTML = '';
});

function mountElement(): HTMLDivElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

describe('resolveFullscreenTarget', () => {
  it('prefers an explicit element over a registered root', () => {
    const explicit = mountElement();
    const registered = mountElement();
    expect(resolveFullscreenTarget({ explicit, registered })).toBe(explicit);
  });

  it('calls an explicit getter', () => {
    const explicit = mountElement();
    expect(resolveFullscreenTarget({ explicit: () => explicit })).toBe(explicit);
  });

  it('falls through when an explicit getter returns null', () => {
    // A getter is how a host names an element that mounts after the provider;
    // before it exists, resolution must continue down the chain.
    const registered = mountElement();
    expect(resolveFullscreenTarget({ explicit: () => null, registered })).toBe(registered);
  });

  it('uses the registered root when there is no explicit target', () => {
    // Claimed via the context's fullscreenTargetRef — by <Annotator> with its
    // own root, or by a hand-composed layout with whichever element wraps the
    // annotator UI.
    const registered = mountElement();
    expect(resolveFullscreenTarget({ registered })).toBe(registered);
  });

  it('falls back to the document element rather than resolving to nothing', () => {
    // A toggle that silently does nothing is worse than one that fullscreens
    // the page, and the two tiers above cover every expressible intent.
    expect(resolveFullscreenTarget({})).toBe(document.documentElement);
  });

  it('treats a null registered root as unclaimed', () => {
    expect(resolveFullscreenTarget({ explicit: null, registered: null })).toBe(
      document.documentElement,
    );
  });
});
