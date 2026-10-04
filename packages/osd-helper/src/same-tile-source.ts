import type { TileSourceSpec } from '@osdlabel/viewer-api';

/**
 * Whether two tile sources open the same image, so a cell can skip reloading.
 *
 * Strings compare exactly. Plain objects and arrays compare by value, so a host
 * that re-creates an equal options object (an inline literal in a component
 * that re-renders, say) does not reload the image. Anything else, such as a
 * `TileSource` instance, a function like `getTileUrl`, or another class
 * instance, compares by identity, since its behaviour may not be visible in
 * its fields.
 */
export function isSameTileSource(
  a: TileSourceSpec | undefined,
  b: TileSourceSpec | undefined,
): boolean {
  return sameValue(a, b);
}

function isPlainData(value: object): boolean {
  if (Array.isArray(value)) return true;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (!isPlainData(a) || !isPlainData(b)) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}
