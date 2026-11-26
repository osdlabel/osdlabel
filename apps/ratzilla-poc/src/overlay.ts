/**
 * Lays the viewer over the terminal cells the TUI reserves for it.
 *
 * The cells are Ratzilla's own `<span>`s, so the pixels come from what the grid
 * actually rendered, whatever its font.
 */
export function placeOverlay(
  host: HTMLElement,
  grid: HTMLElement | null,
  col: number,
  row: number,
  cols: number,
  rows: number,
): void {
  const first = grid?.children[row]?.children[col];
  const last = grid?.children[row + rows - 1]?.children[col + cols - 1];
  if (!first || !last || cols <= 0 || rows <= 0) {
    host.style.display = 'none';
    return;
  }
  const a = first.getBoundingClientRect();
  const b = last.getBoundingClientRect();
  Object.assign(host.style, {
    display: 'block',
    left: `${a.left}px`,
    top: `${a.top}px`,
    width: `${b.right - a.left}px`,
    height: `${b.bottom - a.top}px`,
  });
}
