import { createEffect, on, onCleanup, type Component, type JSX } from 'solid-js';
import { ToolbarView } from '@osdlabel/solid';
import { ANNOTATOR_SLOT_NAMES } from 'osdlabel';
import type { AnnotatorSlotName, AnnotatorSlotPropsMap, ToolbarSlotProps } from 'osdlabel';
import type { AnnotatorEventDetailMap, AnnotatorEventName } from './element-events.js';

/**
 * The element's renderer for every slot in the shared `AnnotatorSlotPropsMap`,
 * handed to the Solid `<Annotator components>` whole. Required keys: a slot
 * added to the shared map does not compile here until the element renders it
 * (as a named `<slot>` with the stock view as fallback content).
 */
export type ElementSlotTable = {
  readonly [K in AnnotatorSlotName]: Component<AnnotatorSlotPropsMap[K]>;
};

/** What the slot renderers need from the element that owns them. */
export interface ElementSlotHost {
  /** `true` in shadow mode, where named slots exist; light DOM has none. */
  readonly shadow: boolean;
  readonly emit: <K extends AnnotatorEventName>(
    name: K,
    detail: AnnotatorEventDetailMap[K],
  ) => void;
  /** The toolbar slot's live props while mounted, `undefined` after. */
  readonly onToolbarProps: (props: ToolbarSlotProps | undefined) => void;
}

/**
 * The stock view of slot `name` as the fallback content of the element's
 * `<slot name=…>`, so a host child with that `slot` attribute replaces it
 * with no script. Light DOM has no slots: the stock view renders as is.
 */
function slotted(host: ElementSlotHost, name: AnnotatorSlotName, stock: JSX.Element): JSX.Element {
  return host.shadow ? <slot name={ANNOTATOR_SLOT_NAMES[name]}>{stock}</slot> : stock;
}

export function createElementSlots(host: ElementSlotHost): ElementSlotTable {
  /**
   * The Toolbar override point. A slotted host toolbar drives the annotator
   * through `toolbarModel` / `toolbarmodelchange` and the `selectTool()`-style
   * commands, all fed from the props captured here.
   */
  const Toolbar: Component<ToolbarSlotProps> = (props) => {
    host.onToolbarProps(props);
    onCleanup(() => host.onToolbarProps(undefined));
    createEffect(
      on(
        () => props.model,
        (model) => host.emit('toolbarmodelchange', { model }),
      ),
    );
    return slotted(host, 'Toolbar', <ToolbarView {...props} />);
  };

  return { Toolbar } satisfies ElementSlotTable;
}
