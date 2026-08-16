import { type Component, Show } from 'solid-js';
import { useAnnotator } from '../state/annotator-context.js';
import { DEFAULT_CELL_TRANSFORM } from '@osdlabel/viewer-api';
import { resolveFullscreenTarget } from 'osdlabel';
import { useFullscreen } from '../hooks/useFullscreen.js';

export interface ViewControlsProps {
  /** Whether to show the fullscreen toggle (default: true) */
  readonly showFullscreenControl?: boolean | undefined;
}

export const ViewControls: Component<ViewControlsProps> = (props) => {
  const { uiState, actions, activeImageId, fullscreenTargetRef, fullscreenTarget } = useAnnotator();
  const fullscreen = useFullscreen();

  const cellTransform = () => {
    return uiState.cellTransforms[uiState.activeCellIndex] ?? DEFAULT_CELL_TRANSFORM;
  };

  const isActive = () => !!activeImageId();

  const showFullscreen = () => props.showFullscreenControl !== false && fullscreen.isSupported();

  const handleFullscreen = (event: MouseEvent & { currentTarget: HTMLButtonElement }): void => {
    // Resolved from the button itself, so a hand-composed layout only needs
    // the [data-osdlabel-fullscreen-root] attribute on its own wrapper.
    const target = resolveFullscreenTarget({
      explicit: fullscreenTarget,
      registered: fullscreenTargetRef.element,
      from: event.currentTarget,
    });
    if (target) void fullscreen.toggle(target);
  };

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

      <div style={{ width: '1px', height: '24px', 'background-color': '#555', margin: '0 4px' }} />

      <button
        type="button"
        title="Decrease Contrast (Shift+X)"
        aria-label="Decrease Contrast"
        data-testid="view-contrast-decrease"
        disabled={!isActive()}
        onClick={() => actions.decreaseActiveImageContrast()}
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
          <circle cx="12" cy="12" r="9" />
          <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" />
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
        {cellTransform().contrast > 0
          ? `+${cellTransform().contrast.toFixed(1)}`
          : cellTransform().contrast.toFixed(1)}
      </div>

      <button
        type="button"
        title="Increase Contrast (Shift+C)"
        aria-label="Increase Contrast"
        data-testid="view-contrast-increase"
        disabled={!isActive()}
        onClick={() => actions.increaseActiveImageContrast()}
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
          <circle cx="12" cy="12" r="9" />
          <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" />
          <path d="M12 7v10" />
        </svg>
      </button>

      <div style={{ width: '1px', height: '24px', 'background-color': '#555', margin: '0 4px' }} />

      <button
        type="button"
        title="Drag to adjust tone — horizontal: exposure (left = brighter), vertical: contrast (up = more)"
        aria-label="Drag to adjust exposure and contrast"
        aria-pressed={uiState.activeViewerControl === 'tone'}
        data-testid="view-tone-drag"
        disabled={!isActive()}
        onClick={() =>
          actions.setActiveViewerControl(uiState.activeViewerControl === 'tone' ? null : 'tone')
        }
        style={{
          width: '32px',
          height: '32px',
          'background-color': uiState.activeViewerControl === 'tone' ? '#2196F3' : '#333',
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
          <circle cx="12" cy="12" r="3.5" />
          <path d="M12 8.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" />
          <path d="m5 9-3 3 3 3" />
          <path d="m19 9 3 3-3 3" />
          <path d="m9 5 3-3 3 3" />
          <path d="m9 19 3 3 3-3" />
        </svg>
      </button>

      <Show when={showFullscreen()}>
        <div
          style={{ width: '1px', height: '24px', 'background-color': '#555', margin: '0 4px' }}
        />
        <button
          type="button"
          title={fullscreen.isFullscreen() ? 'Exit Fullscreen' : 'Fullscreen'}
          aria-label={fullscreen.isFullscreen() ? 'Exit fullscreen' : 'Enter fullscreen'}
          aria-pressed={fullscreen.isFullscreen()}
          data-testid="view-fullscreen"
          onClick={handleFullscreen}
          style={{
            width: '32px',
            height: '32px',
            'background-color': fullscreen.isFullscreen() ? '#2196F3' : '#333',
            border: 'none',
            'border-radius': '4px',
            color: 'white',
            // Deliberately not gated on isActive(): fullscreen is viewer
            // chrome, not an image transform, so it works on an empty grid.
            cursor: 'pointer',
            opacity: '1',
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
          }}
        >
          <Show
            when={fullscreen.isFullscreen()}
            fallback={
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
                <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
                <path d="M3 16v3a2 2 0 0 0 2 2h3" />
                <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
              </svg>
            }
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
              <path d="M8 3v3a2 2 0 0 1-2 2H3" />
              <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
              <path d="M3 16h3a2 2 0 0 1 2 2v3" />
              <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
            </svg>
          </Show>
        </button>
      </Show>

      <Show
        when={
          cellTransform().rotation !== 0 ||
          cellTransform().flippedH ||
          cellTransform().flippedV ||
          cellTransform().exposure !== 0 ||
          cellTransform().contrast !== 0 ||
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
