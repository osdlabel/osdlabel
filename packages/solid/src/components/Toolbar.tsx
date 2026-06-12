import { Show, type Component } from 'solid-js';
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

const Toolbar: Component = () => {
  const { uiState, contextState, annotationState, constraintStatus, actions } = useAnnotator();

  const activeContext = () => {
    if (!contextState.activeContextId) return undefined;
    return contextState.contexts.find((c) => c.id === contextState.activeContextId);
  };

  // The currently selected annotation, looked up across the active image's
  // annotations. Drives the contextual "Convert to Rect" action.
  const selectedAnnotation = () => {
    const id = uiState.selectedAnnotationId;
    if (!id) return undefined;
    const imageId = uiState.gridAssignments[uiState.activeCellIndex];
    if (!imageId) return undefined;
    return annotationState.byImage[imageId]?.[id];
  };

  const canConvertSelectedToRect = () =>
    selectedAnnotation()?.geometry.type === 'circle' && constraintStatus().rectangle.enabled;

  const allowedTools = (): ToolType[] => {
    const ctx = activeContext();
    if (!ctx) return [];
    return ctx.tools.map((t) => t.type);
  };

  return (
    <div
      style={{
        display: 'flex',
        gap: '4px',
        'align-items': 'center',
        'flex-wrap': 'wrap',
      }}
    >
      {/* Navigation mode button */}
      <button
        data-testid="tool-navigate"
        onClick={() => actions.setActiveTool(null)}
        style={{
          padding: '4px 10px',
          border: 'none',
          'border-radius': '4px',
          cursor: 'pointer',
          background: uiState.activeTool === null ? '#2196F3' : '#333',
          color: '#fff',
          'font-weight': uiState.activeTool === null ? 'bold' : 'normal',
          'font-size': '13px',
        }}
      >
        Navigate
      </button>

      {/* Select tool button (always present) */}
      <button
        data-testid="tool-select"
        onClick={() => actions.setActiveTool('select')}
        style={{
          padding: '4px 10px',
          border: 'none',
          'border-radius': '4px',
          cursor: 'pointer',
          background: uiState.activeTool === 'select' ? '#2196F3' : '#333',
          color: '#fff',
          'font-weight': uiState.activeTool === 'select' ? 'bold' : 'normal',
          'font-size': '13px',
        }}
      >
        Select
      </button>

      {/* Drawing tool buttons — one per allowed tool in active context */}
      {allowedTools().map((toolType) => {
        const status = () => constraintStatus()[toolType];
        const isActive = () => uiState.activeTool === toolType;
        const enabled = () => status().enabled;
        const countLabel = () => {
          const s = status();
          if (s.maxCount === null) return `${s.currentCount}`;
          return `${s.currentCount}/${s.maxCount}`;
        };

        return (
          <button
            data-testid={`tool-${toolType}`}
            disabled={!enabled()}
            onClick={() => {
              if (enabled()) {
                actions.setActiveTool(toolType);
              }
            }}
            style={{
              padding: '4px 10px',
              border: 'none',
              'border-radius': '4px',
              cursor: enabled() ? 'pointer' : 'not-allowed',
              background: isActive() ? '#2196F3' : enabled() ? '#333' : '#1a1a1a',
              color: enabled() ? '#fff' : '#666',
              'font-weight': isActive() ? 'bold' : 'normal',
              'font-size': '13px',
              opacity: enabled() ? '1' : '0.5',
            }}
          >
            {TOOL_LABELS[toolType]} {countLabel()}
          </button>
        );
      })}

      {/* Contextual action: convert the selected circle to its bounding rectangle */}
      <Show when={selectedAnnotation()?.geometry.type === 'circle'}>
        {(() => {
          const enabled = () => canConvertSelectedToRect();
          return (
            <button
              data-testid="convert-to-rect"
              disabled={!enabled()}
              onClick={() => {
                const ann = selectedAnnotation();
                if (!ann || !enabled()) return;
                actions.convertAnnotation(ann.id, ann.imageId);
              }}
              style={{
                padding: '4px 10px',
                border: 'none',
                'border-radius': '4px',
                cursor: enabled() ? 'pointer' : 'not-allowed',
                background: enabled() ? '#333' : '#1a1a1a',
                color: enabled() ? '#fff' : '#666',
                'font-size': '13px',
                opacity: enabled() ? '1' : '0.5',
              }}
            >
              Convert to Rect
            </button>
          );
        })()}
      </Show>
    </div>
  );
};

export default Toolbar;
