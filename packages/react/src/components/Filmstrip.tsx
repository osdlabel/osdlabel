import { useRef, type MouseEvent } from 'react';
import { useAnnotator } from '../state/annotator-context.js';
import type { ImageSource } from '@osdlabel/viewer-api';
import {
  getCellAssignmentState,
  getCellAssignmentLabel,
  preventButtonFocusSteal,
  CELL_ASSIGNMENT_BORDER_COLOR,
  CELL_ASSIGNMENT_PLACEHOLDER_BACKGROUND,
  CELL_ASSIGNMENT_TITLE,
  CELL_ASSIGNMENT_CLEAR_LABEL,
  FILMSTRIP_LABEL,
  type CellAssignmentState,
} from 'osdlabel';

export interface FilmstripProps {
  readonly images: readonly ImageSource[];
  readonly position: 'left' | 'right' | 'bottom';
}

export default function Filmstrip({ images, position }: FilmstripProps) {
  const { uiState, actions } = useAnnotator();

  const isVertical = position === 'left' || position === 'right';

  return (
    <div
      data-testid="filmstrip"
      // A list of images, so assistive tech announces the filmstrip and how
      // many images it holds rather than a flat run of buttons (#205).
      role="list"
      aria-label={FILMSTRIP_LABEL}
      // A click on a thumbnail or the clear badge must not leave focus on it,
      // like the toolbar: Enter and Space would re-press it, and Enter is also
      // the polyline-finish key. Tab still reaches both buttons.
      onMouseDown={preventButtonFocusSteal}
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
      {[...images].map((image) => (
        <FilmstripItem
          key={image.id}
          image={image}
          state={getCellAssignmentState(uiState, image.id)}
          isVertical={isVertical}
          onAssign={() => actions.assignImageToCell(uiState.activeCellIndex, image.id)}
          onClear={() => actions.unassignImageFromCell(uiState.activeCellIndex)}
        />
      ))}
    </div>
  );
}

interface FilmstripItemProps {
  readonly image: ImageSource;
  readonly state: CellAssignmentState;
  readonly isVertical: boolean;
  readonly onAssign: () => void;
  readonly onClear: () => void;
}

/**
 * One thumbnail. The wrapper is a plain container holding two sibling buttons,
 * so no control is nested inside another; it keeps the test id,
 * `data-assignment` and the state border.
 */
function FilmstripItem({ image, state, isVertical, onAssign, onClear }: FilmstripItemProps) {
  const thumbnailRef = useRef<HTMLButtonElement>(null);
  const name = image.label ?? image.id;

  /**
   * When the clear button had keyboard focus, focus moves to this image's
   * thumbnail first: the button unmounts with the assignment, and focus would
   * otherwise fall to `<body>`, leaving a keyboard user to tab back from the
   * top of the page (#189). A mouse press never focuses the button
   * (`preventButtonFocusSteal`), so it never moves focus.
   */
  const clear = (event: MouseEvent<HTMLButtonElement>) => {
    if (document.activeElement === event.currentTarget) thumbnailRef.current?.focus();
    onClear();
  };

  return (
    <div
      role="listitem"
      data-testid={`filmstrip-item-${image.id}`}
      data-assignment={state}
      style={{
        [isVertical ? 'width' : 'height']: '100%',
        [isVertical ? 'height' : 'width']: '80px',
        flexShrink: 0,
        border: `2px solid ${CELL_ASSIGNMENT_BORDER_COLOR[state]}`,
        borderRadius: '4px',
        position: 'relative',
        boxSizing: 'border-box',
      }}
    >
      {/* Assigns this image to the active cell. A real button, so it is
          focusable and operable with Enter or Space, and its name carries the
          state the border shows. It never clears, so a double-click cannot
          assign and then wipe the cell. */}
      <button
        type="button"
        ref={thumbnailRef}
        data-testid={`filmstrip-thumb-${image.id}`}
        aria-label={getCellAssignmentLabel(name, state)}
        aria-current={state === 'active' ? 'true' : undefined}
        title={CELL_ASSIGNMENT_TITLE[state]}
        onClick={onAssign}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          padding: 0,
          border: 'none',
          borderRadius: '2px',
          overflow: 'hidden',
          background: 'transparent',
          cursor: 'pointer',
        }}
      >
        {image.thumbnailUrl ? (
          <img
            src={image.thumbnailUrl}
            alt=""
            style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          // A span, not a div: a <button> may only hold phrasing content
          // (#205). Flex makes it a block-level box anyway.
          <span
            aria-hidden="true"
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
            {name}
          </span>
        )}
      </button>
      {/* The only control that empties a cell. A real button, so it is
          reachable by keyboard and named for assistive tech — which is also
          the one gesture in this component that loses work. The button is a
          24px target (WCAG 2.5.8) around the 16px badge that is drawn (#205).
          The corner it covers belongs to the thumbnail already in the active
          cell, where a press would re-assign the same image and reset the
          cell's view transform. */}
      {state === 'active' && (
        <button
          type="button"
          data-testid={`filmstrip-clear-${image.id}`}
          aria-label={CELL_ASSIGNMENT_CLEAR_LABEL}
          title={CELL_ASSIGNMENT_CLEAR_LABEL}
          onClick={clear}
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            width: '24px',
            height: '24px',
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
          }}
        >
          <span
            aria-hidden="true"
            style={{
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
            }}
          >
            ✕
          </span>
        </button>
      )}
    </div>
  );
}
