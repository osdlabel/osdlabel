/** Aggregation and console tables for scripts/bench.mjs. */

export function quantile(xs, q) {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

const round = (x, d = 1) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);

function offByHistogram(rows) {
  const h = {};
  for (const r of rows) {
    const k = r.got < 0 ? 'unreadable' : String(r.got - r.target);
    h[k] = (h[k] ?? 0) + 1;
  }
  return h;
}

export function summarizeH1(h1) {
  const rows = [];
  for (const [video, cell] of Object.entries(h1)) {
    for (const [key, res] of Object.entries(cell.videoElement)) {
      rows.push({
        video,
        method: `video:${key}`,
        n: res.length,
        exactPct: round((100 * res.filter((r) => r.got === r.target).length) / res.length),
        exactAtSeekedPct: round(
          (100 * res.filter((r) => r.gotSeeked === r.target).length) / res.length,
        ),
        mediaTimeAgreesPct: round(
          (100 * res.filter((r) => r.rvfcFired && r.mediaTimeFrame === r.got).length) / res.length,
        ),
        rvfcFiredPct: round((100 * res.filter((r) => r.rvfcFired).length) / res.length),
        offBy: offByHistogram(res),
        p50ms: round(
          quantile(
            res.map((r) => r.msSeeked),
            0.5,
          ),
        ),
        p95ms: round(
          quantile(
            res.map((r) => r.msSeeked),
            0.95,
          ),
        ),
        p50msToRvfc: round(
          quantile(
            res.map((r) => r.msFrame),
            0.5,
          ),
        ),
      });
    }
    for (const [key, wc] of Object.entries(cell.webcodecs)) {
      const res = wc.results;
      rows.push({
        video,
        method: `webcodecs:${key}`,
        n: res.length,
        exactPct: round((100 * res.filter((r) => r.got === r.target).length) / res.length),
        offBy: offByHistogram(res),
        p50ms: round(
          quantile(
            res.map((r) => r.ms),
            0.5,
          ),
        ),
        p95ms: round(
          quantile(
            res.map((r) => r.ms),
            0.95,
          ),
        ),
        maxMs: round(Math.max(...res.map((r) => r.ms))),
        resets: res.filter((r) => r.reset).length,
        hits: res.filter((r) => r.hit).length,
        demuxMs: round(wc.demuxMs),
        frameBytes: wc.frameBytes,
        peakCacheMB: round(wc.peakCacheBytes / 1e6),
        peakCacheFrames: wc.peakCacheFrames,
        tableMaxErrUs: round(wc.tableMaxErrUs, 3),
        packetsFed: wc.stats.packetsFed,
      });
    }
  }
  return rows;
}

function table(rows, cols) {
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (vals) => vals.map((v, i) => String(v ?? '').padEnd(widths[i])).join('  ');
  console.log(line(cols));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(cols.map((c) => r[c])));
}

export function printTable(result) {
  if (result.h1Summary) {
    console.log('\nH1 seek accuracy (exactPct = barcode equals requested frame) and latency');
    table(
      result.h1Summary.map((r) => ({ ...r, offBy: JSON.stringify(r.offBy) })),
      ['video', 'method', 'n', 'exactPct', 'offBy', 'p50ms', 'p95ms', 'mediaTimeAgreesPct'],
    );
  }
  if (result.h2?.rows) {
    console.log('\nH2 1080p playback, render paths');
    table(result.h2.rows, Object.keys(result.h2.rows[0] ?? {}));
  }
  if (result.h3?.node) {
    console.log('\nH3 interpolation cost, Node (per frame, all tracks)');
    table(result.h3.node.rows, Object.keys(result.h3.node.rows[0] ?? {}));
  }
  if (result.h3?.axis) {
    console.log('\nH3 frame axis: frames re-attached to another index when looked up by time');
    table(result.h3.axis.rows, Object.keys(result.h3.axis.rows[0] ?? {}));
  }
  if (result.h3?.harness) {
    console.log('\nH3 scrub harness');
    table(result.h3.harness.rows, Object.keys(result.h3.harness.rows[0] ?? {}));
  }
}
