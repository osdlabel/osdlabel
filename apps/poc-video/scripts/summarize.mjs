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
        packetsFed: wc.stats?.packetsFed ?? null,
      });
    }
    for (const [key, sk] of Object.entries(cell.sink ?? {})) {
      const res = sk.results;
      rows.push({
        video,
        method: `sink:${key}`,
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
        demuxMs: round(sk.demuxMs),
        tableMaxErrUs: round(sk.tableMaxErrUs, 3),
      });
    }
  }
  return rows;
}

/**
 * Pooled over every video, per method: exact counts, and for the video
 * element how often the presented-frame callback fired, how late after
 * `seeked`, and whether a miss correlates with a slow seek.
 */
export function poolH1(h1) {
  const pool = {};
  const get = (k) =>
    (pool[k] ??= {
      ops: 0,
      exact: 0,
      exactAtSeeked: 0,
      rvfcFired: 0,
      rvfcMediaTimeAgrees: 0,
      rvfcMissedSlowSeek: 0,
      rvfcMissedFastSeek: 0,
      rvfcAfterSeekedMs: [],
      ms: [],
    });
  for (const cell of Object.values(h1)) {
    for (const [key, res] of Object.entries(cell.videoElement)) {
      for (const k of [`video:${key}`, `video:${key.split('/')[1]}`, 'video:all']) {
        const p = get(k);
        for (const r of res) {
          p.ops++;
          if (r.got === r.target) p.exact++;
          if (r.gotSeeked === r.target) p.exactAtSeeked++;
          if (r.rvfcFired) {
            p.rvfcFired++;
            if (r.mediaTimeFrame === r.got) p.rvfcMediaTimeAgrees++;
            if (r.msRvfcAfterSeeked !== null && r.msRvfcAfterSeeked !== undefined) {
              p.rvfcAfterSeekedMs.push(r.msRvfcAfterSeeked);
            }
          } else if (r.msSeeked >= 240) p.rvfcMissedSlowSeek++;
          else p.rvfcMissedFastSeek++;
          p.ms.push(r.msSeeked);
        }
      }
    }
    for (const [kind, cells] of [
      ['webcodecs', cell.webcodecs],
      ['sink', cell.sink ?? {}],
    ]) {
      for (const [key, c] of Object.entries(cells)) {
        for (const k of [`${kind}:${key}`, `${kind}:all`]) {
          const p = get(k);
          for (const r of c.results) {
            p.ops++;
            if (r.got === r.target) p.exact++;
            p.ms.push(r.ms);
          }
        }
      }
    }
  }
  return Object.fromEntries(
    Object.entries(pool)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, p]) => [
        k,
        {
          ops: p.ops,
          exact: p.exact,
          exactPct: round((100 * p.exact) / p.ops),
          ...(k.startsWith('video:')
            ? {
                exactAtSeeked: p.exactAtSeeked,
                rvfcFired: p.rvfcFired,
                rvfcMediaTimeAgrees: p.rvfcMediaTimeAgrees,
                rvfcMissedSlowSeek: p.rvfcMissedSlowSeek,
                rvfcMissedFastSeek: p.rvfcMissedFastSeek,
                rvfcAfterSeekedP50Ms: round(quantile(p.rvfcAfterSeekedMs, 0.5)),
                rvfcAfterSeekedP95Ms: round(quantile(p.rvfcAfterSeekedMs, 0.95)),
                rvfcAfterSeekedMaxMs: round(Math.max(...p.rvfcAfterSeekedMs)),
              }
            : {}),
          p50ms: round(quantile(p.ms, 0.5)),
          p95ms: round(quantile(p.ms, 0.95)),
        },
      ]),
  );
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
  if (result.h1Pooled) {
    console.log('\nH1 pooled over videos');
    table(
      Object.entries(result.h1Pooled).map(([method, p]) => ({ method, ...p })),
      [
        'method',
        'ops',
        'exact',
        'exactPct',
        'rvfcFired',
        'rvfcMissedSlowSeek',
        'rvfcMissedFastSeek',
        'rvfcAfterSeekedP95Ms',
        'p50ms',
        'p95ms',
      ],
    );
  }
  if (result.h3?.axis) {
    console.log('\nH3 frame axis: stored times resolved to another frame, per writer and rule');
    table(result.h3.axis.rows, Object.keys(result.h3.axis.rows[0] ?? {}));
  }
  if (result.h3?.keyframes) {
    console.log('\nH3 keyframes as annotations vs TrackDocument');
    table(result.h3.keyframes.rows, Object.keys(result.h3.keyframes.rows[0] ?? {}));
  }
  if (result.h3?.harness) {
    console.log('\nH3 scrub harness');
    table(result.h3.harness.rows, Object.keys(result.h3.harness.rows[0] ?? {}));
  }
}
