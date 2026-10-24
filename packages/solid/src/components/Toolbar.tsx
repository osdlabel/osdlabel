import { Index, Show, createMemo, onMount, type Component } from 'solid-js';
import { useAnnotator } from '../state/annotator-context.js';
import {
  adoptStockStyles,
  deriveToolbarModel,
  partClassName,
  preventButtonFocusSteal,
  toolButtonPart,
  OSDLABEL_PARTS,
  type ToolbarButtonModel,
  type ToolbarSlotProps,
} from 'osdlabel';

/**
 * The toolbar's model and commands, as an override toolbar receives them.
 * `model` is a getter over a memo, so reading it inside JSX or an effect
 * tracks the state it is derived from.
 */
export function useToolbarSlotProps(): ToolbarSlotProps {
  const { uiState, contextState, annotationState, constraintStatus, actions, activeImageId } =
    useAnnotator();

  const selected = () => {
    const id = uiState.selectedAnnotationId;
    // `activeImageId` is `undefined` exactly when the active cell is empty.
    const imageId = activeImageId();
    if (!id || !imageId) return undefined;
    return annotationState.byImage[imageId]?.[id];
  };

  const model = createMemo(() => {
    const ctx = contextState.contexts.find((c) => c.id === contextState.activeContextId);
    return deriveToolbarModel({
      activeTool: uiState.activeTool,
      allowedTools: ctx ? ctx.tools.map((t) => t.type) : [],
      constraintStatus: constraintStatus(),
      brushRadius: uiState.brushRadius,
      brushErasing: uiState.brushErasing,
      selectedGeometryType: selected()?.geometry.type,
    });
  });

  return {
    get model() {
      return model();
    },
    onSelectTool: (tool) => {
      const button = model().buttons.find((b) => b.tool === tool);
      if (button?.enabled) actions.setActiveTool(tool);
    },
    onBrushRadiusChange: (radius) => actions.setBrushRadius(radius),
    onBrushErasingChange: (erasing) => actions.setBrushErasing(erasing),
    onConvertToRect: () => {
      const ann = selected();
      if (ann && model().convertToRect?.enabled) actions.convertAnnotation(ann.id, ann.imageId);
    },
  };
}

/** A toolbar button's class: the class twins of its `part` value. */
const buttonClass = (b: { readonly active: boolean; readonly enabled: boolean }): string =>
  partClassName(toolButtonPart(b));

/**
 * The stock toolbar's rendering, from {@link ToolbarSlotProps} alone.
 *
 * Styled by the shared `@layer osdlabel` stylesheet (`OSDLABEL_STOCK_CSS`),
 * not inline, so light-DOM host CSS can override it through the part names
 * or their `osdlabel-*` class twins; the sheet is adopted into whichever
 * root (document or shadow root) the toolbar mounts in.
 */
export const ToolbarView: Component<ToolbarSlotProps> = (props) => {
  let root: HTMLDivElement | undefined;
  onMount(() => {
    if (root) adoptStockStyles(root);
  });

  const button = (b: () => ToolbarButtonModel) => (
    <button
      data-testid={`tool-${b().key}`}
      part={toolButtonPart(b())}
      class={buttonClass(b())}
      data-active={b().active}
      disabled={!b().enabled}
      onClick={() => props.onSelectTool(b().tool)}
    >
      {b().countLabel === null ? b().label : `${b().label} ${b().countLabel}`}
    </button>
  );

  return (
    <div
      ref={root}
      part={OSDLABEL_PARTS.toolbar}
      class={partClassName(OSDLABEL_PARTS.toolbar)}
      onMouseDown={preventButtonFocusSteal}
    >
      {/* Index, not For: the model is re-derived as one object, so keying by
          identity would remount every button on every change. */}
      <Index each={props.model.buttons}>{button}</Index>

      {/* Brush options, present only while the brush is the active tool */}
      <Show when={props.model.brush}>
        {(brush) => (
          <div
            part={OSDLABEL_PARTS.brushOptions}
            class={partClassName(OSDLABEL_PARTS.brushOptions)}
          >
            <label
              for="brush-radius"
              part={OSDLABEL_PARTS.brushLabel}
              class={partClassName(OSDLABEL_PARTS.brushLabel)}
            >
              Brush
            </label>
            <input
              id="brush-radius"
              data-testid="brush-radius"
              part={OSDLABEL_PARTS.brushRadius}
              class={partClassName(OSDLABEL_PARTS.brushRadius)}
              type="range"
              min={brush().min}
              max={brush().max}
              value={brush().radius}
              onInput={(e) => props.onBrushRadiusChange(Number(e.currentTarget.value))}
              // A focused input suppresses every keyboard shortcut, so after
              // touching the slider `[`, `]`, `b` and Escape were all dead until
              // the user clicked elsewhere — including the mid-stroke cancel.
              // Focus is released on any pointer interaction, click included, so
              // click-then-arrow-keys does not work; tabbing to it still does,
              // which is the path where the arrow keys are the point.
              onPointerUp={(e) => e.currentTarget.blur()}
            />
            <span
              data-testid="brush-radius-value"
              part={OSDLABEL_PARTS.brushRadiusValue}
              class={partClassName(OSDLABEL_PARTS.brushRadiusValue)}
            >
              {brush().radius}px
            </span>
            <button
              data-testid="brush-eraser"
              aria-pressed={brush().erasing}
              part={toolButtonPart({ active: brush().erasing, enabled: true })}
              class={buttonClass({ active: brush().erasing, enabled: true })}
              onClick={() => props.onBrushErasingChange(!brush().erasing)}
            >
              Erase
            </button>
          </div>
        )}
      </Show>

      {/* Contextual action: convert the selected circle to its bounding rectangle */}
      <Show when={props.model.convertToRect}>
        {(convert) => (
          <button
            data-testid="convert-to-rect"
            part={toolButtonPart({ active: false, enabled: convert().enabled })}
            class={buttonClass({ active: false, enabled: convert().enabled })}
            disabled={!convert().enabled}
            onClick={() => props.onConvertToRect()}
          >
            Convert to Rect
          </button>
        )}
      </Show>
    </div>
  );
};

const Toolbar: Component = () => {
  const slot = useToolbarSlotProps();
  return (
    <ToolbarView
      model={slot.model}
      onSelectTool={slot.onSelectTool}
      onBrushRadiusChange={slot.onBrushRadiusChange}
      onBrushErasingChange={slot.onBrushErasingChange}
      onConvertToRect={slot.onConvertToRect}
    />
  );
};

export default Toolbar;
