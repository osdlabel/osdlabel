import { useMemo, type CSSProperties } from 'react';
import { useAnnotator } from '../state/annotator-context.js';
import {
  deriveToolbarModel,
  preventButtonFocusSteal,
  themeVar,
  toolButtonPart,
  OSDLABEL_PARTS,
  type ToolbarSlotProps,
} from 'osdlabel';

/**
 * The toolbar's model and commands, as an override toolbar receives them.
 * Memoised on the state slices the model reads, so an unrelated annotator
 * update hands an override the same `model` reference.
 */
export function useToolbarSlotProps(): ToolbarSlotProps {
  const { uiState, contextState, annotationState, constraintStatus, actions, activeImageId } =
    useAnnotator();

  const selectedId = uiState.selectedAnnotationId;
  // `activeImageId` is `undefined` exactly when the active cell is empty.
  const imageAnnotations = activeImageId ? annotationState.byImage[activeImageId] : undefined;
  const selected = selectedId ? imageAnnotations?.[selectedId] : undefined;
  const selectedGeometryType = selected?.geometry.type;

  const { activeTool, brushRadius, brushErasing } = uiState;
  const { contexts, activeContextId } = contextState;
  const model = useMemo(() => {
    const ctx = contexts.find((c) => c.id === activeContextId);
    return deriveToolbarModel({
      activeTool,
      allowedTools: ctx ? ctx.tools.map((t) => t.type) : [],
      constraintStatus,
      brushRadius,
      brushErasing,
      selectedGeometryType,
    });
  }, [
    activeTool,
    contexts,
    activeContextId,
    constraintStatus,
    brushRadius,
    brushErasing,
    selectedGeometryType,
  ]);

  return useMemo(
    (): ToolbarSlotProps => ({
      model,
      onSelectTool: (tool) => {
        const button = model.buttons.find((b) => b.tool === tool);
        if (button?.enabled) actions.setActiveTool(tool);
      },
      onBrushRadiusChange: (radius) => actions.setBrushRadius(radius),
      onBrushErasingChange: (erasing) => actions.setBrushErasing(erasing),
      onConvertToRect: () => {
        if (selected && model.convertToRect?.enabled) {
          actions.convertAnnotation(selected.id, selected.imageId);
        }
      },
    }),
    [model, actions, selected],
  );
}

const buttonStyle = (b: {
  readonly active: boolean;
  readonly enabled: boolean;
}): CSSProperties => ({
  padding: themeVar('controlPadding'),
  border: 'none',
  borderRadius: themeVar('radius'),
  cursor: b.enabled ? 'pointer' : 'not-allowed',
  background: b.active
    ? themeVar('accent')
    : b.enabled
      ? themeVar('control')
      : themeVar('controlDisabled'),
  color: b.enabled ? themeVar('text') : themeVar('textDisabled'),
  fontWeight: b.active ? 'bold' : 'normal',
  fontSize: themeVar('fontSizeControl'),
  opacity: b.enabled ? 1 : 0.5,
});

/** The stock toolbar's rendering, from {@link ToolbarSlotProps} alone. */
export function ToolbarView(props: ToolbarSlotProps) {
  const { model } = props;
  return (
    <div
      part={OSDLABEL_PARTS.toolbar}
      onMouseDown={preventButtonFocusSteal}
      style={{
        display: 'flex',
        gap: themeVar('gap'),
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      {model.buttons.map((b) => (
        <button
          key={b.key}
          data-testid={`tool-${b.key}`}
          part={toolButtonPart(b)}
          data-active={b.active}
          disabled={!b.enabled}
          onClick={() => props.onSelectTool(b.tool)}
          style={buttonStyle(b)}
        >
          {b.countLabel === null ? b.label : `${b.label} ${b.countLabel}`}
        </button>
      ))}

      {/* Brush options, present only while the brush is the active tool */}
      {model.brush && (
        <div style={{ display: 'flex', alignItems: 'center', gap: themeVar('gap') }}>
          <label
            htmlFor="brush-radius"
            style={{
              color: themeVar('textSubtle'),
              fontSize: themeVar('fontSizeStatus'),
              whiteSpace: 'nowrap',
            }}
          >
            Brush
          </label>
          <input
            id="brush-radius"
            data-testid="brush-radius"
            type="range"
            min={model.brush.min}
            max={model.brush.max}
            value={model.brush.radius}
            onChange={(e) => props.onBrushRadiusChange(Number(e.currentTarget.value))}
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
              fontSize: themeVar('fontSizeStatus'),
              minWidth: '34px',
            }}
          >
            {model.brush.radius}px
          </span>
          <button
            data-testid="brush-eraser"
            aria-pressed={model.brush.erasing}
            onClick={() => props.onBrushErasingChange(!model.brush!.erasing)}
            style={buttonStyle({ active: model.brush.erasing, enabled: true })}
          >
            Erase
          </button>
        </div>
      )}

      {/* Contextual action: convert the selected circle to its bounding rectangle */}
      {model.convertToRect && (
        <button
          data-testid="convert-to-rect"
          disabled={!model.convertToRect.enabled}
          onClick={() => props.onConvertToRect()}
          style={{
            ...buttonStyle({ active: false, enabled: model.convertToRect.enabled }),
            fontWeight: undefined,
          }}
        >
          Convert to Rect
        </button>
      )}
    </div>
  );
}

export default function Toolbar() {
  return <ToolbarView {...useToolbarSlotProps()} />;
}
