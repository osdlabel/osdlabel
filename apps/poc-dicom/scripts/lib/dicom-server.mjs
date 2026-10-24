/**
 * Dev-server middleware for the PoC (a Vite plugin):
 *
 *  - `/data/<role>/<file>.dcm` — the fetched IDC files, with HTTP Range
 *    support, i.e. "Part 10 on static hosting" (what a bucket or CDN gives).
 *  - `/data-index.json` — which files exist, by role.
 *  - `/dicomweb/...` — a minimal DICOMweb (WADO-RS) server over the same
 *    files: series `metadata` in the DICOM JSON model, and `frames/{n}` as
 *    `multipart/related` with the stored (compressed) bytes. A configurable
 *    per-request latency (`/dicomweb-config?latency=ms`) emulates a remote
 *    archive. It reads frames from disk per request, as a server would.
 *
 * Everything is same-origin and served with COOP/COEP/CORP so the page is
 * cross-origin isolated (needed for precise timers and SharedArrayBuffer).
 */
import fs from 'node:fs';
import path from 'node:path';
import { readPart10, indexFrames, toDicomJson, TAGS } from '@osdlabel/dicom';

const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export function dicomServer({ dataDir }) {
  let index; // lazily built: uid → { path, ts, frames, json, study, series }
  const state = { latencyMs: 0, requests: 0, bytes: 0 };

  function buildIndex() {
    if (index) return index;
    index = new Map();
    if (!fs.existsSync(dataDir)) return index;
    for (const role of fs.readdirSync(dataDir)) {
      const dir = path.join(dataDir, role);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.dcm'))) {
        const p = path.join(dir, f);
        const bytes = new Uint8Array(fs.readFileSync(p));
        const file = readPart10(bytes);
        const ds = file.dataset;
        const uid = ds.strings(TAGS.SOPInstanceUID.tag)?.[0];
        if (!uid) continue;
        let frames = [];
        try {
          if (file.pixelData && !file.truncated) frames = indexFrames(file).frames;
        } catch {
          frames = [];
        }
        const json = toDicomJson(ds, {
          bulkDataUri: (tag) => `bulkdata/${tag.toString(16)}`,
        });
        json['00020010'] = { vr: 'UI', Value: [file.transferSyntaxUid] };
        index.set(uid, {
          path: p,
          role,
          ts: file.transferSyntaxUid,
          frames,
          json,
          study: ds.strings(TAGS.StudyInstanceUID.tag)?.[0],
          series: ds.strings(TAGS.SeriesInstanceUID.tag)?.[0],
        });
      }
    }
    return index;
  }

  const send = (res, status, headers, body) => {
    res.writeHead(status, { ...ISOLATION, ...headers });
    res.end(body);
  };
  const delay = () => new Promise((r) => setTimeout(r, state.latencyMs));

  function readRange(p, start, end) {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(end - start + 1);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf;
    } finally {
      fs.closeSync(fd);
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/data-index.json') {
      const out = {};
      if (fs.existsSync(dataDir)) {
        for (const role of fs.readdirSync(dataDir)) {
          const dir = path.join(dataDir, role);
          if (fs.statSync(dir).isDirectory())
            out[role] = fs
              .readdirSync(dir)
              .filter((f) => f.endsWith('.dcm'))
              .sort();
        }
      }
      return send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(out));
    }
    if (p.startsWith('/data/')) {
      const file = path.join(dataDir, decodeURIComponent(p.slice('/data/'.length)));
      if (!file.startsWith(dataDir) || !fs.existsSync(file)) return send(res, 404, {}, 'not found');
      const size = fs.statSync(file).size;
      state.requests++;
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
        const body = readRange(file, start, end);
        state.bytes += body.length;
        await delay();
        return send(
          res,
          206,
          {
            'Content-Type': 'application/dicom',
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Content-Length': body.length,
          },
          body,
        );
      }
      const body = fs.readFileSync(file);
      state.bytes += body.length;
      await delay();
      return send(
        res,
        200,
        {
          'Content-Type': 'application/dicom',
          'Accept-Ranges': 'bytes',
          'Content-Length': body.length,
        },
        body,
      );
    }
    if (p === '/series-of.json') {
      const idx = buildIndex();
      const role = url.searchParams.get('role');
      const e = [...idx.values()].find((x) => x.role === role);
      return send(
        res,
        e ? 200 : 404,
        { 'Content-Type': 'application/json' },
        JSON.stringify(e ? { study: e.study, series: e.series } : {}),
      );
    }
    if (p === '/dicomweb-config') {
      if (url.searchParams.has('latency'))
        state.latencyMs = Number(url.searchParams.get('latency'));
      if (url.searchParams.has('reset')) {
        state.requests = 0;
        state.bytes = 0;
      }
      return send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(state));
    }
    const m =
      /^\/dicomweb\/studies\/([^/]+)\/series\/([^/]+)\/(metadata|instances\/([^/]+)\/frames\/(\d+))$/.exec(
        p,
      );
    if (m) {
      const idx = buildIndex();
      state.requests++;
      if (m[3] === 'metadata') {
        const list = [...idx.values()]
          .filter((e) => e.study === m[1] && e.series === m[2])
          .map((e) => e.json);
        if (!list.length) return send(res, 404, {}, 'no such series');
        const body = JSON.stringify(list);
        state.bytes += body.length;
        await delay();
        return send(res, 200, { 'Content-Type': 'application/dicom+json' }, body);
      }
      const e = idx.get(m[4]);
      const n = Number(m[5]);
      const ranges = e?.frames[n - 1];
      if (!e || !ranges) return send(res, 404, {}, 'no such frame');
      const parts = ranges.map((r) => readRange(e.path, r.offset, r.offset + r.length - 1));
      const frame = Buffer.concat(parts);
      const boundary = 'osdlabel-poc-boundary';
      const head = Buffer.from(
        `--${boundary}\r\nContent-Type: application/octet-stream; transfer-syntax=${e.ts}\r\n\r\n`,
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([head, frame, tail]);
      state.bytes += body.length;
      await delay();
      return send(
        res,
        200,
        {
          'Content-Type': `multipart/related; type="application/octet-stream"; transfer-syntax=${e.ts}; boundary=${boundary}`,
          'Content-Length': body.length,
        },
        body,
      );
    }
    return false;
  }

  return {
    name: 'osdlabel-poc-dicom-server',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        handle(req, res).then((handled) => {
          if (handled === false) next();
        }, next);
      });
    },
    /** Series UIDs per role, for pages that use DICOMweb. */
    seriesOf(role) {
      const idx = buildIndex();
      const e = [...idx.values()].find((x) => x.role === role);
      return e ? { study: e.study, series: e.series } : undefined;
    },
    state,
  };
}
