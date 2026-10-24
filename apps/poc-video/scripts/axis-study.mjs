/**
 * Frame-axis writer study (Node): a frame stored by *time* is resolved back
 * to an index on the axis a reader's demuxer builds. Which lookup survives
 * every way the stored time can disagree with the reader's timestamps?
 *
 * Reader axis: mediabunny 1.62.1's demux of the file, run here in Node, in
 * integer microseconds (it truncates). Ground truth: ffprobe's pts table in
 * media/manifest.json (fractional microseconds), or, for the browser
 * writers, the barcode of the frame that was on screen.
 *
 * Writers, per frame i (synthetic, every frame of every video):
 *   start µs round      Math.round(pts): FrameRef.timeUs as @osdlabel/temporal defines it
 *   start µs trunc      Math.trunc(pts): what mediabunny itself reports
 *   start s float       pts / 1e6 stored as seconds, read back * 1e6
 *   start ms round      pts rounded to milliseconds (JSON, CVAT, a 1 ms WebM timebase)
 *   start ms trunc      pts truncated to milliseconds
 *   nominal i/fps       i * fpsDen / fpsNum seconds (a constant-rate writer)
 *   table-mid s         midpoint of the frame's demuxed span, seconds (the PoC's element seek target)
 *   in-span s           a time uniform in the frame's span, seconds (a paused currentTime)
 *   in-span ms          the same rounded to milliseconds
 * Writers recorded in Chromium by the H1 run (when it ran):
 *   element currentTime after seek    currentTime read at `seeked`, every H1 element op; truth = barcode after presentation
 *   element rVFC mediaTime after seek requestVideoFrameCallback mediaTime of the same ops
 *   paused currentTime                currentTime after pausing playback at a random moment; truth = barcode on screen
 *   paused rVFC mediaTime             mediaTime of the last frame presented before that pause
 *
 * Rules:
 *   at-or-before  frameAt(t): what is on screen at t
 *   nearest       nearestFrame(t)
 *   reconcile     reconcileFrame(t) = frameAt(t + min(1 ms, frame / 4))
 */
import fs from 'node:fs';
import path from 'node:path';
import { BufferSource, EncodedPacketSink, Input, MP4, WEBM } from 'mediabunny';
import { mulberry32 } from './rng.mjs';

export function rateClass(v) {
  if (v.vfr) return 'VFR';
  if (v.fpsNum === 30000 && v.fpsDen === 1001) return 'CFR 29.97';
  return `CFR ${v.fpsNum / v.fpsDen}`;
}

async function demuxTimestampsUs(file) {
  const input = new Input({
    source: new BufferSource(fs.readFileSync(file)),
    formats: [MP4, WEBM],
  });
  try {
    const track = await input.getPrimaryVideoTrack();
    const ts = [];
    for await (const p of new EncodedPacketSink(track).packets()) ts.push(p.microsecondTimestamp);
    return ts.sort((a, b) => a - b);
  } finally {
    input.dispose();
  }
}

const RULES = ['atOrBefore', 'nearest', 'reconcile'];

