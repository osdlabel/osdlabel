import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findUnrenderedTableRows } from '../scripts/check-rendered-tables.js';

test('flags a table that GFM did not render (the Astro 6 .mdx regression)', () => {
  // Verbatim shape of the broken keyboard-shortcuts page.
  const html =
    '<p>| Key                    | Action                                    |\n' +
    '| ---------------------- | ----------------------------------------- |\n' +
    '| <code dir="auto">v</code>                    | Select tool                               |</p>';
  assert.deepEqual(findUnrenderedTableRows(html), [
    '| ---------------------- | ----------------------------------------- |',
  ]);
});

test('flags alignment colons, pipe-less edges and single-column tables', () => {
  const html = '<p>a | b\n:--- | ---:\n</p><p>| Only |\n| :-: |</p>';
  assert.deepEqual(findUnrenderedTableRows(html), [':--- | ---:', '| :-: |']);
});

test('ignores a rendered table', () => {
  const html =
    '<table><thead><tr><th>Key</th></tr></thead><tbody><tr><td>v</td></tr></tbody></table>';
  assert.deepEqual(findUnrenderedTableRows(html), []);
});

test('ignores a Markdown table shown inside a code block', () => {
  const html =
    '<figure><pre data-language="md"><code><div class="ec-line">| a | b |</div>\n' +
    '<div class="ec-line">| --- | --- |</div></code></pre>' +
    '<button data-code="| a | b |\u007f| --- | --- |" title="a > b">Copy</button></figure>';
  assert.deepEqual(findUnrenderedTableRows(html), []);
});

test('ignores prose that merely contains pipes or dashes', () => {
  const html = '<p>Use <code>a | b</code> -- or a thematic break:</p><hr>\n<p>---</p>';
  assert.deepEqual(findUnrenderedTableRows(html), []);
});
