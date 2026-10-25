import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(process.argv[2] + '/index.js').href);
const [gw, gh, d] = process.argv.slice(3).map(Number);
const W = gw * d,
  H = gh * d;
const data = new Uint8Array(gw * gh);
for (let r = 0; r < gh; r += 2) data.fill(1, r * gw, (r + 1) * gw);
const s = { x: 0, y: 0, width: gw, height: gh, data, imageWidth: W, imageHeight: H, downsample: d };
const canon = m.encodeCanonical(s);
console.log(
  JSON.stringify({
    grid: `${gw}x${gh}`,
    d,
    cells: gw * gh,
    capFraction: ((gw * gh) / m.DEFAULT_MAX_MASK_PIXELS).toFixed(2),
    canonicalCountsChars: canon.counts.length,
  }),
);
// passes the canonical decode at the default cap:
const back = m.decodeCanonical(canon);
console.log('decodeCanonical ok, cells', back.width * back.height);
const t0 = performance.now();
try {
  const enc = m.cocoRleCodec.encode(back);
  console.log(
    JSON.stringify({
      cocoChars: enc.counts.length,
      ms: Math.round(performance.now() - t0),
      heapMB: Math.round(process.memoryUsage().heapUsed / 1e6),
    }),
  );
} catch (e) {
  console.log(
    'threw',
    e?.name,
    e?.message?.slice(0, 120),
    Math.round(performance.now() - t0),
    'ms',
  );
}
