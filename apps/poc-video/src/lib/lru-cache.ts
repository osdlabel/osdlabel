/**
 * A least-recently-used cache bounded by entry count and by bytes, calling
 * `dispose` on everything it drops (a `VideoFrame` must be `close()`d or the
 * decoder's frame pool runs dry).
 */
export class LruCache<K, V> {
  private readonly _map = new Map<K, { value: V; bytes: number }>();
  private _bytes = 0;
  peakBytes = 0;
  peakEntries = 0;
  evictions = 0;

  constructor(
    private readonly _maxEntries: number,
    private readonly _maxBytes: number,
    private readonly _dispose: (value: V, key: K) => void,
  ) {}

  get size(): number {
    return this._map.size;
  }

  get bytes(): number {
    return this._bytes;
  }

  has(key: K): boolean {
    return this._map.has(key);
  }

  /** Read and mark as most recently used. */
  get(key: K): V | undefined {
    const e = this._map.get(key);
    if (e === undefined) return undefined;
    this._map.delete(key);
    this._map.set(key, e);
    return e.value;
  }

  set(key: K, value: V, bytes: number): void {
    const prev = this._map.get(key);
    if (prev !== undefined) {
      this._map.delete(key);
      this._bytes -= prev.bytes;
      if (prev.value !== value) this._dispose(prev.value, key);
    }
    if (this._maxEntries <= 0 || bytes > this._maxBytes) {
      this._dispose(value, key);
      return;
    }
    this._map.set(key, { value, bytes });
    this._bytes += bytes;
    while (this._map.size > this._maxEntries || this._bytes > this._maxBytes) {
      const oldest = this._map.keys().next();
      if (oldest.done === true) break;
      const k = oldest.value;
      const e = this._map.get(k)!;
      this._map.delete(k);
      this._bytes -= e.bytes;
      this.evictions++;
      this._dispose(e.value, k);
    }
    this.peakBytes = Math.max(this.peakBytes, this._bytes);
    this.peakEntries = Math.max(this.peakEntries, this._map.size);
  }

  clear(): void {
    for (const [k, e] of this._map) this._dispose(e.value, k);
    this._map.clear();
    this._bytes = 0;
  }
}
