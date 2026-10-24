import type { ToolbarSlotProps } from './toolbar-model.js';

/**
 * The override points of the stock `<Annotator>` and the props each receives.
 *
 * Each binding derives its `AnnotatorComponents` type by mapping over this
 * (`{ [K in AnnotatorSlotName]?: Component<AnnotatorSlotPropsMap[K]> }`), and
 * the element derives its slot names from it, so adding a slot here is a type
 * error in every renderer until each one supports it.
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
