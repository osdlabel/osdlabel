import { describe, expect, it } from 'vitest';
import { partClassName, toolButtonPart } from '../../../src/ui/parts.js';
import {
  OSDLABEL_STOCK_CSS,
  OSDLABEL_STOCK_RULES,
  adoptStockStyles,
  stockStyleTarget,
} from '../../../src/ui/stock-styles.js';

/**
 * Minimal DOM fakes (this package's tests run in Node): just the members
 * `adoptStockStyles` reads. Node type numbers are the DOM's.
 */
class FakeSheet {
  text = '';
  replaceSync(text: string): void {
    this.text = text;
  }
}

interface FakeDocument {
  readonly nodeType: 9;
  adoptedStyleSheets: FakeSheet[];
  readonly defaultView: { readonly CSSStyleSheet: typeof FakeSheet } | null;
  readonly head: { readonly children: { textContent: string }[]; append(n: unknown): void };
  readonly documentElement: unknown;
  createElement(tag: string): { dataset: Record<string, string>; textContent: string };
  getRootNode(): FakeDocument;
}

function fakeDocument(constructable: boolean): FakeDocument {
  const children: { textContent: string }[] = [];
  const doc: FakeDocument = {
    nodeType: 9,
    adoptedStyleSheets: [],
    defaultView: { CSSStyleSheet: FakeSheet },
    head: { children, append: (n) => children.push(n as { textContent: string }) },
    documentElement: {},
    createElement: () => ({ dataset: {}, textContent: '' }),
    getRootNode: () => doc,
  };
  if (!constructable) {
    // No `adoptedStyleSheets` at all, as in jsdom.
    Reflect.deleteProperty(doc, 'adoptedStyleSheets');
  }
  return doc;
}

const asNode = (fake: object): Node => fake as unknown as Node;

function fakeElementIn(root: object, ownerDocument: FakeDocument): Node {
  return asNode({ nodeType: 1, ownerDocument, getRootNode: () => root });
}

function fakeShadowRoot(ownerDocument: FakeDocument) {
  const children: unknown[] = [];
  return {
    nodeType: 11,
    host: {},
    ownerDocument,
    adoptedStyleSheets: [] as FakeSheet[],
    children,
    append: (n: unknown) => children.push(n),
  };
}

describe('partClassName', () => {
  it('prefixes every part name, so classes twin the parts', () => {
    expect(partClassName('toolbar')).toBe('osdlabel-toolbar');
    expect(partClassName(toolButtonPart({ active: true, enabled: false }))).toBe(
      'osdlabel-tool-button osdlabel-tool-button-active osdlabel-tool-button-disabled',
    );
    expect(partClassName('')).toBe('');
  });
});

describe('stock stylesheet', () => {
  it('lives in @layer osdlabel and reads the theme tokens with their fallbacks', () => {
    expect(OSDLABEL_STOCK_CSS.startsWith('@layer osdlabel{')).toBe(true);
    expect(OSDLABEL_STOCK_CSS).toContain(OSDLABEL_STOCK_RULES);
    expect(OSDLABEL_STOCK_RULES).toContain(
      '.osdlabel-tool-button-active{background:var(--osdlabel-accent, #2196F3)',
    );
    expect(OSDLABEL_STOCK_RULES).toContain('padding:var(--osdlabel-control-padding, 4px 10px)');
  });

  it('selects only on osdlabel- classes, never on bare elements or part attributes', () => {
    for (const rule of OSDLABEL_STOCK_RULES.split('\n')) {
      expect(rule).toMatch(/^\.osdlabel-[a-z-]+\{/);
    }
  });

  it('orders active after disabled, so an active disabled button keeps the accent', () => {
    expect(OSDLABEL_STOCK_RULES.indexOf('.osdlabel-tool-button-active{')).toBeGreaterThan(
      OSDLABEL_STOCK_RULES.indexOf('.osdlabel-tool-button-disabled{'),
    );
  });
});

describe('adoptStockStyles', () => {
  it('adopts one constructed sheet into the document, once', () => {
    const doc = fakeDocument(true);
    const el = fakeElementIn(doc, doc);
    adoptStockStyles(el);
    adoptStockStyles(el);
    expect(doc.adoptedStyleSheets).toHaveLength(1);
    expect(doc.adoptedStyleSheets[0]!.text).toBe(OSDLABEL_STOCK_CSS);
    expect(doc.head.children).toHaveLength(0);
  });

  it('adopts the same document-wide sheet into a shadow root, not the document', () => {
    const doc = fakeDocument(true);
    const shadow = fakeShadowRoot(doc);
    adoptStockStyles(fakeElementIn(shadow, doc));
    adoptStockStyles(fakeElementIn(shadow, doc));
    expect(shadow.adoptedStyleSheets).toHaveLength(1);
    expect(shadow.children).toHaveLength(0);
    adoptStockStyles(fakeElementIn(doc, doc));
    expect(doc.adoptedStyleSheets[0]).toBe(shadow.adoptedStyleSheets[0]);
  });

  it('keeps the host page’s own adopted sheets', () => {
    const doc = fakeDocument(true);
    const hostSheet = new FakeSheet();
    doc.adoptedStyleSheets = [hostSheet];
    adoptStockStyles(fakeElementIn(doc, doc));
    expect(doc.adoptedStyleSheets[0]).toBe(hostSheet);
    expect(doc.adoptedStyleSheets).toHaveLength(2);
  });

  it('targets the owner document for a node that is not connected yet', () => {
    const doc = fakeDocument(true);
    const detachedRoot = { nodeType: 1 };
    const target = stockStyleTarget(fakeElementIn(detachedRoot, doc));
    expect(target).toMatchObject({ kind: 'document', detached: true });
  });

  it('falls back to one <style> per root without constructable stylesheets', () => {
    const doc = fakeDocument(false);
    adoptStockStyles(fakeElementIn(doc, doc));
    adoptStockStyles(fakeElementIn(doc, doc));
    expect(doc.head.children).toHaveLength(1);
    expect(doc.head.children[0]!.textContent).toBe(OSDLABEL_STOCK_CSS);
  });
});
