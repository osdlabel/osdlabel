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

export default function GridView({ columns, rows, images }: GridViewProps) {
  const { uiState, actions } = useAnnotator();

  const totalCells = columns * rows;

  const getImageForCell = (cellIndex: number): ImageSource | undefined => {
    const imageId = uiState.gridAssignments[cellIndex];
    if (!imageId) return undefined;
    return images.find((img) => img.id === imageId);
  };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`,
        gap: '4px',
        width: '100%',
        height: '100%',
        background: '#222',
      }}
    >
      {Array.from({ length: totalCells }, (_, cellIndex) => {
        const imageSource = getImageForCell(cellIndex);
        const isActive = uiState.activeCellIndex === cellIndex;

        return (
          <div
            key={cellIndex}
            data-testid={`grid-cell-${cellIndex}`}
            data-active={isActive}
            style={{
              position: 'relative',
              minHeight: '0',
              minWidth: '0',
            }}
          >
            {imageSource ? (
              <ViewerCell
                imageSource={imageSource}
                isActive={isActive}
                cellIndex={cellIndex}
                onActivate={() => actions.setActiveCell(cellIndex)}
              />
            ) : (
              <div
                data-testid={`cell-placeholder-${cellIndex}`}
                onClick={() => actions.setActiveCell(cellIndex)}
                style={{
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: isActive ? '2px dashed #2196F3' : '2px dashed #555',
                  boxSizing: 'border-box',
                  color: '#777',
                  fontFamily: 'system-ui, sans-serif',
                  fontSize: '14px',
                  cursor: 'pointer',
                  background: '#1a1a1a',
                }}
              >
                Assign an image
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
