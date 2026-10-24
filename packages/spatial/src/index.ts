export type { Vec3, Point2 } from './vec3.js';
export {
  vec3,
  add,
  sub,
  scale,
  addScaled,
  dot,
  cross,
  length,
  normalize,
  rotateAbout,
} from './vec3.js';

export type { PlaneFrame, PlaneSpacing, PlaneProjection } from './plane-frame.js';
export {
  PIXEL_CENTRE,
  planeNormal,
  assertValidPlaneFrame,
  imageToPatient,
  patientToImage,
  signedDistance,
  planeFrameFromDicom,
  isSamePlane,
  planeCorners,
} from './plane-frame.js';

export type { VolumeGrid, OrthogonalOrientation, PlaneIndexMapping } from './volume-grid.js';
export {
  indexToPatient,
  patientToIndex,
  patientDirectionToIndex,
  volumeCentre,
  orthogonalPlane,
  centredPlane,
  planeIndexMapping,
} from './volume-grid.js';

export type { DistanceField, Segment2 } from './cross-plane.js';
export {
  distanceField,
  evaluateField,
  isParallelField,
  polygonZeroSegments,
  polylineZeroCrossings,
  circleZeroChord,
  transferPoint,
  clipSegmentToImage,
  referenceLine,
  sliceOffset,
} from './cross-plane.js';
