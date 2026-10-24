// Prints the summary tables of a benchmark results JSON. bench.mjs calls it at
// the end of a run; standalone:
//
//   node scripts/summary.mjs results/<file>.json
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const f = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '-');
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

function table(rows, header) {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) =>
    cells.map((c, i) => (i === 0 ? pad(c, widths[i]) : lpad(c, widths[i]))).join(' | ');
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('-|-'));
  for (const r of rows) console.log(line(r));
}

const medMin = (s, d = 0) => (s && s.n ? `${f(s.median, d)} (${f(s.min, d)})` : '-');

/** Median, min and max of finite numbers, or null. */
export function spread(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = (v.length - 1) / 2;
  return {
    n: v.length,
    median: (v[Math.floor(mid)] + v[Math.ceil(mid)]) / 2,
    min: v[0],
    max: v[v.length - 1],
  };
}
const range = (s, d = 0) => (s ? `${f(s.median, d)} [${f(s.min, d)}-${f(s.max, d)}]` : '-');

function printInt8(results) {
  const q = results.int8;
  if (!q) return;
  console.log(
    `\nH7  int8 vs fp32, graph for graph. Browser WASM: median of ${q.rounds} interleaved rounds' medians [min-max over rounds], ms; ` +
      'cpu = browser CPU ms per call (median over rounds). Native: onnxruntime-node, same rounds.',
  );
  const pick = (arr, role, model, threads) =>
    arr.filter(
      (r) =>
        !r.error &&
        (role === null || r.role === role) &&
        r.config.model === model &&
        r.config.threads === threads,
    );
  for (const role of ['encoder', 'decoder']) {
    const ids = role === 'encoder' ? q.encoders : q.decoders;
    const metric = (r) => (role === 'encoder' ? r.encode?.median : r.decodeClick?.median);
    const cpu = (r) => (role === 'encoder' ? r.cpu?.encodeMs : r.cpu?.decodeMs);
    const ref = Object.fromEntries(
      q.threads.map((t) => [t, spread(pick(q.browser, role, ids[0], t).map(metric))?.median]),
    );
    const rows = ids.map((id) => {
      const row = [id, f((q.sizes[id]?.[`${role}Bytes`] ?? NaN) / 1e6, 1)];
      for (const t of q.threads) {
        const b = pick(q.browser, role, id, t);
        const s = spread(b.map(metric));
        row.push(
          range(s, role === 'encoder' ? 0 : 1),
          f(spread(b.map(cpu))?.median, role === 'encoder' ? 0 : 1),
          s && ref[t] ? `${f((s.median / ref[t] - 1) * 100)}%` : '-',
        );
      }
      for (const t of q.threads) {
        const n = pick(q.native, null, id, t);
        row.push(f(spread(n.map(metric))?.median, role === 'encoder' ? 0 : 1));
      }
      return row;
    });
    table(rows, [
      `${role} variant`,
      'MB',
      ...q.threads.flatMap((t) => [`wasm t${t}`, `cpu t${t}`, `vs ${ids[0]}`]),
      ...q.threads.map((t) => `native t${t}`),
    ]);
  }
}

function printQuality(results) {
  const q = results.quality;
  if (!q?.runs) return;
  console.log(
    `\nH7  mask quality vs the fp32 reference, same prompts, ${q.meta?.runtime} t=${q.meta?.threads}: ` +
      'best-mask IoU over the scenario steps with a mask (median [min-max]), and GT IoU drops > 0.05',
  );
  const rows = (q.comparisons ?? []).map((c) => {
    const ious = spread(c.rows.map((r) => r.bestMaskIoU));
    const gt = c.rows.filter(
      (r) => typeof r.groundTruthIoU[0] === 'number' && typeof r.groundTruthIoU[1] === 'number',
    );
    const drops = gt.filter((r) => r.groundTruthIoU[1] < r.groundTruthIoU[0] - 0.05);
    return [
      c.model,
      c.reference,
      range(ious, 3),
      `${drops.length}/${gt.length}`,
      drops
        .map((r) => `${r.id} ${f(r.groundTruthIoU[0], 2)}->${f(r.groundTruthIoU[1], 2)}`)
        .join(' '),
    ];
  });
  table(rows, ['variant', 'reference', 'best-mask IoU', 'GT drops', 'which']);
  console.log('\nH2  refinement across a zoom (quality check): refining step vs the step before');
  const ref = [];
  for (const run of q.runs)
    for (const s of run.steps)
      if (s.refinement)
        ref.push([
          run.model,
          s.id,
          s.cached ? 'hit' : 'miss',
          s.promptInsideRegion ? 'yes' : 'NO',
          f(s.refinement.bestMaskIoU, 3),
          f(s.refinement.centroidShiftPx, 1),
          f(s.refinement.previousCellPx, 1),
          `${f(s.refinement.previousResampledIoU, 3)} / ${f(s.refinement.previousCopiedIoU, 3)}`,
          f(s.groundTruthIoU, 3),
        ]);
  table(ref, [
    'model',
    'step',
    'cache',
    'all points encoded',
    'IoU vs prev',
    'centroid shift px',
    'prev cell px',
    'prev logits on new grid: resampled / copied IoU',
    'GT IoU',
  ]);
}

