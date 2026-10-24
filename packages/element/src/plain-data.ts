/**
 * A deep copy of host-supplied data as plain objects and arrays, read through
 * whatever proxies the host wrapped it in.
 *
 * Why the element needs it: a Vue 3 deep `ref` hands the element reactive
 * proxies, and putting those inside a Solid store throws on the next read
 * (measured: `TypeError: 'get' on proxy: property 'Symbol(store-node)' is a
 * read-only and non-configurable data property on the proxy target but the
 * proxy did not return its actual value`). Solid caches its own proxy on the
 * target as a non-configurable property; Vue's `get` trap then returns a
 * reactive wrapper of it, breaking the Proxy invariant. Copying at the
 * boundary means the store only ever holds data the element owns.
 *
 * Annotation data is JSON-shaped by contract (it round-trips through
 * `serialize`), so arrays, plain objects and primitives are all there is;
 * typed arrays are copied too, defensively. `structuredClone` is not an
 * option: it rejects Proxy objects with a DataCloneError.
 */
export function toPlainData<T>(value: T): T {
  return copy(value) as T;
}

function copy(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value)) {
    return value instanceof DataView ? new DataView(value.buffer.slice(0)) : copyTypedArray(value);
  }
  if (Array.isArray(value)) return value.map(copy);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    out[key] = copy((value as Record<string, unknown>)[key]);
  }
  return out;
}

function copyTypedArray(view: ArrayBufferView): ArrayBufferView {
  const slice = (view as unknown as { slice?: () => ArrayBufferView }).slice;
  return typeof slice === 'function' ? slice.call(view) : view;
}
