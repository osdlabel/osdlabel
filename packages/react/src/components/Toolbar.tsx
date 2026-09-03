import { useAnnotator } from '../state/annotator-context.js';
import type { ToolType } from '@osdlabel/annotation';
import { MAX_BRUSH_RADIUS, MIN_BRUSH_RADIUS } from '@osdlabel/viewer-api';
import { preventButtonFocusSteal } from 'osdlabel';

const TOOL_LABELS: Record<ToolType, string> = {
  rectangle: 'Rect',
  circle: 'Circle',
  line: 'Line',
  point: 'Point',
  polyline: 'Polyline',
  freeHandPath: 'Free Draw',
  segmentationBrush: 'Brush',
};

export default function Toolbar() {
  const { uiState, contextState, annotationState, constraintStatus, actions } = useAnnotator();

  const activeContext = (() => {
    if (!contextState.activeContextId) return undefined;
    return contextState.contexts.find((c) => c.id === contextState.activeContextId);
  })();

  const allowedTools: ToolType[] = activeContext ? activeContext.tools.map((t) => t.type) : [];

  // The currently selected annotation, looked up across the active image's
  // annotations. Drives the contextual "Convert to Rect" action.
  const selectedAnnotation = (() => {
    const id = uiState.selectedAnnotationId;
    if (!id) return undefined;
    const imageId = uiState.gridAssignments[uiState.activeCellIndex];
    if (!imageId) return undefined;
    return annotationState.byImage[imageId]?.[id];
  })();
  const showConvertToRect = selectedAnnotation?.geometry.type === 'circle';
  const canConvertToRect = showConvertToRect && constraintStatus.rectangle.enabled;

  return (
    <div
      onMouseDown={preventButtonFocusSteal}
      style={{
        display: 'flex',
        gap: '4px',
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      <button
        data-testid="tool-navigate"
        onClick={() => actions.setActiveTool(null)}
        style={{
          padding: '4px 10px',
          border: 'none',
          borderRadius: '4px',
          cursor: 'pointer',
          background: uiState.activeTool === null ? '#2196F3' : '#333',
          color: '#fff',
          fontWeight: uiState.activeTool === null ? 'bold' : 'normal',
          fontSize: '13px',
        }}
      >
        Navigate
      </button>

      <button
        data-testid="tool-select"
        onClick={() => actions.setActiveTool('select')}
        style={{
          padding: '4px 10px',
          border: 'none',
          borderRadius: '4px',
          cursor: 'pointer',
          background: uiState.activeTool === 'select' ? '#2196F3' : '#333',
          color: '#fff',
          fontWeight: uiState.activeTool === 'select' ? 'bold' : 'normal',
          fontSize: '13px',
        }}
      >
        Select
      </button>

      {allowedTools.map((toolType) => {
        const status = constraintStatus[toolType];
        const isActiveTool = uiState.activeTool === toolType;
        const enabled = status.enabled;
        const countLabel =
          status.maxCount === null
            ? `${status.currentCount}`
            : `${status.currentCount}/${status.maxCount}`;

        return (
          <button
            key={toolType}
            data-testid={`tool-${toolType}`}
            disabled={!enabled}
            onClick={() => {
              if (enabled) {
                actions.setActiveTool(toolType);
              }
            }}
            style={{
              padding: '4px 10px',
              border: 'none',
              borderRadius: '4px',
              cursor: enabled ? 'pointer' : 'not-allowed',
              background: isActiveTool ? '#2196F3' : enabled ? '#333' : '#1a1a1a',
              color: enabled ? '#fff' : '#666',
              fontWeight: isActiveTool ? 'bold' : 'normal',
              fontSize: '13px',
              opacity: enabled ? 1 : 0.5,
            }}
          >
            {TOOL_LABELS[toolType]} {countLabel}
          </button>
        );
      })}

      {/* Brush options, shown only while the brush is the active tool */}
      {uiState.activeTool === 'segmentationBrush' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <label
            htmlFor="brush-radius"
            style={{ color: '#bbb', fontSize: '12px', whiteSpace: 'nowrap' }}
          >
            Brush
          </label>
          <input
            id="brush-radius"
            data-testid="brush-radius"
            type="range"
            min={MIN_BRUSH_RADIUS}
            max={MAX_BRUSH_RADIUS}
            value={uiState.brushRadius}
            onChange={(e) => actions.setBrushRadius(Number(e.currentTarget.value))}
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
            style={{ color: '#fff', fontSize: '12px', minWidth: '34px' }}
          >
            {uiState.brushRadius}px
          </span>
          <button
            data-testid="brush-eraser"
            aria-pressed={uiState.brushErasing}
            onClick={() => actions.setBrushErasing(!uiState.brushErasing)}
            style={{
              padding: '4px 10px',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              background: uiState.brushErasing ? '#2196F3' : '#333',
              color: '#fff',
              fontWeight: uiState.brushErasing ? 'bold' : 'normal',
              fontSize: '13px',
            }}
          >
            Erase
          </button>
        </div>
      )}

      {/* Contextual action: convert the selected circle to its bounding rectangle */}
      {showConvertToRect && (
        <button
          data-testid="convert-to-rect"
          disabled={!canConvertToRect}
          onClick={() => {
            if (selectedAnnotation && canConvertToRect) {
              actions.convertAnnotation(selectedAnnotation.id, selectedAnnotation.imageId);
            }
          }}
          style={{
            padding: '4px 10px',
            border: 'none',
            borderRadius: '4px',
            cursor: canConvertToRect ? 'pointer' : 'not-allowed',
            background: canConvertToRect ? '#333' : '#1a1a1a',
            color: canConvertToRect ? '#fff' : '#666',
            fontSize: '13px',
            opacity: canConvertToRect ? 1 : 0.5,
          }}
        >
          Convert to Rect
        </button>
      )}
    </div>
  );
}