function printResponsiveness(results) {
  const runs = results.responsiveness;
  if (!runs?.length) return;
  console.log(
    '\nH4  main-thread responsiveness during cold encodes (rAF fps, Long Tasks API), median [min-max] over reps',
  );
  const rows = [];
  for (const run of runs) {
    const c = run.config;
    const conds = [...new Set(run.samples.map((s) => s.cond))];
    for (const cond of conds) {
      const ss = run.samples.filter((s) => s.cond === cond && !s.error);
      const fr = (k) => spread(ss.map((s) => s.frames?.[k]));
      rows.push([
        `${c.mode} t=${c.threads} ${run.init?.drawer ?? c.drawer ?? ''}`,
        cond,
        ss.length,
        cond === 'pan-only' ? '-' : range(spread(ss.map((s) => s.latency))),
        cond === 'pan-only' ? '-' : range(spread(ss.map((s) => s.timings?.encode))),
        range(fr('fps')),
        range(fr('longTaskMs')),
        range(fr('maxGap')),
        cond === 'pan-only' ? '-' : f(spread(ss.map((s) => s.tilesAtClick?.jobs))?.median),
        f(spread(ss.map((s) => s.tilesLoadedDuring ?? s.tilesLoaded))?.median),
      ]);
    }
  }
  table(rows, [
    'config',
    'condition',
    'n',
    'click->paint ms',
    'encode ms',
    'fps',
    'long-task ms',
    'max gap ms',
    'tile jobs at click',
    'tiles loaded',
  ]);
}

