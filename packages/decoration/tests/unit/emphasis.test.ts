import { describe, it, expect, vi } from 'vitest';
import { withSelectionEmphasis } from '../../src/emphasis.js';
import type { DecorationProvider, DecorationContext } from '../../src/provider.js';
import type { Decoration } from '../../src/decoration.js';

import type { AnnotationId } from '@osdlabel/annotation';

const annId = (s: string): AnnotationId => s as AnnotationId;

describe('withSelectionEmphasis', () => {
  it('returns original decorations when no annotation is selected', () => {
    const baseDecorations: Decoration[] = [
      {
        id: '1',
        type: 'text',
        text: 'Label',
        relatedAnnotationIds: [annId('a1')],
        anchor: { x: 0, y: 0 },
      },
    ];
    const provider: DecorationProvider = vi.fn().mockReturnValue(baseDecorations);
    const wrapped = withSelectionEmphasis(provider, { selectedTextStyle: { zIndex: 10 } });

    const result = wrapped({ annotations: [], selectedAnnotationId: null });
    expect(result).toBe(baseDecorations);
  });

  it('returns original decorations when selected annotation is not related', () => {
    const baseDecorations: Decoration[] = [
      {
        id: '1',
        type: 'text',
        text: 'Label',
        relatedAnnotationIds: [annId('a1')],
        anchor: { x: 0, y: 0 },
      },
    ];
    const provider: DecorationProvider = vi.fn().mockReturnValue(baseDecorations);
    const wrapped = withSelectionEmphasis(provider, { selectedTextStyle: { zIndex: 10 } });

    const result = wrapped({ annotations: [], selectedAnnotationId: annId('a2') });
    expect(result).toBe(baseDecorations);
  });

  it('applies selectedTextStyle to text decorations related to the selected annotation', () => {
    const baseDecorations: Decoration[] = [
      {
        id: '1',
        type: 'text',
        text: 'A',
        relatedAnnotationIds: [annId('a1')],
        anchor: { x: 0, y: 0 },
        style: { color: 'red' },
      },
      {
        id: '2',
        type: 'text',
        text: 'B',
        relatedAnnotationIds: [annId('a2')],
        anchor: { x: 0, y: 0 },
      },
    ];
    const provider: DecorationProvider = vi.fn().mockReturnValue(baseDecorations);
    const wrapped = withSelectionEmphasis(provider, {
      selectedTextStyle: { zIndex: 10, color: 'blue' },
    });

    const result = wrapped({ annotations: [], selectedAnnotationId: annId('a1') });
    expect(result).not.toBe(baseDecorations);
    expect(result[0]).toEqual({
      id: '1',
      type: 'text',
      text: 'A',
      relatedAnnotationIds: [annId('a1')],
      anchor: { x: 0, y: 0 },
      style: { color: 'blue', zIndex: 10 },
    });
    expect(result[1]).toBe(baseDecorations[1]);
  });

  it('applies selectedLineStyle to line decorations related to the selected annotation', () => {
    const baseDecorations: Decoration[] = [
      {
        id: '1',
        type: 'line',
        start: { x: 0, y: 0 },
        end: { x: 1, y: 1 },
        relatedAnnotationIds: [annId('a1'), annId('a2')],
        style: { strokeWidth: 1 },
      },
    ];
    const provider: DecorationProvider = vi.fn().mockReturnValue(baseDecorations);
    const wrapped = withSelectionEmphasis(provider, {
      selectedLineStyle: { strokeWidth: 5, stroke: 'red' },
    });

    const result = wrapped({ annotations: [], selectedAnnotationId: annId('a2') });
    expect(result[0]).toEqual({
      id: '1',
      type: 'line',
      start: { x: 0, y: 0 },
      end: { x: 1, y: 1 },
      relatedAnnotationIds: [annId('a1'), annId('a2')],
      style: { strokeWidth: 5, stroke: 'red' },
    });
  });
});
