import { describe, expect, it, vi } from 'vitest';
import type {
  Decoration,
  DecorationAnchorSpace,
  DomDecoration,
  LineDecoration,
  TextDecoration,
  TextPlacement,
} from '../../src/decoration.js';
import { composeProviders } from '../../src/provider.js';
import type { DecorationProvider } from '../../src/provider.js';
import { withSelectionEmphasis } from '../../src/emphasis.js';
import { annId, ctx } from './test-helpers.js';
import type { NoExt } from './test-helpers.js';

const ALL_PLACEMENTS = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'center',
  'top',
  'bottom',
  'left',
  'right',
] as const satisfies readonly TextPlacement[];

describe('DecorationAnchorSpace (D1: type-level)', () => {
  it('accepts anchorSpace + every placement on TextDecoration and DomDecoration', () => {
    const texts: readonly TextDecoration[] = ALL_PLACEMENTS.map((placement, i) => ({
      type: 'text',
      id: `t${i}`,
      relatedAnnotationIds: [annId('a1')],
      text: 'hud',
      anchor: { x: 1, y: 0 },
      anchorSpace: 'cell',
      placement,
    }));
    const doms: readonly DomDecoration[] = ALL_PLACEMENTS.map((placement, i) => ({
      type: 'dom',
      id: `d${i}`,
      relatedAnnotationIds: [annId('a1')],
      anchor: { x: 1, y: 0 },
      anchorSpace: 'cell',
      placement,
      content: { i },
    }));

    // Runtime no-op assertions so the compile-time coverage above has a body.
    expect(texts).toHaveLength(ALL_PLACEMENTS.length);
    expect(doms).toHaveLength(ALL_PLACEMENTS.length);
    expect(texts.every((t) => t.anchorSpace === 'cell')).toBe(true);
    expect(doms.every((d) => d.anchorSpace === 'cell')).toBe(true);
  });

  it('accepts both members of the DecorationAnchorSpace union and an omitted anchorSpace', () => {
    const spaces: readonly DecorationAnchorSpace[] = ['image', 'cell'];
    const withImage: TextDecoration = {
      type: 'text',
      id: 'img',
      relatedAnnotationIds: [],
      text: 'x',
      anchor: { x: 0, y: 0 },
      anchorSpace: spaces[0]!,
    };
    const omitted: TextDecoration = {
      type: 'text',
      id: 'omitted',
      relatedAnnotationIds: [],
      text: 'x',
      anchor: { x: 0, y: 0 },
    };
    expect(withImage.anchorSpace).toBe('image');
    expect(omitted.anchorSpace).toBeUndefined();
  });

  it('rejects anchorSpace on LineDecoration', () => {
    const line: LineDecoration = {
      type: 'line',
      id: 'l1',
      relatedAnnotationIds: [],
      start: { x: 0, y: 0 },
      end: { x: 1, y: 1 },
      // @ts-expect-error `anchorSpace` is only meaningful for anchored DOM decorations.
      anchorSpace: 'cell',
    };
    expect(line.type).toBe('line');
  });
});

describe('withSelectionEmphasis with cell-space decorations (D2)', () => {
  it('preserves anchorSpace and placement while elevating the selected decoration', () => {
    const selected = annId('a1');
    const hud: TextDecoration = {
      type: 'text',
      id: 'hud',
      relatedAnnotationIds: [selected],
      text: 'ratio',
      anchor: { x: 1, y: 0 },
      anchorSpace: 'cell',
      placement: 'top-right',
      style: { color: 'red' },
    };
    const domHud: DomDecoration = {
      type: 'dom',
      id: 'dom-hud',
      relatedAnnotationIds: [selected],
      anchor: { x: 0, y: 1 },
      anchorSpace: 'cell',
      placement: 'bottom-left',
      content: { kind: 'panel' },
    };
    const other: TextDecoration = {
      type: 'text',
      id: 'other',
      relatedAnnotationIds: [annId('a2')],
      text: 'other',
      anchor: { x: 5, y: 5 },
      placement: 'center',
    };
    const base: readonly Decoration[] = [hud, domHud, other];
    const provider: DecorationProvider<NoExt> = () => base;
    const wrapped = withSelectionEmphasis<NoExt>(provider, {
      selectedTextStyle: { zIndex: 99 },
    });

    const result = wrapped(ctx([], { selectedAnnotationId: selected }));
    const [nextHud, nextDomHud, nextOther] = result;

    expect(nextHud).toBeDefined();
    expect(nextHud!.type).toBe('text');
    const hudText = nextHud as TextDecoration;
    expect(hudText.anchorSpace).toBe('cell');
    expect(hudText.placement).toBe('top-right');
    expect(hudText.anchor).toEqual({ x: 1, y: 0 });
    expect(hudText.style).toEqual({ color: 'red', zIndex: 99 });

    // DOM decorations carry no emphasis option, so they pass through untouched
    // — which also means their anchorSpace/placement survive by identity.
    expect(nextDomHud).toBe(domHud);
    expect((nextDomHud as DomDecoration).anchorSpace).toBe('cell');
    expect((nextDomHud as DomDecoration).placement).toBe('bottom-left');

    // Unrelated decorations stay referentially identical (identity rule).
    expect(nextOther).toBe(other);
  });
});

describe('composeProviders with cell-space decorations (D3)', () => {
  it('passes cell-space decorations through unchanged (identity)', () => {
    const hud: TextDecoration = {
      type: 'text',
      id: 'hud',
      relatedAnnotationIds: [],
      text: 'ratio',
      anchor: { x: 1, y: 0 },
      anchorSpace: 'cell',
      placement: 'top-right',
      offset: { x: -8, y: 8 },
    };
    const domHud: DomDecoration = {
      type: 'dom',
      id: 'dom-hud',
      relatedAnnotationIds: [],
      anchor: { x: 0, y: 0 },
      anchorSpace: 'cell',
      content: null,
    };
    const a: DecorationProvider<NoExt> = vi.fn(() => [hud]);
    const b: DecorationProvider<NoExt> = vi.fn(() => [domHud]);

    const result = composeProviders<NoExt>([a, b])(ctx([]));

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(hud);
    expect(result[1]).toBe(domHud);
  });
});
