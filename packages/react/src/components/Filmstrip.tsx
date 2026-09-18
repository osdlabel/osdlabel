import { useAnnotator } from '../state/annotator-context.js';
import type { ImageId, ImageSource } from '@osdlabel/viewer-api';
import {
  getCellAssignmentState,
  resolveFilmstripClick,
  CELL_ASSIGNMENT_BORDER_COLOR,
  CELL_ASSIGNMENT_PLACEHOLDER_BACKGROUND,
  CELL_ASSIGNMENT_TITLE,
  type CellAssignmentState,
} from 'osdlabel';

export interface FilmstripProps {
  readonly images: readonly ImageSource[];
  readonly position: 'left' | 'right' | 'bottom';
}

export default function Filmstrip({ images, position }: FilmstripProps) {
  const { uiState, actions } = useAnnotator();

  const assignmentState = (imageId: ImageId): CellAssignmentState =>
    getCellAssignmentState(uiState, imageId);

  // Clicking the image already in the active cell clears that cell; anything
  // else assigns into it. The decision lives in `resolveFilmstripClick` so both
  // frameworks share one tested rule — in particular one that always names the
  // active cell, which is easy to get silently wrong here.
  const handleClick = (image: ImageSource) => {
    const action = resolveFilmstripClick(uiState, image.id);
    switch (action.type) {
      case 'unassign':
        actions.unassignImageFromCell(action.cellIndex);
        break;
      case 'assign':
        actions.assignImageToCell(action.cellIndex, action.imageId);
        break;
      default: {
        // Adding a variant without handling it here is a compile error, the
        // same guarantee the palettes get from being keyed on the state union.
        const exhaustive: never = action;
        void exhaustive;
      }
    }
  };

  const isVertical = position === 'left' || position === 'right';

  return (
    <div
      data-testid="filmstrip"
      style={{
        display: 'flex',
        flexDirection: isVertical ? 'column' : 'row',
        overflowY: isVertical ? 'auto' : 'hidden',
        overflowX: isVertical ? 'hidden' : 'auto',
        background: '#1a1a2e',
        padding: '4px',
        gap: '4px',
        [isVertical ? 'width' : 'height']: '120px',
        flexShrink: 0,
      }}
    >
      {[...images].map((image) => {
        const state = assignmentState(image.id);

        return (
          <div
            key={image.id}
            data-testid={`filmstrip-item-${image.id}`}
            data-assignment={state}
            title={CELL_ASSIGNMENT_TITLE[state]}
            onClick={() => handleClick(image)}
            style={{
              [isVertical ? 'width' : 'height']: '100%',
              [isVertical ? 'height' : 'width']: '80px',
              flexShrink: 0,
              border: `2px solid ${CELL_ASSIGNMENT_BORDER_COLOR[state]}`,
              borderRadius: '4px',
              overflow: 'hidden',
              cursor: 'pointer',
              position: 'relative',
              boxSizing: 'border-box',
            }}
          >
            {image.thumbnailUrl ? (
              <img
                src={image.thumbnailUrl}
                alt={image.label ?? image.id}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                }}
              />
            ) : (
              <div
                style={{
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: CELL_ASSIGNMENT_PLACEHOLDER_BACKGROUND[state],
                  color: '#aaa',
                  fontSize: '10px',
                  fontFamily: 'system-ui, sans-serif',
                  textAlign: 'center',
                  padding: '4px',
                  boxSizing: 'border-box',
                }}
              >
                {image.label ?? image.id}
              </div>
            )}
            {/* Signals that clicking this thumbnail clears the active cell.
                Purely indicative — the click is handled by the wrapper, so
                the badge must not swallow it. */}
            {state === 'active' && (
              <div
                data-testid={`filmstrip-clear-${image.id}`}
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  top: '2px',
                  right: '2px',
                  width: '16px',
                  height: '16px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '50%',
                  background: 'rgba(0, 0, 0, 0.65)',
                  color: '#fff',
                  fontSize: '11px',
                  lineHeight: '1',
                  fontFamily: 'system-ui, sans-serif',
                  pointerEvents: 'none',
                }}
              >
                ✕
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
