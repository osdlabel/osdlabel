import { Show, createComponent, untrack, type Component, type JSX } from 'solid-js';
import type { AnnotatorSlotName, AnnotatorSlotPropsMap } from 'osdlabel';
import { ToolbarView, useToolbarSlotProps } from './Toolbar.js';

/**
 * How the stock layout renders one override point: the hook deriving the
 * slot's shared props from annotator state, and the stock view drawn from
 * those props alone (which an override replaces).
 */
export interface AnnotatorSlotRenderer<K extends AnnotatorSlotName> {
  readonly useProps: () => AnnotatorSlotPropsMap[K];
  readonly Stock: Component<AnnotatorSlotPropsMap[K]>;
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
  readonly override: Component<AnnotatorSlotPropsMap[K]> | undefined;
}

/**
 * Renders slot `name`: the override if one is given, else the stock view,
 * both with the slot's shared props. The props object keeps its getters, so
 * the view tracks the state they are derived from.
 */
export function AnnotatorSlot<K extends AnnotatorSlotName>(
  props: AnnotatorSlotProps<K>,
): JSX.Element {
  // A slot's name is fixed for the life of the layout.
  const renderer = renderers[untrack(() => props.name)];
  const slotProps = renderer.useProps();
  // createComponent rather than <Dynamic {...slotProps}>: Dynamic's props
  // type cannot follow a generic slot name once the map has two slots.
  return (
    <Show when={props.override} keyed fallback={createComponent(renderer.Stock, slotProps)}>
      {(Override) => createComponent(Override, slotProps)}
    </Show>
  );
}
