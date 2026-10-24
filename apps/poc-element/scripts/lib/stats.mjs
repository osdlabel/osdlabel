// Pure helpers for scripts/bench.mjs (unit-tested in tests/unit/stats.test.ts).
import zlib from 'node:zlib';

/**
 * Linear-interpolated quantile (type 7, R's default) of an unsorted sample.
 * @param {readonly number[]} xs
 * @param {number} q in [0, 1]
 * @returns {number}
 */
export function quantile(xs, q) {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * @param {readonly number[]} xs
 * @returns {{ n: number, median: number, p25: number, p75: number, min: number, max: number, mean: number }}
 */
export function summarize(xs) {
  const n = xs.length;
  return {
    n,
    median: quantile(xs, 0.5),
    p25: quantile(xs, 0.25),
    p75: quantile(xs, 0.75),
    min: n ? Math.min(...xs) : Number.NaN,
    max: n ? Math.max(...xs) : Number.NaN,
    mean: n ? xs.reduce((a, b) => a + b, 0) / n : Number.NaN,
  };
}

/**
 * Raw, gzip (level 9) and brotli (quality 11) byte counts of a buffer.
 * @param {Uint8Array} buf
 */
export function compressedSizes(buf) {
  return {
    raw: buf.byteLength,
    gzip: zlib.gzipSync(buf, { level: 9 }).byteLength,
    brotli: zlib.brotliCompressSync(buf, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
    }).byteLength,
  };
}

/** @param {number} bytes */
export function kib(bytes) {
  return (bytes / 1024).toFixed(1);
}

/**
 * A fixed-width text table.
 * @param {readonly string[]} header
 * @param {readonly (readonly (string | number)[])[]} rows
 * @returns {string}
 */
export function table(header, rows) {
  const cells = [header, ...rows].map((r) => r.map(String));
  const widths = header.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? '').length)));
  const line = (r) => r.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [
    line(cells[0]),
    widths.map((w) => '-'.repeat(w)).join('  '),
    ...cells.slice(1).map(line),
  ].join('\n');
}

/**
 * Element-wise diff of two computed-style signatures (arrays of
 * `{ path, props }`), keyed by `path`. Returns how many elements differ and
 * how often each property does.
 * @param {readonly { path: string, props: Record<string, string> }[]} base
 * @param {readonly { path: string, props: Record<string, string> }[]} other
 */
export function diffStyleSignatures(base, other) {
  const byPath = new Map(other.map((e) => [e.path, e.props]));
  let elementsDiffering = 0;
  let missing = 0;
  /** @type {Record<string, number>} */
  const propertyCounts = {};
  for (const e of base) {
    const o = byPath.get(e.path);
    if (!o) {
      missing++;
      continue;
    }
    let differs = false;
    for (const [k, v] of Object.entries(e.props)) {
      if (o[k] !== v) {
        differs = true;
        propertyCounts[k] = (propertyCounts[k] ?? 0) + 1;
      }
    }
    if (differs) elementsDiffering++;
  }
  return { compared: base.length, elementsDiffering, missing, propertyCounts };
}
