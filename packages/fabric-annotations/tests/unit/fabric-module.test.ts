import { describe, it, expect, beforeEach } from 'vitest';
import { FabricObject } from 'fabric';
import { initFabricModule } from '../../src/fabric-module.js';

describe('initFabricModule', () => {
  beforeEach(() => {
    FabricObject.customProperties = [];
  });

  it('registers the `id` custom property', () => {
    initFabricModule();
    expect(FabricObject.customProperties).toContain('id');
  });

  it('is idempotent — does not duplicate `id`', () => {
    initFabricModule();
    initFabricModule();
    const idCount = (FabricObject.customProperties ?? []).filter((p) => p === 'id').length;
    expect(idCount).toBe(1);
  });

  it('merges `id` into existing custom properties instead of clobbering them', () => {
    FabricObject.customProperties = ['myCustomProp'];
    initFabricModule();
    expect(FabricObject.customProperties).toContain('myCustomProp');
    expect(FabricObject.customProperties).toContain('id');
  });
});
