import { type Component, createSignal, For, Show } from 'solid-js';
import { useAnnotator } from '../state/annotator-context.js';
import { preventButtonFocusSteal } from 'osdlabel';

export interface GridControlsProps {
  readonly maxColumns: number;
  readonly maxRows: number;
}

const TableSelector: Component<{
  maxColumns: number;
  maxRows: number;
  currentColumns: number;
  currentRows: number;
  onSelect: (cols: number, rows: number) => void;
}> = (props) => {
  const [hoverCols, setHoverCols] = createSignal<number | null>(null);
  const [hoverRows, setHoverRows] = createSignal<number | null>(null);
  const [isOpen, setIsOpen] = createSignal(false);

  const handleMouseEnter = (c: number, r: number) => {
    setHoverCols(c);
    setHoverRows(r);
  };

  const handleClick = (c: number, r: number) => {
    props.onSelect(c, r);
    setIsOpen(false);
  };

  const getCellColor = (c: number, r: number) => {
    const targetCols = hoverCols() ?? props.currentColumns;
    const targetRows = hoverRows() ?? props.currentRows;
    const isSelected = c <= targetCols && r <= targetRows;
    return isSelected ? '#2196F3' : '#444';
  };

  // Icon for the grid button
  const GridIcon = () => (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M1 1h14v14H1V1zm2 2v4h4V3H3zm6 0v4h4V3H9zM3 9v4h4V9H3zm6 0v4h4V9H9z"
        fill-rule="evenodd"
        clip-rule="evenodd"
      />
    </svg>
  );

  return (
    <div
      style={{ position: 'relative' }}
      onMouseLeave={() => setIsOpen(false)}
      onMouseDown={preventButtonFocusSteal}
    >
      <button
        data-testid="grid-selector-trigger"
        onClick={() => setIsOpen(!isOpen())}
        style={{
          padding: '4px 8px',
          border: '1px solid #444',
          'border-radius': '4px',
          background: '#333',
          color: '#fff',
          cursor: 'pointer',
          display: 'flex',
          'align-items': 'center',
          gap: '6px',
          'font-size': '12px',
        }}
        title="Change Grid Layout"
      >
        <GridIcon />
        <span data-testid="grid-size">
          {props.currentColumns}x{props.currentRows}
        </span>
      </button>

      <Show when={isOpen()}>
        <div
          data-testid="grid-selector-popover"
          style={{
            position: 'absolute',
            top: '100%',
            left: '0',
            'padding-top': '4px', // Use padding instead of margin to include the gap in the hit area
            'pointer-events': 'auto', // Ensure pointer events work
            'min-width': '100px',
            'z-index': 9999,
          }}
          onMouseLeave={() => {
            setHoverCols(null);
            setHoverRows(null);
          }}
        >
          <div
            style={{
              background: '#2a2a2a',
              border: '1px solid #444',
              'border-radius': '4px',
              padding: '8px',
              'box-shadow': '0 4px 6px rgba(0,0,0,0.3)',
            }}
          >
            <div
              style={{
                'margin-bottom': '6px',
                'font-size': '11px',
                color: '#aaa',
                'text-align': 'center',
              }}
            >
              {hoverCols() ?? props.currentColumns} x {hoverRows() ?? props.currentRows}
            </div>
            <div
              style={{
                display: 'grid',
                'grid-template-columns': `repeat(${props.maxColumns}, 1fr)`,
                gap: '2px',
              }}
            >
              <For each={Array.from({ length: props.maxRows }, (_, i) => i + 1)}>
                {(r) => (
                  <For each={Array.from({ length: props.maxColumns }, (_, i) => i + 1)}>
                    {(c) => (
                      <div
                        data-testid={`grid-cell-${c}-${r}`}
                        onMouseEnter={() => handleMouseEnter(c, r)}
                        onClick={() => handleClick(c, r)}
                        style={{
                          width: '18px',
                          height: '18px',
                          background: getCellColor(c, r),
                          border: '1px solid #555',
                          cursor: 'pointer',
                          'border-radius': '2px',
                          transition: 'background 0.1s ease',
                        }}
                      />
                    )}
                  </For>
                )}
              </For>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
};

const GridControls: Component<GridControlsProps> = (props) => {
  const { uiState, actions } = useAnnotator();

  const changeGrid = (newCols: number, newRows: number) => {
    const cols = Math.max(1, Math.min(newCols, props.maxColumns));
    const rows = Math.max(1, Math.min(newRows, props.maxRows));
    actions.setGridDimensions(cols, rows);

    // Clamp active cell index to valid range
    const maxIndex = cols * rows - 1;
    if (uiState.activeCellIndex > maxIndex) {
      actions.setActiveCell(maxIndex);
    }
  };

  return (
    <div
      data-testid="grid-controls"
      style={{
        display: 'flex',
        'align-items': 'center',
        'font-family': 'system-ui, sans-serif',
      }}
    >
      <TableSelector
        maxColumns={props.maxColumns}
        maxRows={props.maxRows}
        currentColumns={uiState.gridColumns}
        currentRows={uiState.gridRows}
        onSelect={changeGrid}
      />
    </div>
  );
};

export default GridControls;
