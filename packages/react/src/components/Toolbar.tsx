import { useLayoutEffect, useMemo, useRef } from 'react';
import { useAnnotator } from '../state/annotator-context.js';
import {
  adoptStockStyles,
  deriveToolbarModel,
  partClassName,
  preventButtonFocusSteal,
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

/** A toolbar button's `part` value and its class twin, for the given state. */
function buttonHooks(b: { readonly active: boolean; readonly enabled: boolean }): {
  readonly part: string;
  readonly className: string;
} {
  const part = toolButtonPart(b);
  return { part, className: partClassName(part) };
}

/**
 * The stock toolbar's rendering, from {@link ToolbarSlotProps} alone.
 *
 * Styled by the shared `@layer osdlabel` stylesheet (`OSDLABEL_STOCK_CSS`),
 * not inline, so light-DOM host CSS can override it through the part names
 * or their `osdlabel-*` class twins; the sheet is adopted into whichever
 * root (document or shadow root) the toolbar mounts in, before paint.
 */
export function ToolbarView(props: ToolbarSlotProps) {
  const { model } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (rootRef.current) adoptStockStyles(rootRef.current);
  }, []);

  return (
    <div
      ref={rootRef}
      part={OSDLABEL_PARTS.toolbar}
      className={partClassName(OSDLABEL_PARTS.toolbar)}
      onMouseDown={preventButtonFocusSteal}
    >
      {model.buttons.map((b) => (
        <button
          key={b.key}
          data-testid={`tool-${b.key}`}
          {...buttonHooks(b)}
          data-active={b.active}
          disabled={!b.enabled}
          onClick={() => props.onSelectTool(b.tool)}
        >
          {b.countLabel === null ? b.label : `${b.label} ${b.countLabel}`}
        </button>
      ))}

      {/* Brush options, present only while the brush is the active tool */}
      {model.brush && (
        <div
          part={OSDLABEL_PARTS.brushOptions}
          className={partClassName(OSDLABEL_PARTS.brushOptions)}
        >
          <label
            htmlFor="brush-radius"
            part={OSDLABEL_PARTS.brushLabel}
            className={partClassName(OSDLABEL_PARTS.brushLabel)}
          >
            Brush
          </label>
          <input
            id="brush-radius"
            data-testid="brush-radius"
            part={OSDLABEL_PARTS.brushRadius}
            className={partClassName(OSDLABEL_PARTS.brushRadius)}
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
          />
          <span
            data-testid="brush-radius-value"
            part={OSDLABEL_PARTS.brushRadiusValue}
            className={partClassName(OSDLABEL_PARTS.brushRadiusValue)}
          >
            {model.brush.radius}px
          </span>
          <button
            data-testid="brush-eraser"
            aria-pressed={model.brush.erasing}
            {...buttonHooks({ active: model.brush.erasing, enabled: true })}
            onClick={() => props.onBrushErasingChange(!model.brush!.erasing)}
          >
            Erase
          </button>
        </div>
      )}

      {/* Contextual action: convert the selected circle to its bounding rectangle */}
      {model.convertToRect && (
        <button
          data-testid="convert-to-rect"
          {...buttonHooks({ active: false, enabled: model.convertToRect.enabled })}
          disabled={!model.convertToRect.enabled}
          onClick={() => props.onConvertToRect()}
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
