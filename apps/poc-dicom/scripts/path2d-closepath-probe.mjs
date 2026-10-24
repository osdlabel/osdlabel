/**
 * Repro for the Chromium Path2D closePath() cost found while drawing IDC nuclei:
 * builds N 28-vertex polygons into one Path2D closed with closePath(), closed
 * with lineTo(first vertex), and in immediate mode, and prints the times.
 *   node scripts/path2d-closepath-probe.mjs   (POC_CHROMIUM overrides the browser)
 */
import { launch } from './lib/browser.mjs';
const b = await launch();
const p = await b.newPage();
const r = await p.evaluate(() => {
  const out = {};
  for (const n of [1000, 4000, 16000]) {
    const pts = 28;
    let t = performance.now();
    const path = new Path2D();
    for (let i = 0; i < n; i++) {
      const x = (i % 200) * 10,
        y = ((i / 200) | 0) * 10;
      path.moveTo(x, y);
      for (let k = 1; k < pts; k++) path.lineTo(x + Math.cos(k) * 4, y + Math.sin(k) * 4);
      path.closePath();
    }
    out['path2d-closed-' + n] = performance.now() - t;
    t = performance.now();
    const path2 = new Path2D();
    for (let i = 0; i < n; i++) {
      const x = (i % 200) * 10,
        y = ((i / 200) | 0) * 10;
      path2.moveTo(x, y);
      for (let k = 1; k < pts; k++) path2.lineTo(x + Math.cos(k) * 4, y + Math.sin(k) * 4);
      path2.lineTo(x, y);
    }
    out['path2d-open-' + n] = performance.now() - t;
    const c = document.createElement('canvas');
    c.width = 1200;
    c.height = 800;
    document.body.appendChild(c);
    const g = c.getContext('2d');
    t = performance.now();
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i % 200) * 10,
        y = ((i / 200) | 0) * 10;
      g.moveTo(x, y);
      for (let k = 1; k < pts; k++) g.lineTo(x + Math.cos(k) * 4, y + Math.sin(k) * 4);
      g.closePath();
    }
    g.stroke();
    g.getImageData(0, 0, 1, 1);
    out['immediate-closed+flush-' + n] = performance.now() - t;
  }
  return out;
});
console.log(r);
await b.close();
