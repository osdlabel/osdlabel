import { describe, expect, it } from 'vitest';
import { createImageId, type ImageSource } from '@osdlabel/viewer-api';
import type { AnnotationId } from '@osdlabel/annotation';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import type { OsdAnnotation } from 'osdlabel';
import {
  ANNOTATOR_EVENTS,
  OBSERVED_ATTRIBUTES,
  createAnnotatorEvent,
  defineOsdlabelAnnotator,
  groupAnnotationsByImage,
  isSameAnnotationSet,
  toPlainData,
  onAnnotatorEvent,
  parseBooleanAttribute,
  parseFilmstripPosition,
  type OsdlabelAnnotatorElement,
} from '../../src/index.js';

const annId = (s: string): AnnotationId => s as AnnotationId;

const rect = (id: string, image: string): OsdAnnotation => ({
  id: annId(id),
  imageId: createImageId(image),
  contextId: createAnnotationContextId('ctx'),
  toolType: 'rectangle',
  rawAnnotationData: { format: 'fabric', fabricVersion: 'test', data: { type: 'Rect' } },
  geometry: { type: 'rectangle', origin: { x: 0, y: 0 }, width: 1, height: 1, rotation: 0 },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('attribute parsing', () => {
  it('treats presence as true and an explicit "false" as false', () => {
    expect(parseBooleanAttribute('', false)).toBe(true);
    expect(parseBooleanAttribute('true', false)).toBe(true);
    expect(parseBooleanAttribute('FALSE', true)).toBe(false);
    expect(parseBooleanAttribute(null, true)).toBe(true);
    expect(parseBooleanAttribute(null, false)).toBe(false);
  });

  it('falls back to left for an unknown filmstrip position', () => {
    expect(parseFilmstripPosition('bottom')).toBe('bottom');
    expect(parseFilmstripPosition(' Right ')).toBe('right');
    expect(parseFilmstripPosition('diagonal')).toBe('left');
    expect(parseFilmstripPosition(null)).toBe('left');
  });

  it('observes every boolean attribute plus filmstrip-position', () => {
    expect(OBSERVED_ATTRIBUTES).toContain('show-filmstrip');
    expect(OBSERVED_ATTRIBUTES).toContain('test-mode');
    expect(OBSERVED_ATTRIBUTES).toContain('filmstrip-position');
  });
});

describe('groupAnnotationsByImage', () => {
  it('groups a flat list per image and keeps the last duplicate', () => {
    const a = rect('a', 'img1');
    const b = rect('b', 'img2');
    const a2 = { ...rect('a', 'img1'), label: 'second' };
    const grouped = groupAnnotationsByImage([a, b, a2]);
    expect(Object.keys(grouped).sort()).toEqual(['img1', 'img2']);
    expect(grouped[createImageId('img1')]![annId('a')]).toBe(a2);
    expect(grouped[createImageId('img2')]![annId('b')]).toBe(b);
  });

  it('returns an empty dictionary for an empty list', () => {
    expect(groupAnnotationsByImage([])).toEqual({});
  });
});

describe('isSameAnnotationSet', () => {
  it('matches on (image, id, updatedAt), ignoring order and identity', () => {
    const a = rect('a', 'img1');
    const b = rect('b', 'img1');
    expect(isSameAnnotationSet([a, b], [{ ...b }, { ...a }])).toBe(true);
  });

  it('sees a new revision, a different image, or a different count', () => {
    const a = rect('a', 'img1');
    expect(isSameAnnotationSet([a], [{ ...a, updatedAt: '2026-01-02T00:00:00.000Z' }])).toBe(false);
    expect(isSameAnnotationSet([a], [rect('a', 'img2')])).toBe(false);
    expect(isSameAnnotationSet([a], [a, rect('b', 'img1')])).toBe(false);
    expect(isSameAnnotationSet([], [])).toBe(true);
  });

  it('does not treat duplicates as a set match', () => {
    const a = rect('a', 'img1');
    expect(isSameAnnotationSet([a, a], [a, rect('b', 'img1')])).toBe(false);
  });
});

describe('toPlainData', () => {
  it('copies through a proxy into plain objects and arrays', () => {
    const source = { list: [rect('a', 'img1')], bytes: new Uint8Array([1, 2]) };
    // A proxy that, like Vue's, re-wraps every object it returns.
    const wrap = <T extends object>(t: T): T =>
      new Proxy(t, {
        get(target, key, receiver) {
          const v: unknown = Reflect.get(target, key, receiver);
          return typeof v === 'object' && v !== null && !ArrayBuffer.isView(v) ? wrap(v) : v;
        },
      });
    const copy = toPlainData(wrap(source));
    expect(copy).toEqual(source);
    expect(copy.list).not.toBe(source.list);
    expect(copy.bytes).not.toBe(source.bytes);
    expect(Array.isArray(copy.list)).toBe(true);
    expect(toPlainData(null)).toBeNull();
    expect(toPlainData('x')).toBe('x');
  });
});

describe('events', () => {
  it('uses lowercase dash-free names and never the native selectionchange', () => {
    for (const name of Object.values(ANNOTATOR_EVENTS)) {
      expect(name).toMatch(/^[a-z]+$/);
      expect(name).not.toBe('selectionchange');
    }
  });

  it('bubbles and carries its detail to a typed listener', () => {
    const target = document.createElement('div');
    const seen: number[] = [];
    const off = onAnnotatorEvent(target, 'annotationschange', (e) =>
      seen.push(e.detail.annotations.length),
    );
    target.dispatchEvent(
      createAnnotatorEvent('annotationschange', { annotations: [rect('a', 'i')] }),
    );
    off();
    target.dispatchEvent(createAnnotatorEvent('annotationschange', { annotations: [] }));
    expect(seen).toEqual([1]);
    expect(createAnnotatorEvent('osdlabelready', { renderedAt: 1 }).bubbles).toBe(true);
  });
});

describe('defineOsdlabelAnnotator', () => {
  it('is idempotent per tag', () => {
    const first = defineOsdlabelAnnotator({ tagName: 'osdlabel-test-a' });
    const second = defineOsdlabelAnnotator({ tagName: 'osdlabel-test-a' });
    expect(second).toBe(first);
    expect(customElements.get('osdlabel-test-a')).toBe(first);
  });

  it('upgrades a property a framework set before the element was defined', () => {
    // Vue / Svelte can create the element and assign properties before the
    // module calling define() has run; the write lands as an own property.
    const el = document.createElement('osdlabel-test-late');
    const images: readonly ImageSource[] = [{ id: createImageId('x'), tileSource: 'x.png' }];
    Object.assign(el, { images });
    defineOsdlabelAnnotator({ tagName: 'osdlabel-test-late' });
    customElements.upgrade(el);
    const upgraded = el as OsdlabelAnnotatorElement;
    expect(Object.prototype.hasOwnProperty.call(upgraded, 'images')).toBe(false);
    expect(upgraded.images).toBe(images);
  });

  it('holds annotations written before mount and reads back a detached copy', () => {
    defineOsdlabelAnnotator({ tagName: 'osdlabel-test-b' });
    const el = document.createElement('osdlabel-test-b') as OsdlabelAnnotatorElement;
    const list = [rect('a', 'img1')];
    el.annotations = list;
    expect(el.annotations).toEqual(list);
    expect(el.annotations).not.toBe(list);
    expect(el.activeTool).toBeNull();
    expect(el.selectedAnnotationId).toBeNull();
  });
});
