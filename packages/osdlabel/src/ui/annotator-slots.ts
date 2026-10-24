import type { ToolbarSlotProps } from './toolbar-model.js';

/**
 * The override points of the stock `<Annotator>` and the props each receives.
 *
 * Two sides map over this. The host side is optional: each binding's
 * `AnnotatorComponents` is `{ [K in AnnotatorSlotName]?: Component<…[K]> }`,
 * so a host overrides only what it wants. The renderer side is exhaustive:
 * the Solid and React bindings each declare `ANNOTATOR_SLOT_RENDERERS`
 * (`satisfies { readonly [K in AnnotatorSlotName]: AnnotatorSlotRenderer<K> }`)
 * and render every slot of the stock layout through it, and the element
 * declares `createElementSlots` the same way. Adding a slot here is therefore
 * a type error in all three renderers until each renders it; each has an
 * `@ts-expect-error` test pinning that, and a runtime test that an override
 * for every name in {@link ANNOTATOR_SLOT_NAMES} is rendered.
 *
 * Prototype scope: one slot. StatusBar, Filmstrip, ViewControls and the cell
 * placeholder are the obvious next entries.
 */
export interface AnnotatorSlotPropsMap {
  readonly Toolbar: ToolbarSlotProps;
}

export type AnnotatorSlotName = keyof AnnotatorSlotPropsMap;

/** The element's `<slot name>` for each override point. */
export const ANNOTATOR_SLOT_NAMES: Readonly<Record<AnnotatorSlotName, string>> = {
  Toolbar: 'toolbar',
};
