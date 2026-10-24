/**
 * `part` names on the stock UI's elements, for `::part()` styling of the
 * `<osdlabel-annotator>` element (`osdlabel-annotator::part(tool-button) {…}`)
 * and as stable hooks for light-DOM CSS (`[part~="tool-button"]`) in the
 * framework bindings, which render no classes.
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
