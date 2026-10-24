export type { ScalarVolume, AllocateOptions } from './scalar-volume.js';
export {
  allocateScalarVolume,
  volumeFromSlices,
  contiguousVoxels,
  volumeByteLength,
} from './scalar-volume.js';

export type { AxisOrder } from './permute.js';
export { SAGITTAL_MAJOR, permuteGrid, permuteVolume } from './permute.js';

export type { Interpolation, ResliceOptions, ReslicePath } from './reslice.js';
export { reslice } from './reslice.js';

export { LUT_OFFSET, buildWindowLut, applyWindowLut } from './window-lut.js';

export { fillSheppLoganPhantom } from './phantom.js';

export type { LabelVolume } from './label-volume.js';
export {
  allocateLabelVolume,
  fillDisc,
  forEachSpanInDisc,
  forEachVoxelInDisc,
  paintDisc,
  resliceLabels,
} from './label-volume.js';

