/**
 * H1/H3 cost side: what each option adds to a host's bundle. Each entry is
 * bundled by esbuild (ESM, browser, minified, tree-shaken from the packages'
 * built dist/) and measured raw, gzip -9 and brotli.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { build } from 'esbuild';

export const ENTRIES = {
  'own: readPart10 only': `export { readPart10 } from '@osdlabel/dicom';`,
  'own: ingest (reader + mapping + DICOM JSON)': `export { readPart10, fromDicomJson, describeInstance, toImageSources } from '@osdlabel/dicom';`,
  'own: @osdlabel/dicom (all)': `export * from '@osdlabel/dicom';`,
  'own: @osdlabel/dicom-wsi (all, incl. dicom)': `export * from '@osdlabel/dicom-wsi';`,
  'own: @osdlabel/dicom-export (all, incl. dicom)': `export * from '@osdlabel/dicom-export';`,
  'dicom-parser: parseDicom': `import d from 'dicom-parser'; export const parse = d.parseDicom;`,
  'dcmjs: read + naturalize': `import dcmjs from 'dcmjs'; export const read = dcmjs.data.DicomMessage.readFile; export const nat = dcmjs.data.DicomMetaDictionary.naturalizeDataset;`,
  'dcmjs: read + write': `import dcmjs from 'dcmjs'; export const read = dcmjs.data.DicomMessage.readFile; export const D = dcmjs.data.DicomDict; export const den = dcmjs.data.DicomMetaDictionary.denaturalizeDataset;`,
  'dcmjs: whole package (SR/SEG derivations)': `export { default } from 'dcmjs';`,
  'reference: openseadragon': `export { default } from 'openseadragon';`,
};

function sizes(buf) {
  return {
    raw: buf.length,
    gzip: zlib.gzipSync(buf, { level: 9 }).length,
    brotli: zlib.brotliCompressSync(buf).length,
  };
}

export async function measureBundles(appDir) {
  const out = {};
  for (const [name, contents] of Object.entries(ENTRIES)) {
    const res = await build({
      stdin: { contents, resolveDir: appDir, loader: 'js' },
      bundle: true,
      minify: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      write: false,
      logLevel: 'silent',
      // dcmjs and friends reference Node built-ins behind runtime checks.
      external: ['fs', 'path', 'crypto', 'zlib', 'stream', 'buffer', 'util'],
    });
    out[name] = sizes(Buffer.from(res.outputFiles[0].contents));
  }
  // The JPEG 2000 decoder is a WASM blob plus Emscripten glue, loaded on demand.
  const codecDir = path.join(appDir, 'node_modules', '@cornerstonejs', 'codec-openjpeg', 'dist');
  const wasm = fs.readFileSync(path.join(codecDir, 'openjpegwasm_decode.wasm'));
  const glue = fs.readFileSync(path.join(codecDir, 'openjpegwasm_decode.js'));
  out['codec: @cornerstonejs/codec-openjpeg (decode wasm + glue)'] = sizes(
    Buffer.concat([wasm, glue]),
  );
  return out;
}
