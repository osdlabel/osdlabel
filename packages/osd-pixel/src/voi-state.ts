import type { DisplayTransform, StoredRange, VoiLut, VoiWindow } from '@osdlabel/pixel';
import { buildVoiLut } from '@osdlabel/pixel';

/**
 * The current display transform of one image, shared by its tile source (CPU
 * path) and its drawer (GPU path). `version` increments on every change so
 * cached 8-bit tiles can tell they are stale without comparing transforms.
 *
 * Deliberately not reactive: framework bindings push into it from their own
 * effects (`createEffect` / `useEffect`), the way `applyImageFilters` is fed
 * from `CellTransform` today.
 */
export class VoiState {
  private _transform: DisplayTransform;
  private _version = 0;
  private _lut: VoiLut | null = null;
  private readonly _listeners = new Set<() => void>();

  constructor(
    readonly storedRange: StoredRange,
    initial: DisplayTransform,
  ) {
    this._transform = initial;
  }

  get transform(): DisplayTransform {
    return this._transform;
  }

  get version(): number {
    return this._version;
  }

  setWindow(window: VoiWindow): void {
    this.set({ ...this._transform, window });
  }

  setInvert(invert: boolean): void {
    this.set({ ...this._transform, invert });
  }

  set(transform: DisplayTransform): void {
    this._transform = transform;
    this._version++;
    this._lut = null;
    for (const l of this._listeners) l();
  }

  /** The LUT for the current transform over `storedRange`, built on first use per version. */
  lut(): VoiLut {
    if (!this._lut) this._lut = buildVoiLut(this.storedRange, this._transform);
    return this._lut;
  }

  onChange(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }
}
