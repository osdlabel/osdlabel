import { FabricObject } from 'fabric';

declare module 'fabric' {
  interface FabricObject {
    id?: string;
    /** When true, setMode('annotation') will not make this object interactive. Not serialized. */
    _readOnly?: boolean;
  }
  interface SerializedObjectProps {
    id?: string;
  }
}

/**
 * Registers custom properties on FabricObject so toObject() includes them.
 *
 * Called automatically when a `FabricOverlay` is constructed, so most consumers
 * never need to invoke it directly. It remains exported (and idempotent) for
 * advanced setups that build Fabric objects before any overlay exists. The
 * `id` entry is merged into any existing `customProperties` rather than
 * overwriting them, so consumer-registered properties are preserved.
 *
 * _readOnly is intentionally NOT registered — it is transient display state, not persisted.
 */
export function initFabricModule(): void {
  const existing = FabricObject.customProperties ?? [];
  if (!existing.includes('id')) {
    FabricObject.customProperties = [...existing, 'id'];
  }
}