export async function runAxisStudy(manifest, mediaDir, { h1 = null, pauses = null } = {}) {
  const t = await import('@osdlabel/temporal');
  const rule = {
    atOrBefore: t.frameAt,
    nearest: t.nearestFrame,
    reconcile: (axis, x) => t.reconcileFrame(axis, x),
  };
  const perVideo = [];
  const pooled = new Map();
  const add = (cls, writer, kind, video, truthIdx, timeUs, axis) => {
    const key = `${cls}|${writer}`;
    let p = pooled.get(key);
    if (p === undefined) {
      p = {
        rateClass: cls,
        writer,
        kind,
        n: 0,
        wrong: { atOrBefore: 0, nearest: 0, reconcile: 0 },
      };
      pooled.set(key, p);
    }
    p.n++;
    video.n[writer] = (video.n[writer] ?? 0) + 1;
    for (const r of RULES) {
      if (rule[r](axis, timeUs) !== truthIdx) {
        p.wrong[r]++;
        video.wrong[writer] ??= { atOrBefore: 0, nearest: 0, reconcile: 0 };
        video.wrong[writer][r]++;
      }
    }
  };
  for (const [name, v] of Object.entries(manifest)) {
    const demuxed = await demuxTimestampsUs(path.join(mediaDir, v.file));
    if (demuxed.length !== v.frameCount)
      throw new Error(`${name}: demux has ${demuxed.length} frames`);
    const durUs = (1e6 * v.fpsDen) / v.fpsNum;
    const axis = t.createTimestampAxis(demuxed, durUs);
    const truth = v.ptsUs;
    const end = (i) => truth[i + 1] ?? truth[i] + durUs;
    let maxDemuxErrUs = 0;
    for (let i = 0; i < v.frameCount; i++) {
      maxDemuxErrUs = Math.max(maxDemuxErrUs, Math.abs(demuxed[i] - truth[i]));
    }
    const rnd = mulberry32(12345);
    const writers = {
      'start µs round': (i) => Math.round(truth[i]),
      'start µs trunc': (i) => Math.trunc(truth[i]),
      'start s float': (i) => (truth[i] / 1e6) * 1e6,
      'start ms round': (i) => Math.round(truth[i] / 1000) * 1000,
      'start ms trunc': (i) => Math.floor(truth[i] / 1000) * 1000,
      'nominal i/fps': (i) => ((i * v.fpsDen) / v.fpsNum) * 1e6,
      'table-mid s': (i) => ((truth[i] + end(i)) / 2e6) * 1e6,
      'in-span s': (i) => ((truth[i] + rnd() * (end(i) - truth[i])) / 1e6) * 1e6,
      'in-span ms': (i) => Math.round((truth[i] + rnd() * (end(i) - truth[i])) / 1000) * 1000,
    };
    const cls = rateClass(v);
    const video = { video: name, rateClass: cls, maxDemuxErrUs, n: {}, wrong: {} };
    for (const [writer, timeOf] of Object.entries(writers)) {
      for (let i = 0; i < v.frameCount; i++)
        add(cls, writer, 'synthetic', video, i, timeOf(i), axis);
    }
    for (const res of Object.values(h1?.[name]?.videoElement ?? {})) {
      for (const r of res) {
        if (r.got < 0) continue;
        if (r.currentTime !== undefined) {
          add(
            cls,
            'element currentTime after seek',
            'browser',
            video,
            r.got,
            r.currentTime * 1e6,
            axis,
          );
        }
        if (r.rvfcFired && r.mediaTime !== undefined && r.mediaTime >= 0) {
          add(
            cls,
            'element rVFC mediaTime after seek',
            'browser',
            video,
            r.got,
            r.mediaTime * 1e6,
            axis,
          );
        }
      }
    }
    for (const s of pauses?.[name] ?? []) {
      if (s.got < 0) continue;
      add(cls, 'paused currentTime', 'browser', video, s.got, s.currentTime * 1e6, axis);
      if (s.lastMediaTime >= 0) {
        add(cls, 'paused rVFC mediaTime', 'browser', video, s.got, s.lastMediaTime * 1e6, axis);
      }
    }
    perVideo.push(video);
  }
  const rows = [...pooled.values()].map((p) => ({
    rateClass: p.rateClass,
    writer: p.writer,
    kind: p.kind,
    n: p.n,
    wrongAtOrBefore: p.wrong.atOrBefore,
    wrongNearest: p.wrong.nearest,
    wrongReconcile: p.wrong.reconcile,
    pctAtOrBefore: Math.round((1000 * p.wrong.atOrBefore) / p.n) / 10,
    pctNearest: Math.round((1000 * p.wrong.nearest) / p.n) / 10,
    pctReconcile: Math.round((1000 * p.wrong.reconcile) / p.n) / 10,
  }));
  rows.sort((a, b) => a.writer.localeCompare(b.writer) || a.rateClass.localeCompare(b.rateClass));
  return {
    note: 'wrong = stored times resolved to another frame than the truth (frame index for synthetic writers, on-screen barcode for browser writers). Reader axis = mediabunny demux in integer µs. reconcile = frameAt(t + min(1 ms, frame/4)).',
    rows,
    perVideo,
  };
}
