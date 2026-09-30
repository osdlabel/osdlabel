import { describe, it, expect } from 'vitest';
import { createAnnotationId } from '../../src/util.js';
import type { Annotation } from '../../src/annotation.js';

// These are type-level assertions: the file type-checks under
// `tsconfig.tests.json`, so a regression fails `pnpm typecheck`. The runtime
// expectations only keep Vitest from reporting empty tests.

const now = '2026-01-01T00:00:00.000Z';

describe('Annotation default extension (#165)', () => {
  it('bare Annotation is constructible from an object literal', () => {
    // With a `Record<string, never>` default, every field intersected with
    // `never` and this literal was a type error.
    const a: Annotation = {
      id: createAnnotationId('a'),
      geometry: { type: 'point', position: { x: 0, y: 0 } },
      toolType: 'point',
      createdAt: now,
      updatedAt: now,
    };
    expect(a.id).toBe('a');
  });

  it('Omit over bare Annotation keeps its real keys', () => {
    // `keyof` the old default was `string`, so this Omit collapsed to
    // `{ [k: string]: never }` and no literal could satisfy it.
    const draft: Omit<Annotation, 'createdAt' | 'updatedAt'> = {
      id: createAnnotationId('b'),
      geometry: { type: 'point', position: { x: 1, y: 2 } },
      toolType: 'point',
    };
    expect(draft.toolType).toBe('point');
  });

  it('still rejects unknown properties on a fresh literal', () => {
    const a: Annotation = {
      id: createAnnotationId('c'),
      geometry: { type: 'point', position: { x: 0, y: 0 } },
      toolType: 'point',
      createdAt: now,
      updatedAt: now,
      // @ts-expect-error - the empty default must not loosen excess-property checks
      notAField: true,
    };
    expect(a.id).toBe('c');
  });

  it('an explicit extension still requires its fields', () => {
    // @ts-expect-error - `contextId` is required by the extension
    const a: Annotation<{ readonly contextId: string }> = {
      id: createAnnotationId('d'),
      geometry: { type: 'point', position: { x: 0, y: 0 } },
      toolType: 'point',
      createdAt: now,
      updatedAt: now,
    };
    expect(a.id).toBe('d');
  });
});
