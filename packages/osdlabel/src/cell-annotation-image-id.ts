import type { ImageId, UIState } from '@osdlabel/viewer-api';

/**
 * The image a cell's annotations are keyed on right now: the slice's own
 * `ImageId` for a source whose frames are separate images (a series grouping
 * registered through `SET_CELL_FRAME`'s `sliceImageIds`), else the image
 * assigned to the cell.
 */
export function cellAnnotationImageId(ui: UIState, cellIndex: number): ImageId | undefined {
  const frame = ui.cellFrames?.[cellIndex];
  return frame?.sliceImageIds?.[frame.index] ?? ui.gridAssignments[cellIndex];
}
