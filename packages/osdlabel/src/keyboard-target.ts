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

const ENTER_AND_SPACE: ReadonlySet<string> = new Set(['Enter', ' ']);
const ENTER: ReadonlySet<string> = new Set(['Enter']);
const NONE: ReadonlySet<string> = new Set();

/**
 * The keys a focused control acts on natively, by kind of control:
 *
 * - a button (`<button>`, `role="button"`) is pressed by Enter and Space;
 * - a `<summary>` toggles its `<details>` on Enter and Space;
 * - a `<select>` opens on Space, and on Enter (Return) on macOS;
 * - a link (`<a href>`, `role="link"`) is followed on Enter (Space scrolls).
 */
function activationKeys(tag: string, role: string | null, hasHref: boolean): ReadonlySet<string> {
  if (tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'SELECT' || role === 'button') {
    return ENTER_AND_SPACE;
  }
  if ((tag === 'A' && hasHref) || role === 'link') return ENTER;
  return NONE;
}

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
 * - **Other focused controls** own the keys they act on in the same way: Enter
 *   and Space on a `<summary>` or a `<select>`, and Enter on a link (`<a href>`
 *   or `role="link"`) (#205).
 *
 * Two things keep these rules from catching a key meant for the image: a
 * mouse click does not leave focus on the annotator's chrome buttons
 * (`preventButtonFocusSteal`), and a drawing or selecting press on the image
 * moves focus to the viewer (`FabricOverlay`), so a button picked from the keyboard loses focus
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
  const getAttribute =
    typeof target.getAttribute === 'function' ? target.getAttribute.bind(target) : undefined;
  const role = getAttribute?.('role') ?? null;
  const hasHref = (getAttribute?.('href') ?? null) !== null;
  return activationKeys(tag, role, hasHref).has(key);
}
