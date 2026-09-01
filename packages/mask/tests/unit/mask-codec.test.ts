import { describe, it, expect } from 'vitest';
import {
  canonicalMaskCodec,
  cocoRleCodec,
  createMaskCodecRegistry,
  emptySnapshot,
  type MaskCodec,
} from '../../src/index.js';

describe('createMaskCodecRegistry', () => {
  it('resolves registered codecs by format', () => {
    const registry = createMaskCodecRegistry(canonicalMaskCodec, cocoRleCodec);
    expect(registry.get('osdlabel-mask')).toBe(canonicalMaskCodec);
    expect(registry.get('coco-rle')).toBe(cocoRleCodec);
    expect(registry.formats()).toEqual(['osdlabel-mask', 'coco-rle']);
  });

  it('returns undefined for an unknown format but throws from require', () => {
    const registry = createMaskCodecRegistry(canonicalMaskCodec);
    expect(registry.get('nope')).toBeUndefined();
    expect(() => registry.require('nope')).toThrow(/No mask codec registered for format 'nope'/);
  });

  it('accepts a consumer-supplied codec', () => {
    // An export-only codec: no decode, which the contract allows.
    const pixelCountCodec: MaskCodec<number> = {
      format: 'pixel-count',
      encode: (snapshot) => snapshot.data.length,
    };
    const registry = createMaskCodecRegistry(canonicalMaskCodec);
    registry.register(pixelCountCodec);

    expect(registry.require('pixel-count').encode(emptySnapshot(10, 10))).toBe(0);
  });

  it('lets a later registration replace an earlier one for the same format', () => {
    const registry = createMaskCodecRegistry(canonicalMaskCodec);
    const override: MaskCodec<string> = { format: 'osdlabel-mask', encode: () => 'stub' };
    registry.register(override);
    expect(registry.get('osdlabel-mask')).toBe(override);
  });
});
