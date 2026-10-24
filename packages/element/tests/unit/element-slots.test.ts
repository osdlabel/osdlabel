import { describe, expect, it } from 'vitest';
import { ANNOTATOR_SLOT_NAMES } from 'osdlabel';
import {
  createElementSlots,
  type ElementSlotHost,
  type ElementSlotTable,
} from '../../src/index.js';

const host: ElementSlotHost = {
  shadow: true,
  emit: () => undefined,
  onToolbarProps: () => undefined,
};

/**
 * The element's slot table is exhaustive over the shared slot map, like each
 * binding's renderer table. The E2E theme spec checks the runtime half: a
 * named `<slot>` for every shared slot name in the shadow root.
 */
describe('element slot table', () => {
  it('has a renderer for exactly the shared slot names', () => {
    expect(Object.keys(createElementSlots(host)).sort()).toEqual(
      Object.keys(ANNOTATOR_SLOT_NAMES).sort(),
    );
  });

  it('does not compile without a renderer for every shared slot', () => {
    const { Toolbar: omitted, ...withoutToolbar } = createElementSlots(host);
    // @ts-expect-error -- a table missing a slot must not type-check; if this
    // directive is reported unused, the table type stopped being exhaustive.
    const incomplete: ElementSlotTable = withoutToolbar;
    expect(Object.keys(incomplete)).not.toContain('Toolbar');
    expect(typeof omitted).toBe('function');
  });
});
