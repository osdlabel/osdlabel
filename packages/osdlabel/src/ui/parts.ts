/**
 * `part` names on the stock UI's elements, for `::part()` styling of the
 * `<osdlabel-annotator>` element (`osdlabel-annotator::part(tool-button) {…}`)
 * and as stable hooks for light-DOM CSS (`[part~="tool-button"]`) in the
 * framework bindings. Each element also carries the class twin of its parts
 * ({@link partClassName}). In light DOM these hooks override a property only
 * where the stock UI does not set it inline: the toolbar's styles live in
 * the `@layer osdlabel` stylesheet (`stock-styles.ts`), so every hook works
 * there; the other components are still inline-styled.
 *
 * State is a second part name rather than a pseudo-class, since `::part()`
 * cannot be combined with attribute selectors on the part:
 * `::part(tool-button-active)`.
 */
export const OSDLABEL_PARTS = {
  root: 'root',
  toolbarBar: 'toolbar-bar',
  toolbar: 'toolbar',
  toolButton: 'tool-button',
  toolButtonActive: 'tool-button-active',
  toolButtonDisabled: 'tool-button-disabled',
  brushOptions: 'brush-options',
  brushLabel: 'brush-label',
  brushRadius: 'brush-radius',
  brushRadiusValue: 'brush-radius-value',
  statusBar: 'status-bar',
} as const;

export type OsdlabelPart = (typeof OSDLABEL_PARTS)[keyof typeof OSDLABEL_PARTS];

/** The `part` attribute value for a tool button in the given state. */
export function toolButtonPart(state: {
  readonly active: boolean;
  readonly enabled: boolean;
}): string {
  const parts: string[] = [OSDLABEL_PARTS.toolButton];
  if (state.active) parts.push(OSDLABEL_PARTS.toolButtonActive);
  if (!state.enabled) parts.push(OSDLABEL_PARTS.toolButtonDisabled);
  return parts.join(' ');
}

/**
 * The class names twinned with a `part` value: `osdlabel-` + each part name,
 * e.g. `'tool-button tool-button-active'` → `'osdlabel-tool-button
 * osdlabel-tool-button-active'`. The stock stylesheet selects on these.
 */
export function partClassName(part: string): string {
  return part
    .split(' ')
    .filter((p) => p.length > 0)
    .map((p) => `osdlabel-${p}`)
    .join(' ');
}
