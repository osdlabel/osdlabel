// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import {
  FULLSCREEN_ROOT_ATTRIBUTE,
  resolveFullscreenTarget,
} from '../../src/fullscreen-target.js';

afterEach(() => {
  document.body.innerHTML = '';
});

/** Builds `<div data-osdlabel-fullscreen-root><div><button/></div></div>`. */
function mountLayout(): { root: HTMLDivElement; button: HTMLButtonElement } {
  const root = document.createElement('div');
  root.setAttribute(FULLSCREEN_ROOT_ATTRIBUTE, '');
  const bar = document.createElement('div');
  const button = document.createElement('button');
  bar.appendChild(button);
  root.appendChild(bar);
  document.body.appendChild(root);
  return { root, button };
}

describe('resolveFullscreenTarget', () => {
  it('prefers an explicit element over everything else', () => {
    const explicit = document.createElement('section');
    const { root, button } = mountLayout();
    expect(resolveFullscreenTarget({ explicit, registered: root, from: button })).toBe(explicit);
  });

  it('calls an explicit getter', () => {
    const explicit = document.createElement('section');
    expect(resolveFullscreenTarget({ explicit: () => explicit })).toBe(explicit);
  });

  it('falls through when an explicit getter returns null', () => {
    // A getter is how a host names an element that mounts after the provider;
    // before it exists, resolution must continue down the chain.
    const { root, button } = mountLayout();
    expect(resolveFullscreenTarget({ explicit: () => null, registered: root, from: button })).toBe(
      root,
    );
  });

  it('uses the registered Annotator root when there is no explicit target', () => {
    const registered = document.createElement('div');
    const { button } = mountLayout();
    expect(resolveFullscreenTarget({ registered, from: button })).toBe(registered);
  });

  it('finds the marked ancestor for a hand-composed layout', () => {
    // No <Annotator>, so nothing registered — the host opts in with one
    // attribute on its own root and the button walks up to it.
    const { root, button } = mountLayout();
    expect(resolveFullscreenTarget({ from: button })).toBe(root);
  });

  it('falls back to the document element rather than resolving to nothing', () => {
    const orphan = document.createElement('button');
    document.body.appendChild(orphan);
    expect(resolveFullscreenTarget({ from: orphan })).toBe(document.documentElement);
  });

  it('falls back when given nothing at all', () => {
    expect(resolveFullscreenTarget({})).toBe(document.documentElement);
  });
});
