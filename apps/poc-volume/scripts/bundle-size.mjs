/**
 * Minified + gzipped size of what each piece pulls into an app bundle, built
 * with the workspace's Vite (production, ES module, no externals). Output goes
 * to a temp dir; only the numbers are kept.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { build } from 'vite';

const ENTRIES = ['niivue-webgl2', 'osdlabel-mpr-cell', 'new-packages'];

export async function bundleSizes(appDir) {
  const out = {};
  for (const name of ENTRIES) {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `poc-volume-bundle-${name}-`));
    try {
      await build({
        configFile: false,
        root: appDir,
        logLevel: 'silent',
        build: {
          outDir,
          emptyOutDir: true,
          minify: true,
          sourcemap: false,
          reportCompressedSize: false,
          lib: {
            entry: path.join(appDir, 'bundle-entries', `${name}.ts`),
            formats: ['es'],
            fileName: name,
          },
        },
      });
      let raw = 0;
      let gzip = 0;
      let files = 0;
      const walk = (d) => {
        for (const f of fs.readdirSync(d)) {
          const p = path.join(d, f);
          if (fs.statSync(p).isDirectory()) walk(p);
          else if (/\.m?js$/.test(f)) {
            const buf = fs.readFileSync(p);
            raw += buf.length;
            gzip += zlib.gzipSync(buf, { level: 9 }).length;
            files++;
          }
        }
      };
      walk(outDir);
      out[name] = { files, minifiedBytes: raw, gzipBytes: gzip };
    } catch (e) {
      out[name] = { error: String(e?.message ?? e).slice(0, 300) };
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }
  return out;
}
