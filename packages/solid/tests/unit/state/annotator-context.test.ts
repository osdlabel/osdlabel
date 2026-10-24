import { afterEach, describe, expect, it } from 'vitest';
import { createComponent, createEffect, createRoot, createSignal, untrack } from 'solid-js';
import type { DecorationProvider } from '@osdlabel/decoration';
import type { OsdFields } from 'osdlabel';
import { AnnotatorProvider, useAnnotator } from '../../../src/state/annotator-context.js';

/** A provider that decorates nothing; the tests count providers, not decorations. */
const provider = (): DecorationProvider<OsdFields> => () => [];

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
});

/**
 * `decorationProviders` written after mount reaches the provider's consumers.
 * The Solid provider used to copy the prop once at mount, so a later write
 * (Angular binds `[decorationProviders]` on the custom element only after it
 * has connected) rendered nothing. Mirrors
 * `packages/react/tests/unit/state/annotator-context.test.tsx`.
 */
describe('AnnotatorProvider decorationProviders', () => {
  it('exposes a later write to the prop, and a tracking effect re-runs', () => {
    const [providers, setProviders] = createSignal<readonly DecorationProvider<OsdFields>[]>([]);
    const seen: number[] = [];
    createRoot((d) => {
      dispose = d;
      createComponent(AnnotatorProvider, {
        get decorationProviders() {
          return providers();
        },
        get children() {
          // As a component body: Solid evaluates `children` in a tracking scope.
          return untrack(() => {
            const annotator = useAnnotator();
            createEffect(() => {
              seen.push(annotator.decorationProviders.length);
            });
            return null;
          });
        },
      });
    });
    expect(seen).toEqual([0]);
    setProviders([provider()]);
    expect(seen).toEqual([0, 1]);
    setProviders([provider(), provider()]);
    expect(seen).toEqual([0, 1, 2]);
  });

  it('reads an absent prop as an empty list', () => {
    let read: readonly DecorationProvider<OsdFields>[] | undefined;
    createRoot((d) => {
      dispose = d;
      createComponent(AnnotatorProvider, {
        get children() {
          read = untrack(() => useAnnotator().decorationProviders);
          return null;
        },
      });
    });
    expect(read).toEqual([]);
  });
});
