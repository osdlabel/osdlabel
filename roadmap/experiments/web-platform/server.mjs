import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(process.argv[2] || 'www');
const port = Number(process.argv[3] || 8765);
const MODES = {
  plain: {},
  'coep-corp': {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  },
  'coep-cred': {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'credentialless',
  },
  'dip-corp': { 'Document-Isolation-Policy': 'isolate-and-require-corp' },
  'dip-cred': { 'Document-Isolation-Policy': 'isolate-and-credentialless' },
};
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.json': 'application/json',
  '.jxl': 'image/jxl',
  '.bin': 'application/octet-stream',
};
http
  .createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const parts = u.pathname.split('/').filter(Boolean);
    let mode = 'plain';
    if (MODES[parts[0]]) mode = parts.shift();
    const file = path.join(root, ...parts);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end();
      return;
    }
    const stat = fs.statSync(file);
    const headers = {
      'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cross-Origin-Resource-Policy': 'same-origin',
      ...MODES[mode],
    };
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : stat.size - 1;
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': stat.size });
      fs.createReadStream(file).pipe(res);
    }
  })
  .listen(port, () => console.log('listening', port));
