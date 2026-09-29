import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findUnrenderedTableRows } from '../scripts/lib/find-unrendered-table-rows.js';

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

test('flags delimiter cells that smartypants rewrote into en/em dashes', () => {
  // MDX runs remark-smartypants even with GFM off: `--` becomes `—`, so a
  // Prettier-formatted narrow aligned cell (`:--`) ships as `:—`.
  const html = '<p>| a | b | c |\n| --- | :— | —: |</p><p>|x|y|\n|—|–|</p>';
  assert.deepEqual(findUnrenderedTableRows(html), ['| --- | :— | —: |', '|—|–|']);
});

test('flags an indented or CRLF-terminated delimiter row', () => {
  const html = '<li><p>| a | b |\n    | --- | --- |\n</p></li><p>| c |\r\n| --- |\r\n</p>';
  assert.deepEqual(findUnrenderedTableRows(html), ['| --- | --- |', '| --- |']);
});

test('flags a delimiter row glued to the next element with no newline', () => {
  // A header-only table ends on its delimiter row; nothing guarantees
  // whitespace between `</p>` and whatever follows it.
  const html = '<p>| a | b |\n| --- | --- |</p><p>|next|para|</p>';
  assert.deepEqual(findUnrenderedTableRows(html), ['| --- | --- |']);
});

test('ignores a rendered table', () => {
  const html =
    '<table><thead><tr><th>Key</th></tr></thead><tbody><tr><td>v</td></tr></tbody></table>';
  assert.deepEqual(findUnrenderedTableRows(html), []);
});

test('ignores a Markdown table shown inside a code block', () => {
  const html =
    '<figure><pre data-language="md"><code><div class="ec-line">| a | b |</div>\n' +
    '<div class="ec-line">| --- | --- |</div></code></pre></figure>';
  assert.deepEqual(findUnrenderedTableRows(html), []);
});

test('ignores a delimiter row written as inline code in prose', () => {
  const html = '<p>The delimiter row is\n<code>| --- | --- |</code>\nin GFM.</p>';
  assert.deepEqual(findUnrenderedTableRows(html), []);
});

for (const tag of ['script', 'style', 'template', 'textarea']) {
  test(`ignores a delimiter row inside <${tag}>`, () => {
    const html = `<${tag} id="x">\n| --- | --- |\n</${tag}>`;
    assert.deepEqual(findUnrenderedTableRows(html), []);
  });
}

test('steps over quoted attribute values that contain `>`', () => {
  // A naive /<[^>]*>/ would end the tag at the first `>` and leave the rest
  // of the attribute — here, a delimiter row on its own line — as "prose".
  const html =
    '<button data-code="a > b\n| --- | --- |\n" title=\'c > d\n| :-: |\n\'>Copy</button>';
  assert.deepEqual(findUnrenderedTableRows(html), []);
});

test('ignores prose that merely contains pipes or dashes', () => {
  const html = '<p>Use a | b -- or a thematic break:</p><hr>\n<p>---</p>';
  assert.deepEqual(findUnrenderedTableRows(html), []);
});
