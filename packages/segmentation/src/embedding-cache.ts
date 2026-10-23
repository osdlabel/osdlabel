import type { EncodedView } from './provider.js';
import type { EncodeView, SegmentationImageKey, SegmentationPrompt } from './types.js';
import type { SegmentationTarget } from './provider.js';
import { canReuse, DEFAULT_ENCODE_POLICY, type EncodePolicy } from './encode-plan.js';

export interface CacheEntry<T> {
  readonly view: EncodeView;
  readonly promise: Promise<EncodedView<T>>;
  readonly controller: AbortController;
  bytes: number;
  lastUsed: number;
  settled: boolean;
}

export interface EmbeddingCacheOptions {
  /** Most embeddings kept. Default 8 (a SAM ViT embedding is 4 MiB; SAM 2 adds 3 MiB). */
  readonly maxEntries?: number | undefined;
  /** Byte budget across entries. Default 64 MiB. */
  readonly maxBytes?: number | undefined;
}

export interface CacheLookup<T> {
  readonly entry: Promise<EncodedView<T>>;
  readonly view: EncodeView;
  readonly hit: boolean;
}

/**
 * Embeddings keyed by what they cover — (image, region, scale) — rather than
 * by image alone, because on a deep-zoom image one image has as many
 * embeddings as there are places and zoom levels the user prompts at.
 *
 * Lookup reuses any entry that {@link canReuse} accepts (finest first), so a
 * pan inside the margin or a modest zoom costs nothing; otherwise the caller's
 * planned view is encoded and stored. In-flight encodes are shared, and a
 * failed encode is evicted so the next prompt retries.
 */
export class EmbeddingCache<T> {
  private readonly entries: CacheEntry<T>[] = [];
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private clock = 0;

  constructor(options?: EmbeddingCacheOptions) {
    this.maxEntries = options?.maxEntries ?? 8;
    this.maxBytes = options?.maxBytes ?? 64 * 1024 * 1024;
  }

  get size(): number {
    return this.entries.length;
  }

  get bytes(): number {
    return this.entries.reduce((sum, e) => sum + e.bytes, 0);
  }

  /** The finest reusable entry, or null. */
  find(
    target: SegmentationTarget,
    prompt: SegmentationPrompt | null,
    policy: EncodePolicy = DEFAULT_ENCODE_POLICY,
  ): CacheEntry<T> | null {
    let best: CacheEntry<T> | null = null;
    for (const e of this.entries) {
      if (!canReuse(e.view, target, prompt, policy).reuse) continue;
      if (!best || e.view.scale > best.view.scale) best = e;
    }
    return best;
  }

  /**
   * Returns a reusable embedding, or starts encoding `planned` with `encode`.
   * The encode runs under the cache's own controller: a superseded prompt must
   * not cancel an expensive, reusable encode. Only eviction or `clear` aborts it.
   */
  lookupOrEncode(
    target: SegmentationTarget,
    prompt: SegmentationPrompt | null,
    planned: EncodeView,
    encode: (view: EncodeView, signal: AbortSignal) => Promise<EncodedView<T>>,
    policy: EncodePolicy = DEFAULT_ENCODE_POLICY,
  ): CacheLookup<T> {
    const found = this.find(target, prompt, policy);
    if (found) {
      found.lastUsed = ++this.clock;
      return { entry: found.promise, view: found.view, hit: true };
    }
    const controller = new AbortController();
    const promise = encode(planned, controller.signal);
    const entry: CacheEntry<T> = {
      view: planned,
      promise,
      controller,
      bytes: 0,
      lastUsed: ++this.clock,
      settled: false,
    };
    this.entries.push(entry);
    promise.then(
      (encoded) => {
        entry.bytes = encoded.bytes;
        entry.settled = true;
        this.evict();
      },
      () => {
        const i = this.entries.indexOf(entry);
        if (i !== -1) this.entries.splice(i, 1);
      },
    );
    this.evict();
    return { entry: promise, view: planned, hit: false };
  }

  /** Drops entries for one image, or everything. */
  clear(imageKey?: SegmentationImageKey): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (imageKey === undefined || e.view.imageKey === imageKey) {
        e.controller.abort();
        this.entries.splice(i, 1);
      }
    }
  }

  private evict(): void {
    // Never evict an in-flight encode: someone is awaiting it.
    while (this.entries.length > this.maxEntries || this.bytes > this.maxBytes) {
      let victim = -1;
      for (let i = 0; i < this.entries.length; i++) {
        const e = this.entries[i]!;
        if (!e.settled) continue;
        if (victim === -1 || e.lastUsed < this.entries[victim]!.lastUsed) victim = i;
      }
      if (victim === -1) return;
      this.entries.splice(victim, 1);
    }
  }
}
