import { describe, expect, it } from 'vitest';
import type {
  Decoration,
  DecorationProvider,
  DomDecoration,
  TextDecoration,
} from '../../src/index.js';
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

  it('passes DOM decorations through withSelectionEmphasis by reference', () => {
    // Emphasis only restyles `text` and `line` decorations, so a `dom` one must
    // come back as the *same object* even when it relates to the selection.
    // Reference matters, not structure: DecorationLayer and the framework memos
    // downstream compare by identity, so a needless copy busts them every frame.
    const stable: readonly Decoration[] = [
      {
        type: 'dom',
        id: 'panel:a',
        relatedAnnotationIds: [annId('a')],
        anchor: { x: 3, y: 4 },
        content: { annotationId: annId('a') },
      },
      {
        type: 'text',
        id: 'text:b',
        relatedAnnotationIds: [annId('b')],
        anchor: { x: 9, y: 9 },
        text: 'B',
      },
    ];
    const fixed: DecorationProvider<NoExt> = () => stable;
    const wrapped = withSelectionEmphasis<NoExt>(fixed, { selectedTextStyle: { zIndex: 99 } });

    const result = wrapped(ctx([p1, p2], { selectedAnnotationId: annId('a') }));

    expect(result[0]).toBe(stable[0]);
    expect(result[1]).toBe(stable[1]);
  });

  it('elevates a related text decoration while keeping the others identical', () => {
    const stable: readonly Decoration[] = [
      {
        type: 'dom',
        id: 'panel:a',
        relatedAnnotationIds: [annId('a')],
        anchor: { x: 3, y: 4 },
        content: { annotationId: annId('a') },
      },
      {
        type: 'text',
        id: 'text:a',
        relatedAnnotationIds: [annId('a')],
        anchor: { x: 3, y: 4 },
        text: 'A',
      },
      {
        type: 'text',
        id: 'text:b',
        relatedAnnotationIds: [annId('b')],
        anchor: { x: 9, y: 9 },
        text: 'B',
      },
    ];
    const fixed: DecorationProvider<NoExt> = () => stable;
    const wrapped = withSelectionEmphasis<NoExt>(fixed, { selectedTextStyle: { zIndex: 99 } });

    const result = wrapped(ctx([p1, p2], { selectedAnnotationId: annId('a') }));

    // The related text decoration is replaced with a styled copy...
    expect(result[1]).not.toBe(stable[1]);
    expect((result[1] as TextDecoration).style?.zIndex).toBe(99);
    // ...while the DOM decoration (not restyled) and the unrelated text
    // decoration keep their identity.
    expect(result[0]).toBe(stable[0]);
    expect(result[2]).toBe(stable[2]);
  });

  it('returns the provider output unchanged when nothing is selected', () => {
    const stable: readonly Decoration[] = [
      {
        type: 'text',
        id: 't',
        relatedAnnotationIds: [annId('a')],
        anchor: { x: 0, y: 0 },
        text: 'A',
      },
    ];
    const wrapped = withSelectionEmphasis<NoExt>(() => stable, {
      selectedTextStyle: { zIndex: 9 },
    });
    expect(wrapped(ctx([p1], { selectedAnnotationId: null }))).toBe(stable);
  });

  it('gives built-in providers stable ids across runs so the renderer can diff', () => {
    // DecorationLayer diffs by id, so an id that varies per invocation would
    // force a full teardown and rebuild every frame. Asserted against the real
    // createLabelProvider — asserting it of the test's own panelProvider would
    // only be testing the fixture.
    const provider = createLabelProvider<NoExt>();
    const first = provider(ctx([p1, p2])).map((d) => d.id);
    const second = provider(ctx([p1, p2])).map((d) => d.id);
    expect(first).toHaveLength(2);
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
  });

  it('anchors built-in decorations at the annotation geometry', () => {
    const moved = ann('a', 'point', { type: 'point', position: { x: 50, y: 60 } }, 'Moved');
    const [d] = createLabelProvider<NoExt>()(ctx([moved]));
    expect((d as TextDecoration).anchor).toEqual({ x: 50, y: 60 });
  });
});
