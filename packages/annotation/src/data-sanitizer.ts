/**
 * Fabric.js data sanitizer.
 *
 * Provides a property-allowlist-based sanitizer that strips unknown keys,
 * validates and bounds-checks numeric values, and performs type-specific
 * checks before data reaches Fabric's util.enlivenObjects().
 *
 * Note: Manual validation is kept here to avoid a circular dependency
 * with `@osdlabel/validation` (which depends on `@osdlabel/annotation`).
 * Equivalent Valibot schemas exist in `@osdlabel/validation`.
 */

// ---------------------------------------------------------------------------
// Bounds constants (exported for test assertions)
// ---------------------------------------------------------------------------

export const MAX_COORDINATE = 1_000_000;
export const MAX_DIMENSION = 1_000_000;
export const MAX_SCALE = 1_000;
export const MAX_ANGLE = 360;
export const MAX_STROKE_WIDTH = 10_000;
export const MAX_STRING_LENGTH = 256;
export const MAX_POINTS_COUNT = 10_000;
export const MAX_STROKE_DASH_ARRAY_LENGTH = 20;

// ---------------------------------------------------------------------------
// Supported types
// ---------------------------------------------------------------------------

/**
 * Canonical capitalized Fabric.js type strings as emitted by `obj.toObject()`
 * in Fabric v7.
 *
 * Note: 'Circle' covers our 'point' annotation type.
 * 'Polyline'/'Polygon' cover our polyline/polygon annotation types.
 */
export type FabricTypeName = 'Rect' | 'Circle' | 'Line' | 'Polyline' | 'Polygon';

export const SUPPORTED_FABRIC_TYPES: readonly FabricTypeName[] = [
  'Rect',
  'Circle',
  'Line',
  'Polyline',
  'Polygon',
] as const;

// ---------------------------------------------------------------------------
// Shared primitive validators (exported for reuse in serialization.ts)
// ---------------------------------------------------------------------------

export function isObject(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && isFinite(value);
}

export function validatePointValue(value: unknown): boolean {
  if (!isObject(value)) return false;
  const p = value as Record<string, unknown>;
  return isFiniteNumber(p.x) && isFiniteNumber(p.y);
}

export function isBoundedNumber(value: unknown, min: number, max: number): boolean {
  return isFiniteNumber(value) && (value as number) >= min && (value as number) <= max;
}

// ---------------------------------------------------------------------------
// Type normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a Fabric type string to its canonical capitalized form.
 * Accepts 'rect', 'Rect', 'RECT' → 'Rect', etc.
 * Returns null for unknown or empty types.
 */
export function normalizeFabricType(raw: string): FabricTypeName | null {
  if (raw.length === 0) return null;
  // Capitalize first char, lowercase the rest: 'rect' → 'Rect', 'POLYLINE' → 'Polyline'
  const capitalized = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  return SUPPORTED_FABRIC_TYPES.find((t) => t === capitalized) ?? null;
}

// ---------------------------------------------------------------------------
// Property allowlist types
// ---------------------------------------------------------------------------

/**
 * Validator kinds for property allowlists.
 * Each kind maps to a specific validation strategy in `sanitizeValue`.
 *
 * Each kind maps to a specific validation strategy in `sanitizeValue`.
 * Equivalent Valibot schemas exist in `@osdlabel/validation`.
 */
type PropValidator =
  | 'coordinate' // finite number, abs <= MAX_COORDINATE
  | 'dimension' // finite number, 0 <= x <= MAX_DIMENSION
  | 'scale' // finite number, abs <= MAX_SCALE
  | 'angle' // finite number, -360 <= x <= 360
  | 'opacity' // finite number, 0 <= x <= 1
  | 'strokeWidth' // finite number, 0 <= x <= MAX_STROKE_WIDTH
  | 'miterLimit' // finite number, 0 <= x <= 100
  | 'boolean' // strict boolean
  | 'colorOrNull' // string (len <= MAX_STRING_LENGTH) or null
  | 'idString' // string (len <= MAX_STRING_LENGTH)
  | 'originX' // 'left' | 'center' | 'right' or finite number
  | 'originY' // 'top' | 'center' | 'bottom' or finite number
  | 'paintFirst' // 'fill' | 'stroke'
  | 'fillRule' // 'nonzero' | 'evenodd'
  | 'lineCap' // 'butt' | 'round' | 'square'
  | 'lineJoin' // 'bevel' | 'round' | 'miter'
  | 'compositeOp' // known canvas composite operation string
  | 'numberArray' // number[] | null, max MAX_STROKE_DASH_ARRAY_LENGTH elements
  | 'forceNull' // always output null (strips nested objects like shadow/clipPath)
  | 'pointsArray'; // {x,y}[] with bounds, max MAX_POINTS_COUNT elements

type PropMap = Readonly<Record<string, PropValidator>>;

// ---------------------------------------------------------------------------
// Property allowlists per Fabric type
// ---------------------------------------------------------------------------

