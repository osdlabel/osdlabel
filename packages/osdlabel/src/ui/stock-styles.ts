import { partClassName } from './parts.js';
import { themeVar } from './theme-tokens.js';

/**
 * The stock UI's styles as a stylesheet in a cascade layer, instead of inline
 * styles (prototype scope: the toolbar).
 *
 * Why a layer: an inline style beats every selector, so in light DOM a host
 * could not restyle the stock toolbar through its `part` names at all
 * (measured: `[part~="tool-button"]{background-color:…;padding:…}` left the
 * inline values in place). Any unlayered host rule beats any rule in a layer,
 * whatever its specificity, so `[part~="tool-button"]` and the
 * `osdlabel-*` classes now work as override hooks in both bindings, and
 * `::part()` keeps working from outside the element's shadow root.
 *
 * The cost, which is the same mechanism: an unlayered host *reset* (Bootstrap's
 * reboot, an unlayered Tailwind preflight) also beats the layer in light DOM,
 * where inline styles shielded the toolbar from it. A host whose own CSS is
 * layered (Tailwind 4's `@import "tailwindcss"`) is unaffected, as long as
 * its layers are declared before this one (later-declared layers win).
 *
 * Selectors are the class twins of the part names (`partClassName`), not
 * `[part~=…]`, so the sheet cannot match a host element that happens to
 * carry the same `part` value in light DOM.
 */
export const OSDLABEL_STYLE_LAYER = 'osdlabel';

const cls = (part: string): string => `.${partClassName(part)}`;

/** The stock toolbar's rules, unlayered. Values are the tokens' `var()`s, so themes keep working. */
export const OSDLABEL_STOCK_RULES = [
  `${cls('toolbar')}{display:flex;gap:${themeVar('gap')};align-items:center;flex-wrap:wrap}`,
  `${cls('tool-button')}{padding:${themeVar('controlPadding')};border:none;` +
    `border-radius:${themeVar('radius')};cursor:pointer;background:${themeVar('control')};` +
    `color:${themeVar('text')};font-weight:normal;font-size:${themeVar('fontSizeControl')};opacity:1}`,
  // Disabled before active: an active, disabled button keeps the accent
  // background (as the inline logic did) but takes the disabled text colour.
  `${cls('tool-button-disabled')}{cursor:not-allowed;background:${themeVar('controlDisabled')};` +
    `color:${themeVar('textDisabled')};opacity:0.5}`,
  `${cls('tool-button-active')}{background:${themeVar('accent')};font-weight:bold}`,
  `${cls('brush-options')}{display:flex;align-items:center;gap:${themeVar('gap')}}`,
  `${cls('brush-label')}{color:${themeVar('textSubtle')};font-size:${themeVar('fontSizeStatus')};` +
    `white-space:nowrap}`,
  `${cls('brush-radius')}{width:90px}`,
  `${cls('brush-radius-value')}{color:${themeVar('text')};font-size:${themeVar('fontSizeStatus')};` +
    `min-width:34px}`,
].join('\n');

/** {@link OSDLABEL_STOCK_RULES} inside `@layer osdlabel`. */
export const OSDLABEL_STOCK_CSS = `@layer ${OSDLABEL_STYLE_LAYER}{\n${OSDLABEL_STOCK_RULES}\n}`;

const DOCUMENT_NODE = 9;
const DOCUMENT_FRAGMENT_NODE = 11;

/** One constructed sheet per document (a constructed sheet is adoptable only in its own document). */
const sheets = new WeakMap<Document, CSSStyleSheet | null>();
/** Roots that already got the `<style>` fallback. */
const fallbackRoots = new WeakSet<Document | ShadowRoot>();

function isShadowRoot(node: Node): node is ShadowRoot {
  return node.nodeType === DOCUMENT_FRAGMENT_NODE && 'host' in node;
}

function constructedSheet(doc: Document): CSSStyleSheet | null {
  const cached = sheets.get(doc);
  if (cached !== undefined) return cached;
  let sheet: CSSStyleSheet | null = null;
  const Ctor = doc.defaultView?.CSSStyleSheet;
  if (Ctor && 'adoptedStyleSheets' in doc && typeof Ctor.prototype.replaceSync === 'function') {
    try {
      sheet = new Ctor();
      sheet.replaceSync(OSDLABEL_STOCK_CSS);
    } catch {
      sheet = null;
    }
  }
  sheets.set(doc, sheet);
  return sheet;
}

/** Where the stock sheet goes for `node`, and whether that was a guess. */
export type StockStyleTarget =
  | { readonly kind: 'shadow-root'; readonly root: ShadowRoot }
  | { readonly kind: 'document'; readonly root: Document; readonly detached: boolean };

/**
 * The root whose styles reach `node`: its shadow root, or its document. A
 * node not yet connected gets its owner document, the right answer for every
 * light-DOM mount; a detached subtree later moved into a shadow root would
 * miss the sheet (a limitation of the prototype).
 */
export function stockStyleTarget(node: Node): StockStyleTarget | null {
  const root = node.getRootNode();
  if (isShadowRoot(root)) return { kind: 'shadow-root', root };
  if (root.nodeType === DOCUMENT_NODE) {
    return { kind: 'document', root: root as Document, detached: false };
  }
  const doc = node.ownerDocument;
  return doc ? { kind: 'document', root: doc, detached: true } : null;
}

/**
 * Installs the stock stylesheet where `node` renders. Idempotent per root.
 *
 * With constructable stylesheets (every current engine) the one sheet per
 * document is appended to the root's `adoptedStyleSheets`: no node is added
 * to `document.head` or to the shadow root. Without them (jsdom, old
 * engines) it falls back to one `<style data-osdlabel="stock">` per root.
 */
export function adoptStockStyles(node: Node): void {
  const target = stockStyleTarget(node);
  if (!target) return;
  const root = target.root;
  const doc = target.kind === 'document' ? target.root : root.ownerDocument;
  if (!doc) return;
  const sheet = constructedSheet(doc);
  if (sheet) {
    if (!root.adoptedStyleSheets.includes(sheet)) {
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    }
    return;
  }
  if (fallbackRoots.has(root)) return;
  const style = doc.createElement('style');
  style.dataset['osdlabel'] = 'stock';
  style.textContent = OSDLABEL_STOCK_CSS;
  if (target.kind === 'document') (doc.head ?? doc.documentElement).append(style);
  else root.append(style);
  fallbackRoots.add(root);
}
