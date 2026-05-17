/**
 * Valibot schema for Fabric raw annotation data validation.
 */
import * as v from 'valibot';
import { MAX_COORDINATE, MAX_STRING_LENGTH, MAX_POINTS_COUNT } from './constants.js';

// ── Supported fabric types ──────────────────────────────────────────────

const SUPPORTED_TYPES_LOWER = ['rect', 'circle', 'line', 'polyline', 'polygon'] as const;

function isSupportedFabricType(type: string): boolean {
  return SUPPORTED_TYPES_LOWER.includes(
    type.toLowerCase() as (typeof SUPPORTED_TYPES_LOWER)[number],
  );
}

function normalizeType(type: string): string {
  return type.toLowerCase();
}

// ── Type-specific validation helpers ────────────────────────────────────

function isFiniteNum(val: unknown): val is number {
  return typeof val === 'number' && isFinite(val);
}

type LooseData = { type: string } & { [key: string]: unknown };

function validateNumericProps(data: LooseData): boolean {
  for (const prop of ['left', 'top', 'scaleX', 'scaleY', 'angle', 'opacity'] as const) {
    const val = data[prop];
    if (val !== undefined) {
      if (!isFiniteNum(val)) return false;
      if (Math.abs(val) > MAX_COORDINATE) return false;
    }
  }
  return true;
}

function validateDimensionProps(data: LooseData): boolean {
  for (const prop of ['width', 'height'] as const) {
    const val = data[prop];
    if (val !== undefined) {
      if (!isFiniteNum(val)) return false;
      if (val < 0 || val > MAX_COORDINATE) return false;
    }
  }
  return true;
}

function validateStringProps(data: LooseData): boolean {
  for (const prop of ['fill', 'stroke', 'backgroundColor'] as const) {
    const val = data[prop];
    if (val !== undefined && val !== null && typeof val === 'string') {
      if (val.length > MAX_STRING_LENGTH) return false;
    }
  }
  return true;
}

function validateRectRequirements(data: LooseData): boolean {
  if (normalizeType(data.type) === 'rect') {
    return (
      isFiniteNum(data.width) && data.width >= 0 && isFiniteNum(data.height) && data.height >= 0
    );
  }
  return true;
}

function validateCircleRequirements(data: LooseData): boolean {
  if (normalizeType(data.type) === 'circle') {
    return isFiniteNum(data.radius) && data.radius >= 0;
  }
  return true;
}

function validateLineRequirements(data: LooseData): boolean {
  if (normalizeType(data.type) === 'line') {
    for (const k of ['x1', 'y1', 'x2', 'y2'] as const) {
      const val = data[k];
      if (!isFiniteNum(val)) return false;
      if (Math.abs(val) > MAX_COORDINATE) return false;
    }
  }
  return true;
}

function validatePolylineRequirements(data: LooseData): boolean {
  const type = normalizeType(data.type);
  if (type === 'polyline' || type === 'polygon') {
    if (!Array.isArray(data.points)) return false;
    if (data.points.length > MAX_POINTS_COUNT) return false;
    for (const p of data.points as unknown[]) {
      if (typeof p !== 'object' || p === null) return false;
      const pt = p as Record<string, unknown>;
      if (!isFiniteNum(pt.x) || !isFiniteNum(pt.y)) return false;
    }
  }
  return true;
}

function validateHitDetectionProps(data: LooseData): boolean {
  if (data.perPixelTargetFind !== undefined && typeof data.perPixelTargetFind !== 'boolean') return false;
  if (data.targetFindTolerance !== undefined && !isFiniteNum(data.targetFindTolerance)) return false;
  return true;
}

// ── Fabric data object schema ───────────────────────────────────────────

const FabricDataObjectSchema = v.pipe(
  v.looseObject({
    type: v.pipe(v.string(), v.check(isSupportedFabricType)),
  }),
  v.check(validateNumericProps),
  v.check(validateDimensionProps),
  v.check(validateStringProps),
  v.check(validateHitDetectionProps),
  v.check(validateRectRequirements),
  v.check(validateCircleRequirements),
  v.check(validateLineRequirements),
  v.check(validatePolylineRequirements),
);

/** A schema for FabricRawAnnotationData. */
export const FabricRawAnnotationDataSchema = v.object({
  format: v.literal('fabric'),
  fabricVersion: v.string(),
  data: FabricDataObjectSchema,
});
