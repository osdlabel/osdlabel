import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnnotationId } from '@osdlabel/annotation';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { createImageId } from '@osdlabel/viewer-api';
import {
  reportAnnotationRenderFailures,
  settleAnnotationObjects,
  warnAnnotationRenderError,
  type AnnotationRenderFailure,
} from '../../src/annotation-render-failure.js';
import { createAnnotationFromGeometry } from '../../src/create-annotation.js';

describe('settleAnnotationObjects', () => {
  // Plain stand-ins: the helper is generic, so its contract is checkable
  // without Fabric.
  const ids = ['a', 'b', 'c', 'd'] as const;

  it('returns every built object, in the annotations’ order', async () => {
    const settled = await settleAnnotationObjects(ids, async (id) => `obj-${id}`);

    expect(settled.objects).toEqual(['obj-a', 'obj-b', 'obj-c', 'obj-d']);
    expect(settled.failures).toEqual([]);
  });

  it('skips a failed build and keeps the rest (#209)', async () => {
    // With Promise.all, one rejection lost every object, and the cell showed
    // nothing for the image.
    const boom = new Error('cannot revive');
    const settled = await settleAnnotationObjects(ids, async (id) => {
      if (id === 'b') throw boom;
      return `obj-${id}`;
    });

    expect(settled.objects).toEqual(['obj-a', 'obj-c', 'obj-d']);
    expect(settled.failures).toEqual([{ annotation: 'b', error: boom }]);
  });

  it('reports every failure, each with its own annotation and error', async () => {
    const settled = await settleAnnotationObjects(ids, async (id) => {
      if (id === 'a' || id === 'd') throw new Error(`bad ${id}`);
      return `obj-${id}`;
    });

    expect(settled.objects).toEqual(['obj-b', 'obj-c']);
    expect(settled.failures.map((f) => f.annotation)).toEqual(['a', 'd']);
    expect(settled.failures.map((f) => (f.error as Error).message)).toEqual(['bad a', 'bad d']);
  });

  it('skips a null result without counting it as a failure', async () => {
    // `createFabricObjectFromRawData` resolves to null only for a non-Fabric
    // envelope: nothing to draw, but nothing went wrong either. A Fabric
    // payload that cannot be revived rejects instead, and is a failure.
    const settled = await settleAnnotationObjects(ids, async (id) =>
      id === 'c' ? null : `obj-${id}`,
    );

    expect(settled.objects).toEqual(['obj-a', 'obj-b', 'obj-d']);
    expect(settled.failures).toEqual([]);
  });

  it('settles with nothing for no annotations', async () => {
    const build = vi.fn(async () => 'never');
    const settled = await settleAnnotationObjects([], build);

    expect(settled).toEqual({ objects: [], failures: [] });
    expect(build).not.toHaveBeenCalled();
  });
});

describe('warnAnnotationRenderError', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names the annotation and its image, and passes the error on', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const annotation = createAnnotationFromGeometry(
      { type: 'rectangle', origin: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0 },
      {
        id: createAnnotationId('broken-1'),
        imageId: createImageId('image-7'),
        contextId: createAnnotationContextId('ctx'),
        toolType: 'rectangle',
      },
    );
    const error = new Error('cannot revive');

    warnAnnotationRenderError({ annotation, error });

    expect(warn).toHaveBeenCalledTimes(1);
    const [message, passed] = warn.mock.calls[0]!;
    expect(message).toContain('"broken-1"');
    expect(message).toContain('"image-7"');
    expect(passed).toBe(error);
  });
});

describe('reportAnnotationRenderFailures', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const failure = (id: string): AnnotationRenderFailure =>
    ({
      annotation: { id, imageId: 'image-1' },
      error: new Error(`bad ${id}`),
    }) as unknown as AnnotationRenderFailure;

  it('reports every failure in order', () => {
    const seen: string[] = [];
    reportAnnotationRenderFailures([failure('a'), failure('b')], (f) => seen.push(f.annotation.id));
    expect(seen).toEqual(['a', 'b']);
  });

  it('keeps reporting after a handler that throws, and logs what it threw', () => {
    // Inside the rebuild, a throw from the host's handler used to skip the
    // remaining failures and surface as an unhandled rejection.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handlerError = new Error('host handler bug');
    const seen: string[] = [];

    expect(() =>
      reportAnnotationRenderFailures([failure('a'), failure('b'), failure('c')], (f) => {
        seen.push(f.annotation.id);
        if (f.annotation.id === 'a') throw handlerError;
      }),
    ).not.toThrow();

    expect(seen).toEqual(['a', 'b', 'c']);
    expect(error).toHaveBeenCalledTimes(1);
    const [message, logged] = error.mock.calls[0]!;
    expect(message).toContain('"a"');
    expect(logged).toBe(handlerError);
  });
});
