import type { ComponentType, ReactElement } from 'react';
import type { AnnotatorSlotName, AnnotatorSlotPropsMap } from 'osdlabel';
import { ToolbarView, useToolbarSlotProps } from './Toolbar.js';

/**
 * How the stock layout renders one override point: the hook deriving the
 * slot's shared props from annotator state, and the stock view drawn from
 * those props alone (which an override replaces).
 */
export interface AnnotatorSlotRenderer<K extends AnnotatorSlotName> {
  readonly useProps: () => AnnotatorSlotPropsMap[K];
  readonly Stock: ComponentType<AnnotatorSlotPropsMap[K]>;
}

/**
 * One renderer for every slot in the shared `AnnotatorSlotPropsMap`. The keys
 * are required, not optional: a slot added to the shared map does not compile
 * here until this binding renders it.
 */
export type AnnotatorSlotRendererTable = {
  readonly [K in AnnotatorSlotName]: AnnotatorSlotRenderer<K>;
};

/** This binding's slot renderers. `<AnnotatorSlot>` renders every slot through it. */
export const ANNOTATOR_SLOT_RENDERERS = {
  Toolbar: { useProps: useToolbarSlotProps, Stock: ToolbarView },
} as const satisfies AnnotatorSlotRendererTable;

const renderers: AnnotatorSlotRendererTable = ANNOTATOR_SLOT_RENDERERS;

export interface AnnotatorSlotProps<K extends AnnotatorSlotName> {
  readonly name: K;
  /** The host's replacement, from `<Annotator components>`; the stock view when absent. */
  readonly override: ComponentType<AnnotatorSlotPropsMap[K]> | undefined;
}

/**
 * Renders slot `name`: the override if one is given, else the stock view,
 * both with the slot's shared props. `name` is fixed for the life of the
 * layout, so the props hook it selects is called in a stable order.
 */
export function AnnotatorSlot<K extends AnnotatorSlotName>({
  name,
  override,
}: AnnotatorSlotProps<K>): ReactElement {
  const renderer = renderers[name];
  const slotProps = renderer.useProps();
  const View = override ?? renderer.Stock;
  return <View {...slotProps} />;
}