export function printSummary(results, modelTable = []) {
  const weights = Object.fromEntries(modelTable.map((m) => [m.id, m.weights]));
  const models = [
    ...new Set([...(results.native ?? []), ...(results.models ?? [])].map((r) => r.config.model)),
  ];
  if (models.length) {
    console.log(
      '\nH1  encoder / decoder latency, ms: median (min). wasm = onnxruntime-web CPU (SIMD, threads via SAB);',
    );
    console.log(
      '    native = onnxruntime-node CPU; webgpu = SwiftShader (CPU-emulated: a bound, not a GPU number).',
    );
    const find = (arr, pred) => (arr ?? []).find((r) => !r.error && pred(r.config));
    const rows = models.map((m) => {
      const n1 = find(results.native, (c) => c.model === m && c.threads === 1);
      const n4 = find(results.native, (c) => c.model === m && c.threads === 4);
      const w1 = find(
        results.models,
        (c) => c.model === m && c.encoderEp === 'wasm' && c.decoderEp === 'wasm' && c.threads === 1,
      );
      const w4 = find(
        results.models,
        (c) => c.model === m && c.encoderEp === 'wasm' && c.decoderEp === 'wasm' && c.threads === 4,
      );
      const gd = find(results.models, (c) => c.model === m && c.decoderEp === 'webgpu');
      const ge = (results.models ?? []).find(
        (r) => r.config.model === m && r.config.encoderEp === 'webgpu',
      );
      const ratio = w4 && n4 ? f(w4.encode.median / n4.encode.median, 1) : '-';
      return [
        m,
        weights[m] ?? '?',
        medMin(n1?.encode),
        medMin(n4?.encode),
        medMin(w1?.encode),
        medMin(w4?.encode),
        ratio,
        medMin(n1?.decodeClick, 1),
        medMin(n4?.decodeClick, 1),
        medMin(w1?.decodeClick, 1),
        medMin(w4?.decodeClick, 1),
        medMin(w4?.decodeBoxPoints, 1),
        medMin(gd?.decodeClick, 1),
        ge
          ? ge.error
            ? ge.partial?.firstEncode
              ? `first ${f(ge.partial.firstEncode)}`
              : ge.error.slice(0, 18)
            : `first ${f(ge.firstEncode)}`
          : '-',
      ];
    });
    table(rows, [
      'model',
      'weights',
      'enc nat t1',
      'enc nat t4',
      'enc wasm t1',
      'enc wasm t4',
      'wasm/nat',
      'dec nat t1',
      'dec nat t4',
      'dec wasm t1',
      'dec wasm t4',
      'dec box+2pt t4',
      'dec webgpu',
      'enc webgpu',
    ]);

    console.log(
      '\nH1  CPU time per call, ms (all threads / processes; robust to machine load). For t=1, CPU ~= idle-machine wall time.',
    );
    const cpuRows = models.map((m) => {
      const pick = (arr, pred) => (arr ?? []).find((r) => !r.error && pred(r.config))?.cpu ?? {};
      const n1 = pick(results.native, (c) => c.model === m && c.threads === 1);
      const n4 = pick(results.native, (c) => c.model === m && c.threads === 4);
      const w1 = pick(
        results.models,
        (c) => c.model === m && c.encoderEp === 'wasm' && c.decoderEp === 'wasm' && c.threads === 1,
      );
      const w4 = pick(
        results.models,
        (c) => c.model === m && c.encoderEp === 'wasm' && c.decoderEp === 'wasm' && c.threads === 4,
      );
      const gd = pick(results.models, (c) => c.model === m && c.decoderEp === 'webgpu');
      const ge = pick(results.models, (c) => c.model === m && c.encoderEp === 'webgpu');
      return [
        m,
        f(n1.encodeMs),
        f(n4.encodeMs),
        f(w1.encodeMs),
        f(w4.encodeMs),
        w1.encodeMs && n1.encodeMs ? f(w1.encodeMs / n1.encodeMs, 1) : '-',
        f(n1.decodeMs, 1),
        f(n4.decodeMs, 1),
        f(w1.decodeMs, 1),
        f(w4.decodeMs, 1),
        f(gd.decodeMs, 1),
        f(ge.encodeMs),
      ];
    });
    table(cpuRows, [
      'model',
      'enc nat t1',
      'enc nat t4',
      'enc wasm t1',
      'enc wasm t4',
      'wasm/nat t1',
      'dec nat t1',
      'dec nat t4',
      'dec wasm t1',
      'dec wasm t4',
      'dec webgpu',
      'enc webgpu',
    ]);
  }

  const runs = [...(results.e2e ?? []), ...(results.remote ?? [])];
  for (const run of runs) {
    const c = run.config;
    console.log(
      `\nH2/H3  ${c.mode} ${c.model} threads=${c.threads}  (load1 ${f(run.loadavg?.[0], 1)} -> ${f(run.loadavg?.[1], 1)})`,
    );
    const rows = run.steps.map((s) => {
      if (s.error)
        return [s.id, 'ERROR', s.error.slice(0, 60), '', '', '', '', '', '', '', '', '', '', ''];
      const r = s.events?.find((e) => e.type === 'result');
      const p = s.events?.find((e) => e.type === 'painted');
      const fr = s.events?.find((e) => e.type === 'frames');
      const t = r?.timings ?? {};
      const a = s.analysis ?? {};
      const commit = s.commitMask?.events?.find((e) => e.type === 'commit');
      const read = (t.readFetch ?? 0) + (t.readComposite ?? 0) + (t.readback ?? 0) || t.serverRead;
      const gt =
        a.groundTruthIoU !== undefined
          ? `${f(a.groundTruthIoU, 2)}${s.altGroundTruthIoU !== undefined ? `/${f(s.altGroundTruthIoU, 2)}` : ''}`
          : '-';
      return [
        s.id,
        r?.cached ? 'hit' : 'miss',
        f(p?.latency),
        f(s.browserCpuMs),
        f(read),
        f(t.encode ?? t.serverEncode),
        f(t.decode, 1),
        f(t.roundTrip),
        f(fr?.maxGap),
        fr?.fps !== undefined ? `${f(fr.fps)} / ${f(fr.longTaskMs)}` : '-',
        f(r?.view?.scale, 4),
        gt,
        f((a.maskBoxPixels ?? 0) / 1e6, 1),
        commit?.output ?? '-',
      ];
    });
    table(rows, [
      'step',
      'cache',
      'click->paint',
      'browser cpu',
      'read',
      'encode',
      'decode',
      'net rt',
      'max frame gap',
      'fps / long-task ms',
      'scale',
      'GT IoU (/alt)',
      'mask box Mpx',
      'commit',
    ]);
  }
  printInt8(results);
  printQuality(results);
  printResponsiveness(results);
  if (results.webgpuGate)
    console.log(`\nWebGPU gate verdict: ${JSON.stringify(results.webgpuGate)}`);
  for (const x of results.f16check ?? []) {
    console.log(
      `f16 wire check ${x.id}: mask IoU f32 vs f16 ${x.perCandidate?.map((c) => f(c.iou, 4)).join(', ')}; ` +
        `max |logit diff| ${f(Math.max(...(x.perCandidate ?? []).map((c) => c.maxLogitDiff)), 3)}`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) throw new Error('usage: node scripts/summary.mjs <results.json>');
  const { MODEL_TABLE } = await import('./model-table.mjs');
  printSummary(JSON.parse(fs.readFileSync(file, 'utf8')), MODEL_TABLE);
}
