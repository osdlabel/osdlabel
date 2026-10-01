import type { DecorationProvider } from './provider.js';
import type { TextDecorationStyle, LineDecorationStyle } from './decoration.js';

export interface SelectionEmphasisOptions {
  /** Style overrides applied to text decorations associated with the selected annotation. */
  readonly selectedTextStyle?: Partial<TextDecorationStyle> | undefined;
  /** Style overrides applied to line decorations associated with the selected annotation. */
  readonly selectedLineStyle?: Partial<LineDecorationStyle> | undefined;
}

/**
 * Wraps a decoration provider to apply emphasis styling to decorations
 * associated with the currently selected annotation.
 *
 * It checks if `DecorationContext.selectedAnnotationId` is present in the
 * decoration's `relatedAnnotationIds`. If so, it merges the provided styles
 * into the decoration's style object.
 *
 * @param provider The base provider to wrap.
 * @param options The style overrides to apply when selected.
 */
export function withSelectionEmphasis<E extends object = Record<never, never>>(
  provider: DecorationProvider<E>,
  options: SelectionEmphasisOptions,
): DecorationProvider<E> {
  return (ctx) => {
    const decorations = provider(ctx);
    const selectedId = ctx.selectedAnnotationId;
    if (!selectedId) return decorations;

    const idx = decorations.findIndex((d) => d.relatedAnnotationIds.includes(selectedId));
    if (idx === -1) return decorations;

    const next = [...decorations];
    for (let i = idx; i < next.length; i++) {
      const dec = next[i]!;
      if (!dec.relatedAnnotationIds.includes(selectedId)) continue;

      if (dec.type === 'text' && options.selectedTextStyle) {
        next[i] = {
          ...dec,
          style: { ...dec.style, ...options.selectedTextStyle },
        };
      } else if (dec.type === 'line' && options.selectedLineStyle) {
        next[i] = {
          ...dec,
          style: { ...dec.style, ...options.selectedLineStyle },
        };
      }
    }
    return next;
  };
}