const BASE_PROPS: PropMap = {
  left: 'coordinate',
  top: 'coordinate',
  width: 'dimension',
  height: 'dimension',
  originX: 'originX',
  originY: 'originY',
  angle: 'angle',
  flipX: 'boolean',
  flipY: 'boolean',
  scaleX: 'scale',
  scaleY: 'scale',
  skewX: 'angle',
  skewY: 'angle',
  paintFirst: 'paintFirst',
  fill: 'colorOrNull',
  fillRule: 'fillRule',
  stroke: 'colorOrNull',
  strokeWidth: 'strokeWidth',
  strokeDashArray: 'numberArray',
  strokeDashOffset: 'coordinate',
  strokeLineCap: 'lineCap',
  strokeLineJoin: 'lineJoin',
  strokeMiterLimit: 'miterLimit',
  strokeUniform: 'boolean',
  opacity: 'opacity',
  globalCompositeOperation: 'compositeOp',
  backgroundColor: 'colorOrNull',
  shadow: 'forceNull',
  visible: 'boolean',
  clipPath: 'forceNull',
  id: 'idString',
} as const;

const RECT_EXTRA_PROPS: PropMap = {
  rx: 'dimension',
  ry: 'dimension',
} as const;

const CIRCLE_EXTRA_PROPS: PropMap = {
  radius: 'dimension',
  startAngle: 'angle',
  endAngle: 'angle',
  counterClockwise: 'boolean',
} as const;

const LINE_EXTRA_PROPS: PropMap = {
  x1: 'coordinate',
  y1: 'coordinate',
  x2: 'coordinate',
  y2: 'coordinate',
} as const;

const POLYLINE_EXTRA_PROPS: PropMap = {
  points: 'pointsArray',
} as const;

const REQUIRED_FIELDS: Readonly<Record<FabricTypeName, readonly string[]>> = {
  Rect: ['width', 'height'],
  Circle: ['radius'],
  Line: ['x1', 'y1', 'x2', 'y2'],
  Polyline: ['points'],
  Polygon: ['points'],
} as const;

function getTypeExtraProps(type: FabricTypeName): PropMap {
  switch (type) {
    case 'Rect':
      return RECT_EXTRA_PROPS;
    case 'Circle':
      return CIRCLE_EXTRA_PROPS;
    case 'Line':
      return LINE_EXTRA_PROPS;
    case 'Polyline':
      return POLYLINE_EXTRA_PROPS;
    case 'Polygon':
      return POLYLINE_EXTRA_PROPS;
  }
}

// ---------------------------------------------------------------------------
// Value sanitizer (internal)
// ---------------------------------------------------------------------------

/** Result type for per-property validation — mirrors the shape of zod.safeParse. */
type ParseResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

function ok(value: unknown): ParseResult {
  return { ok: true, value };
}
const FAIL: ParseResult = { ok: false };

const ORIGIN_X_VALUES = ['left', 'center', 'right'] as const;
const ORIGIN_Y_VALUES = ['top', 'center', 'bottom'] as const;
const PAINT_FIRST_VALUES = ['fill', 'stroke'] as const;
const FILL_RULE_VALUES = ['nonzero', 'evenodd'] as const;
const LINE_CAP_VALUES = ['butt', 'round', 'square'] as const;
const LINE_JOIN_VALUES = ['bevel', 'round', 'miter'] as const;
const COMPOSITE_OP_VALUES = [
  'source-over',
  'source-in',
  'source-out',
  'source-atop',
  'destination-over',
  'destination-in',
  'destination-out',
  'destination-atop',
  'lighter',
  'copy',
  'xor',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
] as const;

