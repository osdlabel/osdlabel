/* global window -- page.evaluate callbacks run in the browser */
/**
 * Diagnostic: scroll the Solid harness once and print the display log around
 * every incoherent paint (image and annotations showing different frames),
 * with whether each event ran inside a rAF callback.
 *
 *   node scripts/coherence.mjs '{"annotationsPerFrame":10,"objectCaching":false}' [port]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extra = JSON.parse(process.argv[2] ?? '{}');
const port = Number(process.argv[3] ?? 5535);
const server = await createServer({
  configFile: path.join(APP, 'vite.config.mjs'),
  server: { port, strictPort: true, host: '127.0.0.1' },
});
await server.listen();
const exe = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch({
  headless: true,
  ...(exe ? { executablePath: exe } : {}),
  args: ['--no-sandbox'],
});
try {
  const page = await (
    await browser.newContext({ viewport: { width: 900, height: 900 } })
  ).newPage();
  await page.goto(`http://127.0.0.1:${port}/solid.html`);
  await page.waitForFunction('window.__poc && window.__poc.ready');
  await page.evaluate((o) => window.__poc.setup(o), {
    drawer: 'canvas',
    frames: 300,
    width: 512,
    height: 512,
    annotationsPerFrame: 10,
    ...extra,
  });
  await page.evaluate(() => window.__poc.scroll({ rate: 60, durationMs: 2000 }));
  const r = await page.evaluate(() => window.__poc.scroll({ rate: 60, durationMs: 2000 }));
  const { raw, events } = await page.evaluate(() => window.__poc.displayLog());
  console.log('incoherent', r.incoherentFrames, 'frames', r.frames, 'shown/s', r.shownSlicesPerSec);
  // Replay the analysis: state per paint.
  const bySeq = new Map();
  for (const e of events) {
    if (!bySeq.has(e.seq)) bySeq.set(e.seq, []);
    bySeq.get(e.seq).push(e);
  }
  const seqs = [...bySeq.keys()].sort((a, b) => a - b);
  let img;
  let ann;
  const bad = [];
  for (let s = seqs[0]; s <= seqs[seqs.length - 1]; s++) {
    for (const e of bySeq.get(s) ?? []) {
      if (e.kind === 'img') img = e.frame;
      if (e.kind === 'ann') ann = e.frame;
    }
    if (img !== undefined && ann !== undefined && img >= 0 && img !== ann)
      bad.push({ s, img, ann });
  }
  const kinds = { ahead: 0, behind: 0 };
  for (const b of bad) {
    // ann shows the frame the image shows next (ahead) or showed before (behind)?
    const nextImg = events.find((e) => e.kind === 'img' && e.seq > b.s && e.frame !== b.img);
    if (nextImg && nextImg.frame === b.ann) kinds.ahead++;
    else kinds.behind++;
  }
  console.log('incoherent paints:', bad.length, kinds);
  const rawBySeq = new Map();
  for (const e of raw) {
    if (!rawBySeq.has(e.seq)) rawBySeq.set(e.seq, []);
    rawBySeq.get(e.seq).push(e);
  }
  for (const b of bad.slice(0, 6)) {
    console.log(`\npaint ${b.s}: img ${b.img} ann ${b.ann}`);
    for (let s = b.s - 2; s <= b.s + 1; s++) {
      const line = (rawBySeq.get(s) ?? [])
        .map((e) => `${e.kind}:${e.frame}${e.inRaf ? '' : '(out)'}`)
        .join(' ');
      console.log(`  raw seq ${s}: ${line}`);
    }
  }
} finally {
  await browser.close();
  await server.close();
}
