import { describe, it, expect, afterEach } from 'vitest';
import { createAnnotationId } from '@osdlabel/annotation';
import { renderAnnotator } from './render-annotator.js';
import { unmountAll } from './mount.js';
import { imageId, rect } from './fixtures.js';

/**
 * The React counterpart of Solid's `benchmark.test.ts`: `changeCounter` moves
 * once per committed annotation mutation, which is what the provider's
 * `onAnnotationsChange` effect keys on. Solid's last test, which times the
 * counter against `JSON.stringify`, is not ported: it measures the shared
 * reducer, not anything in this binding.
 */
describe('version counter', () => {
  afterEach(unmountAll);

  it('starts at zero', () => {
    const h = renderAnnotator();
    expect(h.current.annotationState.changeCounter).toBe(0);
  });

  it('increments once per addAnnotation', () => {
    const h = renderAnnotator();
    h.run((a) => a.addAnnotation(rect('ann0')));
    expect(h.current.annotationState.changeCounter).toBe(1);
    h.run((a) => a.addAnnotation(rect('ann1')));
    expect(h.current.annotationState.changeCounter).toBe(2);
  });

  it('increments on updateAnnotation', () => {
    const h = renderAnnotator();
    h.run((a) => a.addAnnotation(rect('ann0')));
    const before = h.current.annotationState.changeCounter;
    h.run((a) => a.updateAnnotation(createAnnotationId('ann0'), imageId, { label: 'updated' }));
    expect(h.current.annotationState.changeCounter).toBe(before + 1);
  });

  it('increments on deleteAnnotation', () => {
    const h = renderAnnotator();
    h.run((a) => a.addAnnotation(rect('ann0')));
    const before = h.current.annotationState.changeCounter;
    h.run((a) => a.deleteAnnotation(createAnnotationId('ann0'), imageId));
    expect(h.current.annotationState.changeCounter).toBe(before + 1);
  });

  it('increments on loadAnnotations', () => {
    const h = renderAnnotator();
    const before = h.current.annotationState.changeCounter;
    h.run((a) => a.loadAnnotations({}));
    expect(h.current.annotationState.changeCounter).toBe(before + 1);
  });
});
