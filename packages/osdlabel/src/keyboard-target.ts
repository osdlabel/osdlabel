/**
 * The parts of a key event's target that decide whether a global keyboard
 * shortcut may act on the key.
 *
 * Structural rather than `HTMLElement`, so any DOM element satisfies it and the
 * rule can be unit-tested without a DOM.
 */
export interface KeyboardShortcutTarget {
  readonly tagName: string;
  readonly isContentEditable: boolean;
  getAttribute(name: string): string | null;
}

/** The keys a focused button activates on, natively. */
const BUTTON_ACTIVATION_KEYS: ReadonlySet<string> = new Set(['Enter', ' ']);

/**
 * Narrows to an object whose shortcut-relevant fields are read defensively.
 * Every field is optional here: each is checked before use, so a partial
 * target (a test double, or a non-element `EventTarget`) is handled field by
 * field rather than rejected wholesale.
 */
function isObjectTarget(target: unknown): target is Partial<KeyboardShortcutTarget> {
  return typeof target === 'object' && target !== null;
}

/**
 * Whether the annotator's global keyboard shortcuts must leave this key to the
 * element it was pressed on.
 *
 * - **Text entry** (`<input>`, `<textarea>`, contenteditable) owns every key.
 * - **A focused button** (`<button>` or `role="button"`) owns Enter and Space,
 *   which the browser turns into a click on it. The shortcuts must not act on
 *   the same keypress: `Enter` is the default polyline-finish binding, so
 *   activating the filmstrip's clear button from the keyboard used to finish an
 *   in-progress polyline *and* empty the cell (#189). Other keys still reach
 *   the shortcuts from a focused button, so tabbing through the toolbar does
 *   not disable `r`, `Delete` or the grid digits.
 *
 * Two things keep the button rule from catching a key meant for the image: a
 * mouse click does not leave focus on the annotator's chrome buttons
 * (`preventButtonFocusSteal`), and a press on the image moves focus to the
 * viewer (`FabricOverlay`), so a button picked from the keyboard loses focus
 * once the user starts drawing with the mouse. What remains is a user whose
 * focus is genuinely on a button, for whom Enter or Space means "press it".
 *
 * Shared by the SolidJS and React keyboard hooks so the two cannot disagree.
 */
export function shouldSkipKeyboardShortcut(
  target: KeyboardShortcutTarget | EventTarget | null,
  key: string,
): boolean {
  if (!isObjectTarget(target)) return false;
  const tag = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable === true) {
    return true;
  }
  if (!BUTTON_ACTIVATION_KEYS.has(key)) return false;
  if (tag === 'BUTTON') return true;
  return typeof target.getAttribute === 'function' && target.getAttribute('role') === 'button';
}
