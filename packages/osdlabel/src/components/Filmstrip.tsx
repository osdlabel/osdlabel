import { For } from 'solid-js';
import type { Component } from 'solid-js';
import { useAnnotator } from '../state/annotator-context.js';
import type { ImageSource } from '@osdlabel/viewer-api';

export interface FilmstripProps {
  readonly images: readonly ImageSource[];
  readonly position: 'left' | 'right' | 'bottom';
}

const Filmstrip: Component<FilmstripProps> = (props) => {
  const { uiState, actions } = useAnnotator();

  const isAssigned = (imageId: string): boolean => {
    return Object.values(uiState.gridAssignments).some((id) => id === imageId);
  };

  const handleClick = (image: ImageSource) => {
    actions.assignImageToCell(uiState.activeCellIndex, image.id);
  };

  const isVertical = () => props.position === 'left' || props.position === 'right';

  return (
    <div
      data-testid="filmstrip"
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
          const assigned = () => isAssigned(image.id);

          return (
            <div
              data-testid={`filmstrip-item-${image.id}`}
              onClick={() => handleClick(image)}
              style={{
                [isVertical() ? 'width' : 'height']: '100%',
                [isVertical() ? 'height' : 'width']: '80px',
                'flex-shrink': '0',
                border: assigned() ? '2px solid #2196F3' : '2px solid #333',
                'border-radius': '4px',
                overflow: 'hidden',
                cursor: 'pointer',
                position: 'relative',
                'box-sizing': 'border-box',
              }}
            >
              {image.thumbnailUrl ? (
                <img
                  src={image.thumbnailUrl}
                  alt={image.label ?? image.id}
                  style={{
                    width: '100%',
                    height: '100%',
                    'object-fit': 'cover',
                  }}
                />
              ) : (
                <div
                  style={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    'align-items': 'center',
                    'justify-content': 'center',
                    background: assigned() ? '#2a3a5e' : '#2a2a3e',
                    color: '#aaa',
                    'font-size': '10px',
                    'font-family': 'system-ui, sans-serif',
                    'text-align': 'center',
                    padding: '4px',
                    'box-sizing': 'border-box',
                  }}
                >
                  {image.label ?? image.id}
                </div>
              )}
            </div>
          );
        }}
      </For>
    </div>
  );
};

export default Filmstrip;
