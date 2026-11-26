import type { Bridge } from '@osdlabel/shell-bridge/bridge';

/** The shared bridge, plus the one call only the TUI needs. */
export interface TuiBridge extends Bridge {
  /** Places the viewer over these terminal cells (an empty area hides it). */
  setViewerRect(col: number, row: number, cols: number, rows: number): void;
}
