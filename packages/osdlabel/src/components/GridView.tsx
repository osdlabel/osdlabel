import { For } from 'solid-js';
import type { Component } from 'solid-js';
import ViewerCell from './ViewerCell.js';
import { useAnnotator } from '../state/annotator-context.js';
import type { ImageSource } from '@osdlabel/viewer-api';

export interface GridViewProps {
  readonly columns: number;
  readonly rows: number;
  readonly maxColumns: number;
  readonly maxRows: number;
  readonly images: readonly ImageSource[];
}

const GridView: Component<GridViewProps> = (props) => {
  const { uiState, actions } = useAnnotator();

  const totalCells = () => props.columns * props.rows;

  const getImageForCell = (cellIndex: number): ImageSource | undefined => {
    const imageId = uiState.gridAssignments[cellIndex];
    if (!imageId) return undefined;
    return props.images.find((img) => img.id === imageId);
  };

  return (
    <div
      style={{
        display: 'grid',
        'grid-template-columns': `repeat(${props.columns}, 1fr)`,
        'grid-template-rows': `repeat(${props.rows}, 1fr)`,
        gap: '4px',
        width: '100%',
        height: '100%',
        background: '#222',
      }}
    >
      <For each={Array.from({ length: totalCells() }, (_, i) => i)}>
        {(cellIndex) => {
          const imageSource = () => getImageForCell(cellIndex);
          const isActive = () => uiState.activeCellIndex === cellIndex;

          return (
            <div
              data-testid={`grid-cell-${cellIndex}`}
              data-active={isActive()}
              style={{
                position: 'relative',
                'min-height': '0',
                'min-width': '0',
              }}
            >
              {imageSource() ? (
                <ViewerCell
                  imageSource={imageSource()}
                  isActive={isActive()}
                  cellIndex={cellIndex}
                  onActivate={() => actions.setActiveCell(cellIndex)}
                />
              ) : (
                <div
                  onClick={() => actions.setActiveCell(cellIndex)}
                  style={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    'align-items': 'center',
                    'justify-content': 'center',
                    border: isActive() ? '2px dashed #2196F3' : '2px dashed #555',
                    'box-sizing': 'border-box',
                    color: '#777',
                    'font-family': 'system-ui, sans-serif',
                    'font-size': '14px',
                    cursor: 'pointer',
                    background: '#1a1a1a',
                  }}
                >
                  Assign an image
                </div>
              )}
            </div>
          );
        }}
      </For>
    </div>
  );
};

export default GridView;
