/**
 * HTML attribute → property parsing for `<osdlabel-annotator>`.
 *
 * Only scalar settings are attributes. Structured inputs (images, contexts,
 * annotations, decoration providers) are properties only: serialising them
 * through attributes would mean JSON in markup, and functions (decoration
 * providers) cannot round-trip at all.
 */

/**
 * Boolean attributes the element observes, with the default each one has when absent.
 *
 * Every one is live except `test-mode`, which the Solid provider (and each
 * overlay it creates) reads once at mount: set it before the element connects.
 * Of the properties, `images`, `contexts`, `annotations`, `displayedContextIds`,
 * `decorationProviders` and `keyboardShortcuts` are all live after mount.
 */
export const BOOLEAN_ATTRIBUTES = {
  'show-filmstrip': true,
  'show-grid-controls': false,
  'show-context-switcher': false,
  'show-view-controls': true,
  'show-fullscreen-control': true,
  'show-fps': false,
  'test-mode': false,
} as const;

export type BooleanAttributeName = keyof typeof BOOLEAN_ATTRIBUTES;

export const FILMSTRIP_POSITIONS = ['left', 'right', 'bottom'] as const;
export type FilmstripPosition = (typeof FILMSTRIP_POSITIONS)[number];

export const OBSERVED_ATTRIBUTES: readonly string[] = [
  ...Object.keys(BOOLEAN_ATTRIBUTES),
  'filmstrip-position',
];

export function isBooleanAttributeName(name: string): name is BooleanAttributeName {
  return Object.prototype.hasOwnProperty.call(BOOLEAN_ATTRIBUTES, name);
}

/**
 * HTML's boolean-attribute rule, plus an explicit `"false"`, which frameworks
 * emit when they bind a boolean to an attribute (`show-filmstrip="false"`)
 * and which a plain presence test would read as true.
 */
export function parseBooleanAttribute(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  return value.trim().toLowerCase() !== 'false';
}

/** An unknown value falls back to the default rather than throwing from `attributeChangedCallback`. */
export function parseFilmstripPosition(value: string | null): FilmstripPosition {
  const v = value?.trim().toLowerCase();
  return FILMSTRIP_POSITIONS.find((p) => p === v) ?? 'left';
}
