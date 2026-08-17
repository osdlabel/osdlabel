/**
 * `mousedown` handler that stops a click from parking keyboard focus on a
 * chrome button.
 *
 * Clicking a `<button>` focuses it, and a focused button is activated again by
 * `Enter` or `Space`. That is ordinary for a form, but wrong for an annotator
 * whose shortcuts are global and whose real focus context is the image: after
 * clicking Rotate, `Enter` rotates again; after clicking the fullscreen
 * toggle, `Enter` leaves fullscreen. `Enter` is also the polyline-finish
 * binding, so finishing a shape re-fires whichever control was last clicked.
 *
 * Preventing the default on `mousedown` stops the button taking focus in the
 * first place, which is the narrowest fix available:
 *
 * - the click still fires — `preventDefault` here suppresses focus, not
 *   activation;
 * - `Tab` still reaches the button, and `Enter` / `Space` still activate it
 *   once it is focused that way, so keyboard operation is untouched;
 * - focus stays wherever the user had it, rather than being moved and then
 *   yanked back by a `blur()`.
 *
 * Attach it once per toolbar container rather than per button — it only acts
 * when the press landed on or inside a button, so sibling controls that need
 * focus (a `<select>`, a text field) are unaffected.
 *
 * The parameter is structurally typed so both a DOM `MouseEvent` (Solid) and a
 * `React.MouseEvent` satisfy it.
 */
export function preventButtonFocusSteal(event: {
  readonly target: EventTarget | null;
  preventDefault: () => void;
}): void {
  if (event.target instanceof Element && event.target.closest('button')) {
    event.preventDefault();
  }
}
