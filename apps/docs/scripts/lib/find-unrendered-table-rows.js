/**
 * Detects Markdown tables that GFM did not render, in built HTML.
 *
 * When remark-gfm is off, a table survives as a paragraph whose lines include
 * the delimiter row (`| --- | :-: |`), so that row appearing in rendered prose
 * is an unambiguous signal. Used by `scripts/check-rendered-tables.js`.
 */

// Code (<pre> blocks and inline <code>) is not prose, nor are
// <script>/<style>/<template>/<textarea>. A real unrendered delimiter row
// never contains markup, so skipping inline <code> cannot hide one.
const NON_PROSE = /<(pre|code|script|style|template|textarea)\b[\s\S]*?<\/\1>/gi;
// Quoted attribute values may contain `>`, so step over them explicitly.
// Tags become newlines, not nothing: `…|</p><p>|…` must not glue two blocks
// into one line that no longer looks like a delimiter row. A real one never
// contains markup, so splitting on tags can only isolate it, never break it.
const TAG = /<(?:[^>"']|"[^"]*"|'[^']*')*>/g;
// A GFM delimiter row: dash cells, optionally colon-aligned, pipe-separated.
// MDX still runs remark-smartypants with GFM off, which rewrites `--` into an
// em dash, so a narrow aligned cell (`:--`, which Prettier keeps) ships as
// `:—`. Accept en and em dashes as cell fill too.
const DELIMITER_ROW = /^\|?\s*:?[-–—]+:?\s*(?:\|\s*:?[-–—]+:?\s*)*\|?$/;

/**
 * Returns the delimiter-row lines of unrendered tables in `html`, trimmed.
 * @param {string} html
 * @returns {string[]}
 */
export function findUnrenderedTableRows(html) {
  const text = html.replace(NON_PROSE, '').replace(TAG, '\n');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('|') && DELIMITER_ROW.test(line));
}
