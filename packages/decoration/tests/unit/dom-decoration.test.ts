import { describe, expect, it } from 'vitest';
import type { DecorationProvider, DomDecoration, TextDecoration } from '../../src/index.js';
import { composeProviders, createLabelProvider, withSelectionEmphasis } from '../../src/index.js';
import { ann, annId, ctx, type NoExt } from './test-helpers.js';

/**
 * A consumer-authored provider of the kind `DomDecoration` exists to support:
 * one interactive panel anchored at each point annotation.
 */
const panelProvider: DecorationProvider<NoExt> = ({ annotations }) =>
  annotations.map(
    (a): DomDecoration => ({
      type: 'dom',
      id: `panel:${a.id}`,
      relatedAnnotationIds: [a.id],
      anchor: a.geometry.type === 'point' ? a.geometry.position : { x: 0, y: 0 },
      content: { annotationId: a.id, label: a.label },
    }),
  );

describe('DomDecoration through the real provider pipeline', () => {
  const p1 = ann('a', 'point', { type: 'point', position: { x: 3, y: 4 } }, 'Cell');
  const p2 = ann('b', 'point', { type: 'point', position: { x: 9, y: 9 } }, 'Other');

  it('survives composeProviders alongside a built-in provider', () => {
    // composeProviders is the real seam a consumer uses to add a DOM provider to
    // the built-ins, so exercise it rather than calling the provider directly.
    const composed = composeProviders<NoExt>([createLabelProvider<NoExt>(), panelProvider]);
    const result = composed(ctx([p1, p2]));

    const dom = result.filter((d): d is DomDecoration => d.type === 'dom');
    const text = result.filter((d): d is TextDecoration => d.type === 'text');
    expect(dom).toHaveLength(2);
    expect(text).toHaveLength(2);

    // Flat-map ordering: all of provider 1's output, then all of provider 2's.
    expect(result.slice(0, 2).every((d) => d.type === 'text')).toBe(true);
    expect(result.slice(2).every((d) => d.type === 'dom')).toBe(true);

    expect(dom[0]!.anchor).toEqual({ x: 3, y: 4 });
    expect(dom[0]!.content).toEqual({ annotationId: annId('a'), label: 'Cell' });
  });

  it('composeProviders over an empty list yields no decorations', () => {
    expect(composeProviders<NoExt>([])(ctx([p1]))).toEqual([]);
  });

  it('is carried through withSelectionEmphasis untouched when unrelated', () => {
    // withSelectionEmphasis only elevates decorations whose relatedAnnotationIds
    // include the selection; a DOM decoration for another annotation must come
    // back by reference, or every downstream memo busts on each selection change.
    const wrapped = withSelectionEmphasis<NoExt>(panelProvider, {
      selectedTextStyle: { zIndex: 99 },
    });
    const plain = panelProvider(ctx([p1, p2], { selectedAnnotationId: annId('a') }));
    const emphasised = wrapped(ctx([p1, p2], { selectedAnnotationId: annId('a') }));

    expect(emphasised).toHaveLength(2);
    // 'b' is unrelated to the selection, so its decoration is structurally equal.
    expect(emphasised[1]).toEqual(plain[1]);
  });

  it('produces stable ids across runs so the renderer can diff in place', () => {
    // DecorationLayer diffs by id; an id that varies per invocation would make
    // every frame a full teardown and rebuild.
    const first = panelProvider(ctx([p1, p2])).map((d) => d.id);
    const second = panelProvider(ctx([p1, p2])).map((d) => d.id);
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
  });

  it('anchors at the annotation geometry, not a fixed origin', () => {
    const moved = ann('a', 'point', { type: 'point', position: { x: 50, y: 60 } });
    const [d] = panelProvider(ctx([moved]));
    expect((d as DomDecoration).anchor).toEqual({ x: 50, y: 60 });
  });
});
