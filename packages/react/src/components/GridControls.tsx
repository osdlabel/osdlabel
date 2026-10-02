import { useLayoutEffect, useRef, useState } from 'react';
import { useAnnotator } from '../state/annotator-context.js';
import {
  choosePopoverAlignment,
  getHorizontalClipBounds,
  preventButtonFocusSteal,
  type PopoverAlignment,
} from 'osdlabel';

export interface GridControlsProps {
  readonly maxColumns: number;
  readonly maxRows: number;
}

function TableSelector({
  maxColumns,
  maxRows,
  currentColumns,
  currentRows,
  onSelect,
}: {
  maxColumns: number;
  maxRows: number;
  currentColumns: number;
  currentRows: number;
  onSelect: (cols: number, rows: number) => void;
}) {
  const [hoverCols, setHoverCols] = useState<number | null>(null);
  const [hoverRows, setHoverRows] = useState<number | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [alignment, setAlignment] = useState<PopoverAlignment>('start');
  const anchorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Each time the popover opens, measure it and open it leftward if opening
  // rightward would be clipped by the viewport or a host container (#147).
  // A layout effect, so the flip lands before the browser paints and the
  // popover never shows in the wrong place. `maxColumns` drives its width.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const popover = popoverRef.current;
    if (!isOpen || !anchor || !popover) return;
    const rect = anchor.getBoundingClientRect();
    setAlignment(
      choosePopoverAlignment(
        { left: rect.left, right: rect.right },
        popover.getBoundingClientRect().width,
        getHorizontalClipBounds(anchor),
      ),
    );
  }, [isOpen, maxColumns]);

  const getCellColor = (c: number, r: number) => {
    const targetCols = hoverCols ?? currentColumns;
    const targetRows = hoverRows ?? currentRows;
    return c <= targetCols && r <= targetRows ? '#2196F3' : '#444';
  };

  return (
    <div
      ref={anchorRef}
      style={{ position: 'relative' }}
      onMouseLeave={() => setIsOpen(false)}
      onMouseDown={preventButtonFocusSteal}
    >
      <button
        data-testid="grid-selector-trigger"
        onClick={() => setIsOpen(!isOpen)}
        style={{
          padding: '4px 8px',
          border: '1px solid #444',
          borderRadius: '4px',
          background: '#333',
          color: '#fff',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          fontSize: '12px',
        }}
        title="Change Grid Layout"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M1 1h14v14H1V1zm2 2v4h4V3H3zm6 0v4h4V3H9zM3 9v4h4V9H3zm6 0v4h4V9H9z"
            fillRule="evenodd"
            clipRule="evenodd"
          />
        </svg>
        <span data-testid="grid-size">
          {currentColumns}x{currentRows}
        </span>
      </button>

      {isOpen && (
        <div
          ref={popoverRef}
          data-testid="grid-selector-popover"
          data-alignment={alignment}
          style={{
            position: 'absolute',
            top: '100%',
            left: alignment === 'start' ? 0 : 'auto',
            right: alignment === 'end' ? 0 : 'auto',
            paddingTop: '4px',
            pointerEvents: 'auto',
            minWidth: '100px',
            zIndex: 9999,
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
              borderRadius: '4px',
              padding: '8px',
              boxShadow: '0 4px 6px rgba(0,0,0,0.3)',
            }}
          >
            <div
              style={{ marginBottom: '6px', fontSize: '11px', color: '#aaa', textAlign: 'center' }}
            >
              {hoverCols ?? currentColumns} x {hoverRows ?? currentRows}
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${maxColumns}, 1fr)`,
                gap: '2px',
              }}
            >
              {Array.from({ length: maxRows }, (_, ri) => ri + 1).map((r) =>
                Array.from({ length: maxColumns }, (_, ci) => ci + 1).map((c) => (
                  <div
                    key={`${c}-${r}`}
                    data-testid={`grid-cell-${c}-${r}`}
                    onMouseEnter={() => {
                      setHoverCols(c);
                      setHoverRows(r);
                    }}
                    onClick={() => {
                      onSelect(c, r);
                      setIsOpen(false);
                    }}
                    style={{
                      width: '18px',
                      height: '18px',
                      background: getCellColor(c, r),
                      border: '1px solid #555',
                      cursor: 'pointer',
                      borderRadius: '2px',
                      transition: 'background 0.1s ease',
                    }}
                  />
                )),
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function GridControls({ maxColumns, maxRows }: GridControlsProps) {
  const { uiState, actions } = useAnnotator();

  const changeGrid = (newCols: number, newRows: number) => {
    const cols = Math.max(1, Math.min(newCols, maxColumns));
    const rows = Math.max(1, Math.min(newRows, maxRows));
    // SET_GRID_DIMENSIONS owns clamping the active cell into the resized grid.
    // Doing it here would also read a pre-dispatch `uiState` snapshot.
    actions.setGridDimensions(cols, rows);
  };

  return (
    <div
      data-testid="grid-controls"
      style={{ display: 'flex', alignItems: 'center', fontFamily: 'system-ui, sans-serif' }}
    >
      <TableSelector
        maxColumns={maxColumns}
        maxRows={maxRows}
        currentColumns={uiState.gridColumns}
        currentRows={uiState.gridRows}
        onSelect={changeGrid}
      />
    </div>
  );
}
