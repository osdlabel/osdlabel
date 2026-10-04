import { For, Show, createMemo } from 'solid-js';
import type { Component } from 'solid-js';
import { useAnnotator } from '../state/annotator-context.js';
import type { ImageId, ImageSource } from '@osdlabel/viewer-api';
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

const Filmstrip: Component<FilmstripProps> = (props) => {
  const { uiState, actions } = useAnnotator();

  const assignmentState = (imageId: ImageId): CellAssignmentState =>
    getCellAssignmentState(uiState, imageId);

  const assign = (image: ImageSource) => {
    actions.assignImageToCell(uiState.activeCellIndex, image.id);
  };

  /**
   * Empties the active cell. When the clear button had keyboard focus, focus
   * moves to the same image's thumbnail first: the button unmounts with the
   * assignment, and focus would otherwise fall to `<body>`, leaving a keyboard
   * user to tab back from the top of the page (#189). A mouse press never
   * focuses the button (`preventButtonFocusSteal`), so it never moves focus.
   */
  const clearActiveCell = (event: MouseEvent, thumbnail: HTMLButtonElement | undefined) => {
    if (document.activeElement === event.currentTarget) thumbnail?.focus();
    actions.unassignImageFromCell(uiState.activeCellIndex);
  };

  const isVertical = () => props.position === 'left' || props.position === 'right';

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
        'flex-direction': isVertical() ? 'column' : 'row',
        'overflow-y': isVertical() ? 'auto' : 'hidden',
        'overflow-x': isVertical() ? 'hidden' : 'auto',
        background: '#1a1a2e',
        padding: '4px',
        gap: '4px',
        [isVertical() ? 'width' : 'height']: '120px',
        'flex-shrink': '0',
      }}
    >
      <For each={[...props.images]}>
        {(image) => {
          const state = createMemo(() => assignmentState(image.id));
          // Read where it is used, so a host that changes an image's label sees
          // it reflected (#205).
          const name = () => image.label ?? image.id;
          let thumbnail: HTMLButtonElement | undefined;

          // The wrapper is a plain container holding two sibling buttons, so
          // no control is nested inside another. It keeps the test id,
          // `data-assignment` and the state border.
          return (
            <div
              role="listitem"
              data-testid={`filmstrip-item-${image.id}`}
              data-assignment={state()}
              style={{
                [isVertical() ? 'width' : 'height']: '100%',
                [isVertical() ? 'height' : 'width']: '80px',
                'flex-shrink': '0',
                border: `2px solid ${CELL_ASSIGNMENT_BORDER_COLOR[state()]}`,
                'border-radius': '4px',
                position: 'relative',
                'box-sizing': 'border-box',
              }}
            >
              {/* Assigns this image to the active cell. A real button, so it is
                  focusable and operable with Enter or Space, and its name
                  carries the state the border shows. It never clears, so a
                  double-click cannot assign and then wipe the cell. */}
              <button
                type="button"
                ref={thumbnail}
                data-testid={`filmstrip-thumb-${image.id}`}
                aria-label={getCellAssignmentLabel(name(), state())}
                aria-current={state() === 'active' ? 'true' : undefined}
                title={CELL_ASSIGNMENT_TITLE[state()]}
                onClick={() => assign(image)}
                style={{
                  display: 'block',
                  width: '100%',
                  height: '100%',
                  padding: '0',
                  border: 'none',
                  'border-radius': '2px',
                  overflow: 'hidden',
                  background: 'transparent',
                  cursor: 'pointer',
                }}
              >
                {image.thumbnailUrl ? (
                  <img
                    src={image.thumbnailUrl}
                    alt=""
                    style={{
                      display: 'block',
                      width: '100%',
                      height: '100%',
                      'object-fit': 'cover',
                    }}
                  />
                ) : (
                  // A span, not a div: a <button> may only hold phrasing
                  // content (#205). Flex makes it a block-level box anyway.
                  <span
                    aria-hidden="true"
                    style={{
                      width: '100%',
                      height: '100%',
                      display: 'flex',
                      'align-items': 'center',
                      'justify-content': 'center',
                      background: CELL_ASSIGNMENT_PLACEHOLDER_BACKGROUND[state()],
                      color: '#aaa',
                      'font-size': '10px',
                      'font-family': 'system-ui, sans-serif',
                      'text-align': 'center',
                      padding: '4px',
                      'box-sizing': 'border-box',
                    }}
                  >
                    {name()}
                  </span>
                )}
              </button>
              {/* The only control that empties a cell. A real button, so it is
                  reachable by keyboard and named for assistive tech — which is
                  also the one gesture in this component that loses work. The
                  button is a 24px target (WCAG 2.5.8) around the 16px badge
                  that is drawn (#205). The corner it covers belongs to the
                  thumbnail already in the active cell, where a press would
                  only re-assign the image the cell already shows, which
                  changes nothing (#212). Square, not rounded: browsers
                  hit-test the rounded shape (CSS Backgrounds 3), which would
                  shrink the target to a 24px circle. */}
              <Show when={state() === 'active'}>
                <button
                  type="button"
                  data-testid={`filmstrip-clear-${image.id}`}
                  aria-label={CELL_ASSIGNMENT_CLEAR_LABEL}
                  title={CELL_ASSIGNMENT_CLEAR_LABEL}
                  onClick={(event) => clearActiveCell(event, thumbnail)}
                  style={{
                    position: 'absolute',
                    top: '0',
                    right: '0',
                    width: '24px',
                    height: '24px',
                    padding: '0',
                    display: 'flex',
                    'align-items': 'center',
                    'justify-content': 'center',
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
                      'align-items': 'center',
                      'justify-content': 'center',
                      'border-radius': '50%',
                      background: 'rgba(0, 0, 0, 0.65)',
                      color: '#fff',
                      'font-size': '11px',
                      'line-height': '1',
                      'font-family': 'system-ui, sans-serif',
                    }}
                  >
                    ✕
                  </span>
                </button>
              </Show>
            </div>
          );
        }}
      </For>
    </div>
  );
};

export default Filmstrip;
