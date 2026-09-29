import type { MouseEvent } from 'react';
import { useAnnotator } from '../state/annotator-context.js';
import type { ImageId, ImageSource } from '@osdlabel/viewer-api';
import {
  getCellAssignmentState,
  CELL_ASSIGNMENT_BORDER_COLOR,
  CELL_ASSIGNMENT_PLACEHOLDER_BACKGROUND,
  CELL_ASSIGNMENT_TITLE,
  CELL_ASSIGNMENT_CLEAR_LABEL,
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

  // A thumbnail click only assigns; clearing is the separate badge, so a
  // double-click cannot assign and then wipe the cell's view transform.
  const assign = (image: ImageSource) => {
    actions.assignImageToCell(uiState.activeCellIndex, image.id);
  };

  const clearActiveCell = (event: MouseEvent<HTMLButtonElement>) => {
    // Without this the wrapper's handler also fires and re-assigns the image
    // the badge just removed.
    event.stopPropagation();
    actions.unassignImageFromCell(uiState.activeCellIndex);
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
            onClick={() => assign(image)}
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
            {/* The only control that empties a cell. A real button, so it is
                reachable by keyboard and named for assistive tech — which is
                also the one gesture in this component that loses work. */}
            {state === 'active' && (
              <button
                type="button"
                data-testid={`filmstrip-clear-${image.id}`}
                aria-label={CELL_ASSIGNMENT_CLEAR_LABEL}
                title={CELL_ASSIGNMENT_CLEAR_LABEL}
                onClick={clearActiveCell}
                style={{
                  position: 'absolute',
                  top: '2px',
                  right: '2px',
                  width: '16px',
                  height: '16px',
                  padding: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '50%',
                  border: 'none',
                  background: 'rgba(0, 0, 0, 0.65)',
                  color: '#fff',
                  fontSize: '11px',
                  lineHeight: '1',
                  fontFamily: 'system-ui, sans-serif',
                  cursor: 'pointer',
                }}
              >
                ✕
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
