/**
 * Child process (node --expose-gc): reads one ANN file into osdlabel polygon
 * geometries and reports the JS heap they occupy — the floor under any
 * "import IDC's nuclei annotations into the annotator" plan, before Fabric
 * objects or reactive state are even created.
 */
import fs from 'node:fs';
import { readPart10 } from '@osdlabel/dicom';
import { readBulkAnnotations } from '@osdlabel/dicom-export';

const gc = globalThis.gc;
const bytes = new Uint8Array(fs.readFileSync(process.argv[2]));
gc();
const before = process.memoryUsage().heapUsed;
const t0 = performance.now();
const groups = readBulkAnnotations(readPart10(bytes).dataset);
const ms = performance.now() - t0;
gc();
const after = process.memoryUsage().heapUsed;
const shapes = groups.reduce((n, g) => n + g.geometries.length, 0);
const points = groups.reduce(
  (n, g) =>
    n +
    g.geometries.reduce(
      (m, x) => m + (x.type === 'polygon' || x.type === 'polyline' ? x.points.length : 4),
      0,
    ),
  0,
);
process.stdout.write(
  JSON.stringify({
    shapes,
    points,
    readMs: +ms.toFixed(1),
    heapMB: +((after - before) / 2 ** 20).toFixed(1),
    bytesPerShape: shapes ? Math.round((after - before) / shapes) : null,
  }),
);
// Keep `groups` alive until measured.
if (groups.length < 0) console.log(groups);
