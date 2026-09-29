/**
 * Post-build guard: fail the docs build if any page shipped a Markdown table
 * as literal text instead of a `<table>`.
 *
 * GFM (which provides tables) is a remark plugin, and whether it runs is
 * decided by integration config that dependency bumps can change silently.
 * Astro 6 did exactly that to every `.mdx` page while `.md` pages kept
 * working, and the build stayed green. Detection lives in
 * `lib/find-unrendered-table-rows.js`; this file is only the CLI, and runs
 * unconditionally so no invocation style can skip the check.
 *
 * Usage: node scripts/check-rendered-tables.js [distDir]   (default: ./dist)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findUnrenderedTableRows } from './lib/find-unrendered-table-rows.js';

/** @param {string} dir @returns {string[]} */
function htmlFilesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => join(entry.parentPath, entry.name));
}

const distDir = resolve(
  process.argv[2] ?? join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist'),
);
const files = htmlFilesUnder(distDir);
// An empty scan would pass vacuously — e.g. if the output dir moved.
if (files.length === 0) {
  console.error(`check-rendered-tables: no HTML files found under ${distDir}`);
  process.exit(1);
}

const failures = files.flatMap((file) =>
  findUnrenderedTableRows(readFileSync(file, 'utf8')).map(
    (row) => `  ${relative(distDir, file)}: ${row}`,
  ),
);
if (failures.length > 0) {
  console.error(
    `check-rendered-tables: ${failures.length} Markdown table(s) rendered as plain text ` +
      '(is remark-gfm running for this page type? see the mdx() note in astro.config.mjs):\n' +
      failures.join('\n'),
  );
  process.exit(1);
}
console.log(`check-rendered-tables: ${files.length} pages OK`);
