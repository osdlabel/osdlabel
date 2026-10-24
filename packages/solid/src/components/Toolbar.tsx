import { Index, Show, createMemo, type Component } from 'solid-js';
import { useAnnotator } from '../state/annotator-context.js';
import {
  deriveToolbarModel,
  preventButtonFocusSteal,
  themeVar,
  toolButtonPart,
  OSDLABEL_PARTS,
  type ToolbarButtonModel,
  type ToolbarSlotProps,
} from 'osdlabel';
import type { JSX } from 'solid-js';

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

const buttonStyle = (b: {
  readonly active: boolean;
  readonly enabled: boolean;
}): JSX.CSSProperties => ({
  padding: themeVar('controlPadding'),
  border: 'none',
  'border-radius': themeVar('radius'),
  cursor: b.enabled ? 'pointer' : 'not-allowed',
  background: b.active
    ? themeVar('accent')
    : b.enabled
      ? themeVar('control')
      : themeVar('controlDisabled'),
  color: b.enabled ? themeVar('text') : themeVar('textDisabled'),
  'font-weight': b.active ? 'bold' : 'normal',
  'font-size': themeVar('fontSizeControl'),
  opacity: b.enabled ? '1' : '0.5',
});

/** The stock toolbar's rendering, from {@link ToolbarSlotProps} alone. */
export const ToolbarView: Component<ToolbarSlotProps> = (props) => {
  const button = (b: () => ToolbarButtonModel) => (
    <button
      data-testid={`tool-${b().key}`}
      part={toolButtonPart(b())}
      data-active={b().active}
      disabled={!b().enabled}
      onClick={() => props.onSelectTool(b().tool)}
      style={buttonStyle(b())}
    >
      {b().countLabel === null ? b().label : `${b().label} ${b().countLabel}`}
    </button>
  );

  return (
    <div
      part={OSDLABEL_PARTS.toolbar}
      onMouseDown={preventButtonFocusSteal}
      style={{
        display: 'flex',
        gap: themeVar('gap'),
        'align-items': 'center',
        'flex-wrap': 'wrap',
      }}
    >
      {/* Index, not For: the model is re-derived as one object, so keying by
          identity would remount every button on every change. */}
      <Index each={props.model.buttons}>{button}</Index>

      {/* Brush options, present only while the brush is the active tool */}
      <Show when={props.model.brush}>
        {(brush) => (
          <div style={{ display: 'flex', 'align-items': 'center', gap: themeVar('gap') }}>
            <label
              for="brush-radius"
              style={{
                color: themeVar('textSubtle'),
                'font-size': themeVar('fontSizeStatus'),
                'white-space': 'nowrap',
              }}
            >
              Brush
            </label>
            <input
              id="brush-radius"
              data-testid="brush-radius"
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
              style={{ width: '90px' }}
            />
            <span
              data-testid="brush-radius-value"
              style={{
                color: themeVar('text'),
                'font-size': themeVar('fontSizeStatus'),
                'min-width': '34px',
              }}
            >
              {brush().radius}px
            </span>
            <button
              data-testid="brush-eraser"
              aria-pressed={brush().erasing}
              onClick={() => props.onBrushErasingChange(!brush().erasing)}
              style={buttonStyle({ active: brush().erasing, enabled: true })}
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
            disabled={!convert().enabled}
            onClick={() => props.onConvertToRect()}
            style={{
              ...buttonStyle({ active: false, enabled: convert().enabled }),
              'font-weight': undefined,
            }}
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
