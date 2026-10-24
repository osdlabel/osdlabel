/**
 * Design tokens for the stock annotator UI, as CSS custom properties.
 *
 * Each component reads a token through {@link themeVar}, which emits
 * `var(--osdlabel-<token>, <default>)`: the default is what the UI looked like
 * before tokens existed, so a host that sets nothing sees no change. Custom
 * properties inherit, including into a shadow root, so a host themes the
 * `<osdlabel-annotator>` element and both framework bindings the same way:
 *
 * ```css
 * .my-annotator { --osdlabel-accent: #e91e63; --osdlabel-radius: 0; }
 * ```
 *
 * Shared by both bindings, so the token set and every default live in one
 * place and cannot drift between them.
 */
export const OSDLABEL_THEME_TOKENS = {
  /** Root and toolbar-bar background. */
  surface: '#1a1a1a',
  /** Status bar background. */
  surfaceSunken: '#111',
  /** Popover background. Reserved: no component reads it yet (GridControls' popover is untokenized). */
  surfaceRaised: '#2a2a2a',
  /** Idle control (button) background. */
  control: '#333',
  /** Disabled control background. */
  controlDisabled: '#1a1a1a',
  /** Active tool, pressed toggles, selection. */
  accent: '#2196F3',
  /** Reserved: no component reads it yet. */
  border: '#444',
  text: '#fff',
  textMuted: '#aaa',
  textSubtle: '#bbb',
  textDisabled: '#666',
  /** Reserved: no component reads it yet. */
  danger: '#d32f2f',
  fontFamily: 'system-ui, sans-serif',
  fontSizeControl: '13px',
  fontSizeStatus: '12px',
  radius: '4px',
  controlPadding: '4px 10px',
  gap: '4px',
  /** Reserved: no component reads it yet. */
  shadowPopover: '0 4px 6px rgba(0,0,0,0.3)',
} as const;

export type OsdlabelThemeToken = keyof typeof OSDLABEL_THEME_TOKENS;

/** A partial theme: token → CSS value. */
export type OsdlabelTheme = Partial<Record<OsdlabelThemeToken, string>>;

/** `fontSizeControl` → `--osdlabel-font-size-control`. */
export function themeTokenProperty(token: OsdlabelThemeToken): `--osdlabel-${string}` {
  return `--osdlabel-${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** `var(--osdlabel-<token>, <default>)`, for an inline style value. */
export function themeVar(token: OsdlabelThemeToken): string {
  return `var(${themeTokenProperty(token)}, ${OSDLABEL_THEME_TOKENS[token]})`;
}

/**
 * A theme object as custom-property declarations, for a host that prefers to
 * pass a theme in code (`style={themeToCustomProperties(theme)}`) over CSS.
 */
export function themeToCustomProperties(theme: OsdlabelTheme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [token, value] of Object.entries(theme) as [OsdlabelThemeToken, string][]) {
    out[themeTokenProperty(token)] = value;
  }
  return out;
}
