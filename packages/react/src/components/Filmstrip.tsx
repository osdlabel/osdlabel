import { useAnnotator } from '../state/annotator-context.js';
import type { ImageId, ImageSource } from '@osdlabel/viewer-api';
import { getCellAssignmentState, type AssignmentState } from 'osdlabel';

export interface FilmstripProps {
  readonly images: readonly ImageSource[];
  readonly position: 'left' | 'right' | 'bottom';
}

/** Border colour per assignment state. Bright blue is reserved for the cell the
 * click will act on; the muted blue means "in use, but in another cell". */
const BORDER_COLOR: Record<AssignmentState, string> = {
  active: '#2196F3',
  other: '#1565C0',
  none: '#333',
};

const PLACEHOLDER_BACKGROUND: Record<AssignmentState, string> = {
  active: '#2a3a5e',
  other: '#252d42',
  none: '#2a2a3e',
};

const TITLE: Record<AssignmentState, string> = {
  active: 'Click to remove this image from the active cell',
  other: 'Shown in another cell — click to also show it in the active cell',
  none: 'Click to show this image in the active cell',
};

export default function Filmstrip({ images, position }: FilmstripProps) {
  const { uiState, actions } = useAnnotator();

  const assignmentState = (imageId: ImageId): AssignmentState =>
    getCellAssignmentState(uiState.gridAssignments, uiState.activeCellIndex, imageId);

  // Clicking the image already in the active cell clears that cell; anything
  // else assigns into it. Keyed on the *active* cell, which is why the border
  // has to distinguish "in this cell" from "in some other cell" — a highlight
  // that meant merely "assigned somewhere" would promise a toggle that a click
  // on another cell's image would not deliver.
  const handleClick = (image: ImageSource) => {
    if (assignmentState(image.id) === 'active') {
      actions.unassignImageFromCell(uiState.activeCellIndex);
    } else {
      actions.assignImageToCell(uiState.activeCellIndex, image.id);
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
            title={TITLE[state]}
            onClick={() => handleClick(image)}
            style={{
              [isVertical ? 'width' : 'height']: '100%',
              [isVertical ? 'height' : 'width']: '80px',
              flexShrink: 0,
              border: `2px solid ${BORDER_COLOR[state]}`,
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
                  background: PLACEHOLDER_BACKGROUND[state],
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
