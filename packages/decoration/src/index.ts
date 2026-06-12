export type {
  Decoration,
  DecorationType,
  TextDecoration,
  TextDecorationStyle,
  TextPlacement,
  LineDecoration,
  LineDecorationStyle,
  DomDecoration,
  DomDecorationStyle,
} from './decoration.js';
export type { DecorationContext, DecorationProvider } from './provider.js';
export { composeProviders } from './provider.js';
export type { Measurement, SpacingAxis, FormatMeasurementOptions } from './measurement.js';
export { toPhysicalLength, toPhysicalArea, formatMeasurement } from './measurement.js';
export {
  area,
  perimeter,
  length,
  radius,
  distance,
  centroid,
  midpoint,
  boundingBox,
  circleToBoundingRectangle,
} from '@osdlabel/geometry';
export {
  createMeasurementProvider,
  createLabelProvider,
  createDistanceProvider,
} from './built-in-providers.js';
export type {
  MeasurementProviderOptions,
  LabelProviderOptions,
  DistanceProviderOptions,
  AnnotationPair,
} from './built-in-providers.js';
export * from './emphasis.js';
