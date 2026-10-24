/**
 * Print a run's results as Markdown tables.
 *
 *   node scripts/tables.mjs results/run-<stamp>.json [more.json ...]
 *
 * Several files are merged (later files add H1 cells the earlier lacked), so
 * a supplementary run can be tabulated together with the main one.
 */
import fs from 'node:fs';
import { summarizeH1 } from './summarize.mjs';

const files = process.argv.slice(2);
if (files.length === 0) throw new Error('usage: tables.mjs run.json [...]');
const runs = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
const h1 = {};
for (const r of runs) {
  for (const [video, cell] of Object.entries(r.h1 ?? {})) {
    const into = (h1[video] ??= { ...cell, videoElement: {}, webcodecs: {} });
    Object.assign(into.videoElement, cell.videoElement);
    Object.assign(into.webcodecs, cell.webcodecs);
  }
}
const md = (rows, cols) => {
  const out = [`| ${cols.join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`];
  for (const r of rows) out.push(`| ${cols.map((c) => String(r[c] ?? '')).join(' | ')} |`);
  return out.join('\n');
};

const rows = summarizeH1(h1);
console.log('## H1 per video and method\n');
console.log(
  md(
    rows.map((r) => ({ ...r, offBy: JSON.stringify(r.offBy) })),
    ['video', 'method', 'n', 'exactPct', 'offBy', 'p50ms', 'p95ms', 'maxMs', 'mediaTimeAgreesPct'],
  ),
);

console.log('\n## H1 pooled over videos\n');
const pooled = {};
for (const r of rows) {
  const p = (pooled[r.method] ??= {
    method: r.method,
    n: 0,
    exact: 0,
    videos: 0,
    worstPct: 100,
    worstVideo: '',
  });
  p.n += r.n;
  p.exact += Math.round((r.exactPct * r.n) / 100);
  p.videos++;
  if (r.exactPct < p.worstPct) {
    p.worstPct = r.exactPct;
    p.worstVideo = r.video;
  }
}
console.log(
  md(
    Object.values(pooled).map((p) => ({ ...p, exactPct: ((100 * p.exact) / p.n).toFixed(1) })),
    ['method', 'videos', 'n', 'exact', 'exactPct', 'worstPct', 'worstVideo'],
  ),
);

for (const r of runs) {
  if (r.h2?.rows) {
    console.log(`\n## H2 (${r.h2.video}, ${r.h2.seconds}s per cell, ${r.h2.viewport})\n`);
    console.log(md(r.h2.rows, Object.keys(r.h2.rows.find((x) => !x.error) ?? r.h2.rows[0])));
  }
  if (r.h3?.node) {
    console.log('\n## H3 interpolation cost (Node)\n');
    console.log(md(r.h3.node.rows, Object.keys(r.h3.node.rows[0])));
    console.log(
      '\n```json\n' +
        JSON.stringify({ area: r.h3.node.area, serialization: r.h3.node.serialization }, null, 1) +
        '\n```',
    );
  }
  if (r.h3?.harness?.rows) {
    console.log('\n## H3 harness\n');
    console.log(md(r.h3.harness.rows, ['check', 'value', 'pass']));
  }
}
