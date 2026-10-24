import { customElement, noShadowDOM } from 'solid-element';
import type { JSX } from 'solid-js';
import { Annotator, useAnnotator } from '@osdlabel/solid';
import type { AnnotationContext } from '@osdlabel/annotation-context';
import type { ImageId, ImageSource } from '@osdlabel/viewer-api';
import type { ToolType } from '@osdlabel/annotation';
import {
  createAnnotatorEvent,
  type AnnotatorEventDetailMap,
  type AnnotatorEventName,
} from './element-events.js';
import type { ShadowMode } from './annotator-element.js';

/**
 * The same element built with `solid-element` (component-register) instead of
 * the hand-rolled `customElements.define` class, for the H1 comparison.
 *
 * What component-register gives for free: attribute ↔ property reflection
 * (kebab-case attribute → camelCase prop, values `JSON.parse`d), reactive
 * props, and HMR. What it does not: typed methods (they are assigned onto the
 * `any`-indexed element below), upgrade of properties set before definition
 * is handled, but its `ICustomElement` typing is `[prop: string]: any`.
 */
interface SolidElementProps {
  images: readonly ImageSource[];
  contexts: readonly AnnotationContext[];
  testMode: boolean;
  showFilmstrip: boolean;
  showGridControls: boolean;
  showContextSwitcher: boolean;
  showViewControls: boolean;
  filmstripPosition: 'left' | 'right' | 'bottom';
}

interface ElementCommands {
  readonly setActiveTool: (tool: ToolType | 'select' | null) => void;
  readonly assignImageToCell: (cellIndex: number, imageId: ImageId) => void;
}

function CommandBridge(props: {
  readonly install: (commands: ElementCommands) => void;
}): JSX.Element {
  const { actions } = useAnnotator();
  props.install({
    setActiveTool: (tool) => actions.setActiveTool(tool),
    assignImageToCell: (cellIndex, imageId) => actions.assignImageToCell(cellIndex, imageId),
  });
  return null;
}

export function defineWithSolidElement(
  tagName = 'osdlabel-annotator-se',
  shadow: ShadowMode = 'open',
): CustomElementConstructor {
  const existing = customElements.get(tagName);
  if (existing) return existing;
  return customElement<SolidElementProps>(
    tagName,
    {
      images: [],
      contexts: [],
      testMode: false,
      showFilmstrip: true,
      showGridControls: false,
      showContextSwitcher: false,
      showViewControls: true,
      filmstripPosition: 'left',
    },
    (props, { element }) => {
      if (shadow === 'none') noShadowDOM();
      const emit = <K extends AnnotatorEventName>(
        name: K,
        detail: AnnotatorEventDetailMap[K],
      ): void => {
        element.dispatchEvent(createAnnotatorEvent(name, detail));
      };
      queueMicrotask(() => emit('osdlabelready', { renderedAt: performance.now() }));
      return (
        <>
          <style>{':host{display:block;position:relative}'}</style>
          <div style={{ width: '100%', height: '100%' }}>
            <Annotator
              images={props.images}
              contexts={props.contexts}
              testMode={props.testMode}
              showFilmstrip={props.showFilmstrip}
              showGridControls={props.showGridControls}
              showContextSwitcher={props.showContextSwitcher}
              showViewControls={props.showViewControls}
              filmstripPosition={props.filmstripPosition}
              onAnnotationsChange={(annotations) => emit('annotationschange', { annotations })}
              onConstraintChange={(status) => emit('constraintchange', { status })}
              providerChildren={
                <CommandBridge install={(commands) => Object.assign(element, commands)} />
              }
            />
          </div>
        </>
      );
    },
  );
}
