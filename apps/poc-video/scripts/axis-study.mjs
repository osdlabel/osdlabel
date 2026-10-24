/**
 * Frame-axis study (Node, no browser): a frame stored by *time* is mapped
 * back to an index on the axis a demuxer builds. Which lookup survives the
 * two ways the writer's time and the reader's timestamps disagree in
 * practice?
 *
 *   writer 'index/fps'  time = i * fpsDen / fpsNum (a nominal-rate writer)
 *   writer 'ms'         the true pts rounded to milliseconds (JSON / CVAT /
 *                       a WebM writer's 1 ms timebase)
 *   writer 'exact'      the true pts in seconds (a float round trip)
 *
 *   lookup 'at-or-before'  last frame whose pts <= t (frameAt / the frame
 *                          PoC's frameIndexAtTime: what is on screen at t)
 *   lookup 'nearest'       frame whose pts is nearest t (nearestFrame)
 *
 * Ground truth is ffprobe's pts table in media/manifest.json. A mismatch is
 * an annotation silently re-attached to the neighbouring frame on reload.
 */
import { createTimestampAxis, frameAt, nearestFrame } from '@osdlabel/temporal';

export function runAxisStudy(manifest) {
  const rows = [];
  for (const [name, v] of Object.entries(manifest)) {
    const axis = createTimestampAxis(v.ptsUs, (1e6 * v.fpsDen) / v.fpsNum);
    const writers = {
      'index/fps': (i) => (i * v.fpsDen) / v.fpsNum,
      ms: (i) => Math.round(v.ptsUs[i] / 1000) / 1000,
      exact: (i) => v.ptsUs[i] / 1e6,
    };
    for (const [writer, timeOf] of Object.entries(writers)) {
      let atOrBefore = 0;
      let near = 0;
      for (let i = 0; i < v.frameCount; i++) {
        const tUs = timeOf(i) * 1e6;
        if (frameAt(axis, tUs) !== i) atOrBefore++;
        if (nearestFrame(axis, tUs) !== i) near++;
      }
      rows.push({
        video: name,
        vfr: v.vfr,
        timeBase: v.timeBase,
        writer,
        frames: v.frameCount,
        wrongAtOrBefore: atOrBefore,
        wrongNearest: near,
      });
    }
  }
  return {
    note: 'frames (of 300) whose stored time maps back to another index; at-or-before = frameAt (= the frame PoC frameIndexAtTime used by reconcileFrameRefs), nearest = nearestFrame',
    rows,
  };
}
