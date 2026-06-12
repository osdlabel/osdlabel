import { useAnnotator } from '../state/annotator-context.js';
import type { ToolType } from '@osdlabel/annotation';

const TOOL_LABELS: Record<ToolType, string> = {
  rectangle: 'Rect',
  circle: 'Circle',
  line: 'Line',
  point: 'Point',
  polyline: 'Polyline',
  freeHandPath: 'Free Draw',
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
