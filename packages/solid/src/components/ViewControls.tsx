import { type Component, Show } from 'solid-js';
import { useAnnotator } from '../state/annotator-context.js';
import { DEFAULT_CELL_TRANSFORM } from '@osdlabel/viewer-api';

export const ViewControls: Component = () => {
  const { uiState, actions, activeImageId } = useAnnotator();

  const cellTransform = () => {
    return uiState.cellTransforms[uiState.activeCellIndex] ?? DEFAULT_CELL_TRANSFORM;
  };

  const isActive = () => !!activeImageId();

  return (
    <div
      style={{
        display: 'flex',
        'align-items': 'center',
        gap: '4px',
        padding: '8px',
        'background-color': '#1e1e1e',
        'border-radius': '4px',
        'margin-left': '8px',
      }}
    >
      <button
        type="button"
        title="Rotate CCW (Shift+L)"
        data-testid="view-rotate-ccw"
        disabled={!isActive()}
        onClick={() => actions.rotateActiveImageCCW()}
        style={{
          width: '32px',
          height: '32px',
          'background-color': '#333',
          border: 'none',
          'border-radius': '4px',
          color: 'white',
          cursor: isActive() ? 'pointer' : 'default',
          opacity: isActive() ? '1' : '0.5',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'center',
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
        </svg>
      </button>

      <button
        type="button"
        title="Rotate CW (Shift+R)"
        data-testid="view-rotate-cw"
        disabled={!isActive()}
        onClick={() => actions.rotateActiveImageCW()}
        style={{
          width: '32px',
          height: '32px',
          'background-color': '#333',
          border: 'none',
          'border-radius': '4px',
          color: 'white',
          cursor: isActive() ? 'pointer' : 'default',
          opacity: isActive() ? '1' : '0.5',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'center',
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
        </svg>
      </button>

      <div style={{ width: '1px', height: '24px', 'background-color': '#555', margin: '0 4px' }} />

      <button
        type="button"
        title="Flip Horizontal (Shift+H)"
        data-testid="view-flip-h"
        disabled={!isActive()}
        onClick={() => actions.flipActiveImageH()}
        style={{
          width: '32px',
          height: '32px',
          'background-color': cellTransform().flippedH ? '#2196F3' : '#333',
          border: 'none',
          'border-radius': '4px',
          color: 'white',
          cursor: isActive() ? 'pointer' : 'default',
          opacity: isActive() ? '1' : '0.5',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'center',
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M12 2v20" />
          <path d="m3 7 5 5-5 5V7z" />
          <path d="m21 7-5 5 5 5V7z" />
        </svg>
      </button>

      <button
        type="button"
        title="Flip Vertical (Shift+V)"
        data-testid="view-flip-v"
        disabled={!isActive()}
        onClick={() => actions.flipActiveImageV()}
        style={{
          width: '32px',
          height: '32px',
          'background-color': cellTransform().flippedV ? '#2196F3' : '#333',
          border: 'none',
          'border-radius': '4px',
          color: 'white',
          cursor: isActive() ? 'pointer' : 'default',
          opacity: isActive() ? '1' : '0.5',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'center',
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M2 12h20" />
          <path d="m7 3 5 5 5-5H7z" />
          <path d="m7 21 5-5 5 5H7z" />
        </svg>
      </button>

      <div style={{ width: '1px', height: '24px', 'background-color': '#555', margin: '0 4px' }} />

      <button
        type="button"
        title="Toggle Negative (Shift+N)"
        aria-label="Toggle Negative"
        aria-pressed={cellTransform().inverted}
        data-testid="view-negative"
        disabled={!isActive()}
        onClick={() => actions.toggleActiveImageNegative()}
        style={{
          width: '32px',
          height: '32px',
          'background-color': cellTransform().inverted ? '#2196F3' : '#333',
          border: 'none',
          'border-radius': '4px',
          color: 'white',
          cursor: isActive() ? 'pointer' : 'default',
          opacity: isActive() ? '1' : '0.5',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'center',
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 2a10 10 0 0 0 0 20z" fill="currentColor" />
        </svg>
      </button>

      <button
        type="button"
        title="Decrease Exposure (Shift+D)"
        aria-label="Decrease Exposure"
        data-testid="view-exposure-decrease"
        disabled={!isActive()}
        onClick={() => actions.decreaseActiveImageExposure()}
        style={{
          width: '32px',
          height: '32px',
          'background-color': '#333',
          border: 'none',
          'border-radius': '4px',
          color: 'white',
          cursor: isActive() ? 'pointer' : 'default',
          opacity: isActive() ? '1' : '0.5',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'center',
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2" />
          <path d="M12 20v2" />
          <path d="m4.93 4.93 1.41 1.41" />
          <path d="m17.66 17.66 1.41 1.41" />
          <path d="M2 12h2" />
          <path d="M20 12h2" />
          <path d="m6.34 17.66-1.41 1.41" />
          <path d="m19.07 4.93-1.41 1.41" />
        </svg>
      </button>

      <div
        aria-live="polite"
        style={{
          'min-width': '28px',
          'text-align': 'center',
          color: 'white',
          'font-size': '12px',
          opacity: isActive() ? '1' : '0.5',
        }}
      >
        {cellTransform().exposure > 0
          ? `+${cellTransform().exposure.toFixed(1)}`
          : cellTransform().exposure.toFixed(1)}
      </div>

      <button
        type="button"
        title="Increase Exposure (Shift+E)"
        aria-label="Increase Exposure"
        data-testid="view-exposure-increase"
        disabled={!isActive()}
        onClick={() => actions.increaseActiveImageExposure()}
        style={{
          width: '32px',
          height: '32px',
          'background-color': '#333',
          border: 'none',
          'border-radius': '4px',
          color: 'white',
          cursor: isActive() ? 'pointer' : 'default',
          opacity: isActive() ? '1' : '0.5',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'center',
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2" />
          <path d="M12 20v2" />
          <path d="m4.93 4.93 1.41 1.41" />
          <path d="m17.66 17.66 1.41 1.41" />
          <path d="M2 12h2" />
          <path d="M20 12h2" />
          <path d="m6.34 17.66-1.41 1.41" />
          <path d="m19.07 4.93-1.41 1.41" />
        </svg>
      </button>

      <button
        type="button"
        title="Drag to adjust exposure"
        aria-label="Drag to adjust exposure"
        aria-pressed={uiState.activeViewerControl === 'exposure'}
        data-testid="view-exposure-drag"
        disabled={!isActive()}
        onClick={() =>
          actions.setActiveViewerControl(
            uiState.activeViewerControl === 'exposure' ? null : 'exposure',
          )
        }
        style={{
          width: '32px',
          height: '32px',
          'background-color': uiState.activeViewerControl === 'exposure' ? '#2196F3' : '#333',
          border: 'none',
          'border-radius': '4px',
          color: 'white',
          cursor: isActive() ? 'pointer' : 'default',
          opacity: isActive() ? '1' : '0.5',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'center',
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M3 12h4" />
          <path d="M17 12h4" />
          <path d="m7 9-3 3 3 3" />
          <path d="m17 9 3 3-3 3" />
        </svg>
      </button>

      <Show
        when={
          cellTransform().rotation !== 0 ||
          cellTransform().flippedH ||
          cellTransform().flippedV ||
          cellTransform().exposure !== 0 ||
          cellTransform().inverted
        }
      >
        <div
          style={{ width: '1px', height: '24px', 'background-color': '#555', margin: '0 4px' }}
        />
        <button
          type="button"
          title="Reset View (Shift+0)"
          data-testid="view-reset"
          onClick={() => actions.resetActiveImageView()}
          style={{
            padding: '0 8px',
            height: '32px',
            'background-color': '#d32f2f',
            border: 'none',
            'border-radius': '4px',
            color: 'white',
            cursor: 'pointer',
            'font-size': '12px',
            'font-weight': 'bold',
          }}
        >
          Reset
        </button>
      </Show>
    </div>
  );
};
