// Encoding layer: datasets from Part 10 files or DICOM JSON, and back.
export type { DicomDataset } from './dataset.js';
export { str, num, nums, item, formatTag } from './dataset.js';
export { TAGS } from './tags.js';
export type { Keyword, Vr, TagEntry } from './tags.js';
export { readPart10, DicomParseError, TransferSyntax } from './part10-reader.js';
export type { Part10File, Part10ReadOptions, PixelDataInfo, ByteRange } from './part10-reader.js';
export { indexFrames, frameData } from './frames.js';
export type { FrameIndex, FrameIndexMethod, FrameBytes } from './frames.js';
export { fromDicomJson, toDicomJson } from './dicom-json.js';
export type {
  DicomJsonDataset,
  DicomJsonElement,
  DicomJsonValue,
  ToDicomJsonOptions,
} from './dicom-json.js';
export { writePart10, el, seq, formatDS, IMPLEMENTATION_CLASS_UID } from './part10-writer.js';
export type {
  WriteDataset,
  WriteElement,
  WriteValue,
  WritePart10Options,
} from './part10-writer.js';
export { createUid, dicomDateTime } from './uid.js';
export { toWriteDataset } from './copy.js';

// Mapping layer: DICOM metadata -> osdlabel inputs and DICOM-free descriptions.
export { derivePixelSpacing, pixelSpacingOf } from './mapping/pixel-spacing.js';
export type {
  PixelSpacingResult,
  PixelSpacingOptions,
  DerivedSpacing,
  SpacingSource,
  SpacingPlane,
} from './mapping/pixel-spacing.js';
export { readUltrasoundRegions, toCalibrationRegions } from './mapping/ultrasound-regions.js';
export type {
  UltrasoundRegion,
  UltrasoundAxis,
  UltrasoundUnit,
  RegionSpatialFormat,
  CalibrationRegion,
  AxisCalibration,
  AxisQuantity,
} from './mapping/ultrasound-regions.js';
export { deriveDisplayDefaults, applyWindow } from './mapping/display.js';
export type {
  DisplayDefaults,
  VoiWindow,
  LutTable,
  VoiFunction,
  DefaultVoi,
} from './mapping/display.js';
export { readFrameTiming } from './mapping/timing.js';
export type { FrameTiming, FrameAxis, FrameDimension } from './mapping/timing.js';
export {
  readPlaneGeometry,
  readSlidePlane,
  imageToPatient,
  patientToImage,
  buildStack,
  dot,
  cross,
} from './mapping/plane.js';
export type { PlaneGeometry, Vec3, Point, StackGeometry, StackSlice } from './mapping/plane.js';
export { toImageSources, defaultImageId } from './mapping/image-sources.js';
export type { DicomFrameRef, ToImageSourcesOptions } from './mapping/image-sources.js';
export { describeInstance } from './mapping/describe.js';
export type { InstanceDescription } from './mapping/describe.js';

// Rendering stand-in (native pixel data only); the pixel pipeline's job in production.
export { renderNativeFrame } from './render/native-frame.js';
export type { RenderedFrame } from './render/native-frame.js';
