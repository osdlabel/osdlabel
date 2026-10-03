import { describe, expect, it } from 'vitest';
import {
  shouldSkipKeyboardShortcut,
  type KeyboardShortcutTarget,
} from '../../src/keyboard-target.js';

const el = (
  tagName: string,
  opts: { readonly role?: string; readonly href?: string; readonly contentEditable?: boolean } = {},
): KeyboardShortcutTarget => ({
  tagName,
  isContentEditable: opts.contentEditable ?? false,
  getAttribute: (name: string) =>
    name === 'role' ? (opts.role ?? null) : name === 'href' ? (opts.href ?? null) : null,
});

describe('shouldSkipKeyboardShortcut', () => {
  it('leaves every key to text entry', () => {
    for (const key of ['r', 'Enter', ' ', 'Delete', 'Escape', '1']) {
      expect(shouldSkipKeyboardShortcut(el('INPUT'), key)).toBe(true);
      expect(shouldSkipKeyboardShortcut(el('TEXTAREA'), key)).toBe(true);
      expect(shouldSkipKeyboardShortcut(el('DIV', { contentEditable: true }), key)).toBe(true);
    }
  });

  it('leaves Enter and Space to a focused <button> (#189)', () => {
    // Enter is the default polyline-finish binding: without this, activating a
    // focused button also finished an in-progress polyline.
    expect(shouldSkipKeyboardShortcut(el('BUTTON'), 'Enter')).toBe(true);
    expect(shouldSkipKeyboardShortcut(el('BUTTON'), ' ')).toBe(true);
  });

  it('treats role="button" like a native button', () => {
    expect(shouldSkipKeyboardShortcut(el('DIV', { role: 'button' }), 'Enter')).toBe(true);
    expect(shouldSkipKeyboardShortcut(el('DIV', { role: 'button' }), ' ')).toBe(true);
  });

  it('still lets other keys through from a focused button', () => {
    // Tabbing through the toolbar must not disable the tool, delete and grid
    // shortcuts: only the keys the button itself activates on are its own.
    for (const key of ['r', 'Delete', 'Backspace', 'Escape', '1', 'R']) {
      expect(shouldSkipKeyboardShortcut(el('BUTTON'), key)).toBe(false);
    }
  });

  it('lets every key through from non-interactive elements', () => {
    for (const key of ['Enter', ' ', 'r', 'Escape']) {
      expect(shouldSkipKeyboardShortcut(el('BODY'), key)).toBe(false);
      expect(shouldSkipKeyboardShortcut(el('DIV'), key)).toBe(false);
      expect(shouldSkipKeyboardShortcut(el('CANVAS'), key)).toBe(false);
    }
  });

  it('matches tag names case-insensitively', () => {
    // `tagName` is upper case for HTML elements but not for every document
    // type (e.g. elements in an XHTML or SVG context).
    expect(shouldSkipKeyboardShortcut(el('button'), 'Enter')).toBe(true);
    expect(shouldSkipKeyboardShortcut(el('input'), 'r')).toBe(true);
  });

  it('reads a partial target field by field', () => {
    // Each field is checked before use, so a target missing `getAttribute` is
    // still classified by its tag name and contenteditable flag.
    const partial = (t: object): KeyboardShortcutTarget => t as KeyboardShortcutTarget;
    expect(shouldSkipKeyboardShortcut(partial({ tagName: 'INPUT' }), 'v')).toBe(true);
    expect(shouldSkipKeyboardShortcut(partial({ isContentEditable: true }), 'v')).toBe(true);
    expect(shouldSkipKeyboardShortcut(partial({ tagName: 'BUTTON' }), 'Enter')).toBe(true);
    expect(shouldSkipKeyboardShortcut(partial({ tagName: 'DIV' }), 'Enter')).toBe(false);
  });

  it('lets keys through when the target is not an element', () => {
    // A keydown dispatched on `window` or `document` has no tag name.
    expect(shouldSkipKeyboardShortcut(null, 'Enter')).toBe(false);
    expect(shouldSkipKeyboardShortcut({} as unknown as KeyboardShortcutTarget, 'Enter')).toBe(
      false,
    );
  });

  describe('other focused controls keep the keys they act on (#205)', () => {
    it('leaves Enter and Space to a <summary>, which toggles its <details>', () => {
      expect(shouldSkipKeyboardShortcut(el('SUMMARY'), 'Enter')).toBe(true);
      expect(shouldSkipKeyboardShortcut(el('SUMMARY'), ' ')).toBe(true);
    });

    it('leaves Enter to a link, which follows it, but not Space', () => {
      // Space scrolls the page from a link rather than activating it.
      expect(shouldSkipKeyboardShortcut(el('A', { href: '/next' }), 'Enter')).toBe(true);
      expect(shouldSkipKeyboardShortcut(el('A', { href: '/next' }), ' ')).toBe(false);
      expect(shouldSkipKeyboardShortcut(el('SPAN', { role: 'link' }), 'Enter')).toBe(true);
    });

    it('does not treat an <a> without href as a link', () => {
      // No href, no link: it is not focusable or activatable as one.
      expect(shouldSkipKeyboardShortcut(el('A'), 'Enter')).toBe(false);
    });

    it('leaves Enter and Space to a <select>, which opens on either', () => {
      // Space opens it everywhere; Return opens it on macOS. One Enter must
      // not both open it and finish a polyline.
      expect(shouldSkipKeyboardShortcut(el('SELECT'), ' ')).toBe(true);
      expect(shouldSkipKeyboardShortcut(el('SELECT'), 'Enter')).toBe(true);
    });

    it('still lets other keys through from these controls', () => {
      for (const target of [el('SUMMARY'), el('A', { href: '/next' }), el('SELECT')]) {
        for (const key of ['r', 'Delete', 'Escape', '1']) {
          expect(shouldSkipKeyboardShortcut(target, key)).toBe(false);
        }
      }
    });
  });
});
