import { afterEach, describe, expect, it } from 'vitest';
import type { DecorationProvider } from '@osdlabel/decoration';
import type { OsdFields } from 'osdlabel';
import { renderAnnotator } from '../render-annotator.js';
import { unmountAll } from '../mount.js';

/** A provider that decorates nothing; the tests count providers, not decorations. */
const provider = (): DecorationProvider<OsdFields> => () => [];

afterEach(unmountAll);

/**
 * `decorationProviders` written after mount reaches the provider's consumers.
 * React re-renders the provider with the new prop; the Solid binding needed a
 * getter for the same behaviour. Mirrors
 * `packages/solid/tests/unit/state/annotator-context.test.ts`.
 */
describe('AnnotatorProvider decorationProviders', () => {
  it('exposes a later write to the prop', () => {
    const h = renderAnnotator({ decorationProviders: [] });
    expect(h.current.decorationProviders).toHaveLength(0);
    h.rerender({ decorationProviders: [provider()] });
    expect(h.current.decorationProviders).toHaveLength(1);
    h.rerender({ decorationProviders: [provider(), provider()] });
    expect(h.current.decorationProviders).toHaveLength(2);
  });

  it('reads an absent prop as an empty list', () => {
    const h = renderAnnotator();
    expect(h.current.decorationProviders).toEqual([]);
  });
});