function sanitizeValue(value: unknown, validator: PropValidator): ParseResult {
  switch (validator) {
    case 'coordinate': {
      if (!isFiniteNumber(value) || Math.abs(value as number) > MAX_COORDINATE) return FAIL;
      return ok(value);
    }
    case 'dimension': {
      if (!isFiniteNumber(value)) return FAIL;
      const n = value as number;
      if (n < 0 || n > MAX_DIMENSION) return FAIL;
      return ok(value);
    }
    case 'scale': {
      if (!isFiniteNumber(value) || Math.abs(value as number) > MAX_SCALE) return FAIL;
      return ok(value);
    }
    case 'angle': {
      if (!isFiniteNumber(value)) return FAIL;
      const n = value as number;
      if (n < -MAX_ANGLE || n > MAX_ANGLE) return FAIL;
      return ok(value);
    }
    case 'opacity': {
      if (!isBoundedNumber(value, 0, 1)) return FAIL;
      return ok(value);
    }
    case 'strokeWidth': {
      if (!isBoundedNumber(value, 0, MAX_STROKE_WIDTH)) return FAIL;
      return ok(value);
    }
    case 'miterLimit': {
      if (!isBoundedNumber(value, 0, 100)) return FAIL;
      return ok(value);
    }
    case 'boolean': {
      if (typeof value !== 'boolean') return FAIL;
      return ok(value);
    }
    case 'colorOrNull': {
      if (value === null) return ok(null);
      if (typeof value !== 'string' || value.length > MAX_STRING_LENGTH) return FAIL;
      return ok(value);
    }
    case 'idString': {
      if (typeof value !== 'string' || value.length > MAX_STRING_LENGTH) return FAIL;
      return ok(value);
    }
    case 'originX': {
      if (typeof value === 'string') {
        if (!(ORIGIN_X_VALUES as readonly string[]).includes(value)) return FAIL;
        return ok(value);
      }
      if (isFiniteNumber(value)) return ok(value);
      return FAIL;
    }
    case 'originY': {
      if (typeof value === 'string') {
        if (!(ORIGIN_Y_VALUES as readonly string[]).includes(value)) return FAIL;
        return ok(value);
      }
      if (isFiniteNumber(value)) return ok(value);
      return FAIL;
    }
    case 'paintFirst': {
      if (typeof value !== 'string' || !(PAINT_FIRST_VALUES as readonly string[]).includes(value))
        return FAIL;
      return ok(value);
    }
    case 'fillRule': {
      if (typeof value !== 'string' || !(FILL_RULE_VALUES as readonly string[]).includes(value))
        return FAIL;
      return ok(value);
    }
    case 'lineCap': {
      if (typeof value !== 'string' || !(LINE_CAP_VALUES as readonly string[]).includes(value))
        return FAIL;
      return ok(value);
    }
    case 'lineJoin': {
      if (typeof value !== 'string' || !(LINE_JOIN_VALUES as readonly string[]).includes(value))
        return FAIL;
      return ok(value);
    }
    case 'compositeOp': {
      if (typeof value !== 'string' || !(COMPOSITE_OP_VALUES as readonly string[]).includes(value))
        return FAIL;
      return ok(value);
    }
    case 'numberArray': {
      if (value === null) return ok(null);
      if (!Array.isArray(value) || value.length > MAX_STROKE_DASH_ARRAY_LENGTH) return FAIL;
      for (const item of value) {
        if (!isFiniteNumber(item)) return FAIL;
      }
      return ok([...value] as number[]);
    }
    case 'forceNull': {
      return ok(null);
    }
    case 'pointsArray': {
      if (!Array.isArray(value) || value.length > MAX_POINTS_COUNT) return FAIL;
      const sanitizedPoints: Array<{ readonly x: number; readonly y: number }> = [];
      for (const p of value) {
        if (!isObject(p)) return FAIL;
        const point = p as Record<string, unknown>;
        if (!isFiniteNumber(point.x) || !isFiniteNumber(point.y)) return FAIL;
        const px = point.x as number;
        const py = point.y as number;
        if (Math.abs(px) > MAX_COORDINATE || Math.abs(py) > MAX_COORDINATE) return FAIL;
        sanitizedPoints.push({ x: px, y: py });
      }
      return ok(sanitizedPoints);
    }
  }
}

// ---------------------------------------------------------------------------
// Main sanitizer (exported)
// ---------------------------------------------------------------------------

/**
 * Sanitize raw Fabric.js object data before passing to `util.enlivenObjects()`.
 *
 * - Validates and normalizes the `type` field (case-insensitive)
 * - Copies only allowlisted properties to the output
 * - Validates each value against its expected type and bounds
 * - Strips unknown keys silently
 * - Forces `shadow` and `clipPath` to null (they accept nested objects)
 * - Validates type-specific required fields
 *
 * Returns a sanitized copy, or `null` if validation fails.
 *
 * Note: Equivalent Valibot schema exists in `@osdlabel/validation` as
 * `RawAnnotationDataSchema`. This manual version is kept for circular-dep avoidance.
 */
export function sanitizeFabricData(data: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof data.type !== 'string') return null;

  const normalizedType = normalizeFabricType(data.type);
  if (normalizedType === null) return null;

  const extraProps = getTypeExtraProps(normalizedType);
  const allProps: PropMap = { ...BASE_PROPS, ...extraProps };

  const result: Record<string, unknown> = { type: normalizedType };

  for (const [key, validator] of Object.entries(allProps)) {
    if (validator === 'forceNull') {
      // Always include forced-null fields regardless of input (strips shadow/clipPath objects).
      result[key] = null;
      continue;
    }

    if (!(key in data)) continue;

    const value = data[key];
    if (value === undefined) continue;

    const parsed = sanitizeValue(value, validator);
    if (!parsed.ok) return null;
    result[key] = parsed.value;
  }

  // Validate type-specific required fields.
  const required = REQUIRED_FIELDS[normalizedType];
  for (const field of required) {
    if (result[field] === undefined) return null;
  }

  // Polyline/Polygon: points array must have >= 2 entries.
  if (normalizedType === 'Polyline' || normalizedType === 'Polygon') {
    const points = result.points;
    if (!Array.isArray(points) || points.length < 2) return null;
  }

  return result;
}
