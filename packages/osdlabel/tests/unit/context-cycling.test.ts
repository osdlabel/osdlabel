import { describe, expect, it } from 'vitest';
import type { AnnotationContext, AnnotationContextId } from '@osdlabel/annotation-context';
import type { ImageId } from '@osdlabel/viewer-api';
import { getCycledContextId, getSelectableContexts } from '../../src/context-cycling.js';

const ctxId = (s: string): AnnotationContextId => s as AnnotationContextId;
const imgId = (s: string): ImageId => s as ImageId;

const makeContext = (id: string, imageIds?: readonly ImageId[]): AnnotationContext => ({
  id: ctxId(id),
  label: id,
  tools: [],
  ...(imageIds !== undefined ? { imageIds } : {}),
});

const A = makeContext('a');
const B = makeContext('b');
const C = makeContext('c');
const ALL = [A, B, C] as const;

describe('getSelectableContexts', () => {
  it('returns every context when there is no active image', () => {
    expect(getSelectableContexts(ALL, undefined)).toEqual([A, B, C]);
  });

  it('keeps unscoped contexts and contexts scoped to the active image', () => {
    const scoped = makeContext('scoped', [imgId('img-1')]);
    const other = makeContext('other', [imgId('img-2')]);
    expect(getSelectableContexts([A, scoped, other], imgId('img-1'))).toEqual([A, scoped]);
  });

  it('drops contexts scoped to no images at all', () => {
    const disabled = makeContext('disabled', []);
    expect(getSelectableContexts([A, disabled], imgId('img-1'))).toEqual([A]);
  });
});

describe('getCycledContextId', () => {
  it('steps forward through the configured order', () => {
    expect(getCycledContextId(ALL, ctxId('a'), 'next', undefined)).toBe('b');
    expect(getCycledContextId(ALL, ctxId('b'), 'next', undefined)).toBe('c');
  });

  it('steps backward through the configured order', () => {
    expect(getCycledContextId(ALL, ctxId('c'), 'previous', undefined)).toBe('b');
    expect(getCycledContextId(ALL, ctxId('b'), 'previous', undefined)).toBe('a');
  });

  it('wraps around at both ends', () => {
    expect(getCycledContextId(ALL, ctxId('c'), 'next', undefined)).toBe('a');
    expect(getCycledContextId(ALL, ctxId('a'), 'previous', undefined)).toBe('c');
  });

  it('enters the ring at the end the direction implies when nothing is active', () => {
    expect(getCycledContextId(ALL, null, 'next', undefined)).toBe('a');
    expect(getCycledContextId(ALL, null, 'previous', undefined)).toBe('c');
  });

  it('enters the ring at an end when the active context is scoped out', () => {
    const scopedOut = makeContext('scoped-out', [imgId('other-img')]);
    const contexts = [A, scopedOut, C];
    expect(getCycledContextId(contexts, ctxId('scoped-out'), 'next', imgId('img-1'))).toBe('a');
    expect(getCycledContextId(contexts, ctxId('scoped-out'), 'previous', imgId('img-1'))).toBe('c');
  });

  it('skips contexts that are not scoped to the active image', () => {
    const scopedOut = makeContext('scoped-out', [imgId('other-img')]);
    const contexts = [A, scopedOut, C];
    expect(getCycledContextId(contexts, ctxId('a'), 'next', imgId('img-1'))).toBe('c');
    expect(getCycledContextId(contexts, ctxId('c'), 'next', imgId('img-1'))).toBe('a');
  });

  it('returns null when there is nothing selectable', () => {
    expect(getCycledContextId([], null, 'next', undefined)).toBeNull();
    expect(
      getCycledContextId([makeContext('only', [imgId('elsewhere')])], null, 'next', imgId('img-1')),
    ).toBeNull();
  });

  it('returns the sole context unchanged when the ring has one entry', () => {
    expect(getCycledContextId([A], ctxId('a'), 'next', undefined)).toBe('a');
    expect(getCycledContextId([A], ctxId('a'), 'previous', undefined)).toBe('a');
  });
});
