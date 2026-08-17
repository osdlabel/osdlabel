// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { preventButtonFocusSteal } from '../../src/prevent-button-focus-steal.js';

afterEach(() => {
  document.body.innerHTML = '';
});

function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

describe('preventButtonFocusSteal', () => {
  it('prevents the default when the press lands on a button', () => {
    const host = mount('<button id="b">x</button>');
    const preventDefault = vi.fn();

    preventButtonFocusSteal({ target: host.querySelector('#b'), preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('prevents the default when the press lands inside a button', () => {
    // Every control in the view controls wraps an <svg> icon, so the press
    // target is normally a descendant rather than the button itself.
    const host = mount('<button><svg><circle id="icon" /></svg></button>');
    const preventDefault = vi.fn();

    preventButtonFocusSteal({ target: host.querySelector('#icon'), preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('leaves other controls alone so they can take focus', () => {
    // A sibling <select> or text field in the same container must still focus
    // and open normally.
    const host = mount('<select id="s"><option>a</option></select><input id="i" />');

    for (const selector of ['#s', '#i']) {
      const preventDefault = vi.fn();
      preventButtonFocusSteal({ target: host.querySelector(selector), preventDefault });
      expect(preventDefault).not.toHaveBeenCalled();
    }
  });

  it('ignores a press on the container itself', () => {
    const host = mount('<div id="gap"></div>');
    const preventDefault = vi.fn();

    preventButtonFocusSteal({ target: host.querySelector('#gap'), preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('tolerates a null or non-element target', () => {
    const preventDefault = vi.fn();

    expect(() => preventButtonFocusSteal({ target: null, preventDefault })).not.toThrow();
    expect(() =>
      preventButtonFocusSteal({ target: new EventTarget(), preventDefault }),
    ).not.toThrow();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
