/**
 * Whether two flat records hold the same keys with `===` values.
 *
 * Used as the `equals` of the provider's config memos, so a host that passes an
 * equal-valued but newly allocated object (an inline literal in a parent that
 * re-renders, say) does not notify the memo's readers, and the active tool is
 * not rebuilt for a change that changes nothing (#219).
 */
export function shallowEqual(a: object, b: object): boolean {
  if (a === b) return true;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key],
  );
}
