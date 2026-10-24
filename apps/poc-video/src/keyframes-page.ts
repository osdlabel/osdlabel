/**
 * Keyframes as ordinary annotations vs a TrackDocument (review priority 4).
 *
 * Both formats store the same 1,000 mixed tracks x 10 keyframes (50 mask
 * tracks with real pixels), go through JSON, are validated, and are turned
 * back into tracks on a *reader* axis whose timestamps are the writer's
 * truncated to integer microseconds (what another demuxer produces). The
 * round trip is checked by sampling every track on every frame against the
 * original. Runs in the browser because osdlabel's barrel (serialize,
 * deserialize, createAnnotationFromGeometry) loads OpenSeadragon and Fabric.
 */
import type { Geometry, ToolType } from '@osdlabel/annotation';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { encodeCanonical } from '@osdlabel/mask';
import type { MaskSnapshot } from '@osdlabel/mask';
import {
  createConstantRateAxis,
  createTimestampAxis,
  createTrack,
  frameRefOf,
  groupKeyframeAnnotations,
  resolveFrameRef,
  sampleTrack,
  toTrackDocument,
} from '@osdlabel/temporal';
import type { Keyframe, KeyframeFields, TrackBase } from '@osdlabel/temporal';
import { createImageId } from '@osdlabel/viewer-api';
import type { AnnotationState } from '@osdlabel/viewer-api';
import {
  createAnnotationFromGeometry,
  createMaskAnnotation,
  deserialize,
  maskAnnotationFields,
  serialize,
} from 'osdlabel';
import type { OsdAnnotation, OsdFields } from 'osdlabel';
import type { KeyframeAnnotation, StoredTrack, TrackDocumentV2 } from './lib/keyframe-io.js';
import {
  deserializeKeyframeAnnotations,
  keyframeAnnotationId,
  parseTrackDocument,
} from './lib/keyframe-io.js';
import { buildFixtureTracks, FIXTURE_FRAMES } from './lib/track-fixtures.js';
import type { FixtureKind, FixtureTrack } from './lib/track-fixtures.js';

const imageId = createImageId('clip');
const contextId = createAnnotationContextId('video');
/** Writer's axis: 30 fps, ffprobe-exact. Reader's: the same, truncated to µs. */
const writerAxis = createConstantRateAxis(FIXTURE_FRAMES, 30000, 1001);
const readerAxis = createTimestampAxis(writerAxis.positions.map(Math.trunc), 33367);

const toolTypeFor = (kind: FixtureKind): ToolType => {
  switch (kind) {
    case 'rectangle':
    case 'circle':
    case 'point':
    case 'line':
      return kind;
    case 'mask':
      return 'segmentationBrush';
    default:
      return 'polyline';
  }
};

function buildKeyframeAnnotations(fixtures: readonly FixtureTrack[]): KeyframeAnnotation[] {
  const out: KeyframeAnnotation[] = [];
  for (const { kind, track } of fixtures) {
    track.keyframes.forEach((kf, k) => {
      const id = keyframeAnnotationId(track.id, k);
      const opts = { imageId, contextId, id, label: kind };
      const g = kf.geometry;
      const base: OsdAnnotation =
        g.type === 'mask'
          ? createMaskAnnotation(kf.payload!, opts)
          : createAnnotationFromGeometry(g, { ...opts, toolType: toolTypeFor(kind) });
      out.push({
        ...base,
        trackId: track.id,
        frame: frameRefOf(writerAxis, kf.frame),
        visibility: kf.visibility,
      });
    });
  }
  return out;
}

function buildTrackDocument(fixtures: readonly FixtureTrack[]): TrackDocumentV2 {
  const tracks: StoredTrack[] = fixtures.map(({ kind, track }) => ({
    id: track.id,
    imageId,
    contextId,
    label: kind,
    geometryType: track.geometryType,
    keyframes: track.keyframes.map((kf) => ({
      frame: frameRefOf(writerAxis, kf.frame),
      geometry: kf.geometry,
      visibility: kf.visibility,
      ...(kf.payload !== undefined
        ? { mask: maskAnnotationFields(kf.payload).rawAnnotationData as never }
        : {}),
    })),
  }));
  return { format: 'osdlabel-tracks', version: 2, tracks };
}

/** Mask pixels in a comparable form, whatever the payload type. */
function maskKey(payload: unknown): string | null {
  if (payload === undefined || payload === null) return null;
  if (typeof payload === 'object' && 'data' in payload && payload.data instanceof Uint8Array) {
    return encodeCanonical(payload as MaskSnapshot).counts;
  }
  const raw =
    typeof payload === 'object' && 'rawAnnotationData' in payload
      ? (payload as OsdAnnotation).rawAnnotationData
      : payload;
  const data = (raw as { data?: { counts?: unknown } }).data;
  return typeof data?.counts === 'string' ? data.counts : null;
}

/** Sample every track on every frame and count disagreements with the original. */
function compareTracks(
  original: readonly FixtureTrack[],
  loaded: readonly TrackBase<unknown>[],
): { tracks: number; samples: number; mismatches: number; missingTracks: number } {
  const byId = new Map(loaded.map((t) => [t.id as string, t]));
  let samples = 0;
  let mismatches = 0;
  let missingTracks = 0;
  for (const { track } of original) {
    const l = byId.get(track.id);
    if (l === undefined) {
      missingTracks++;
      continue;
    }
    for (let f = 0; f < FIXTURE_FRAMES; f++) {
      samples++;
      const a = sampleTrack(track, f);
      const b = sampleTrack(l, f);
      if (a === null || b === null) {
        if (a !== b) mismatches++;
        continue;
      }
      if (
        a.visibility !== b.visibility ||
        a.source !== b.source ||
        JSON.stringify(a.geometry) !== JSON.stringify(b.geometry) ||
        maskKey(a.payload) !== maskKey(b.payload)
      ) {
        mismatches++;
      }
    }
  }
  return { tracks: loaded.length, samples, mismatches, missingTracks };
}

async function gzipBytes(text: string): Promise<number> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return (await new Response(stream).arrayBuffer()).byteLength;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function time<T>(reps: number, fn: () => T): { ms: number; value: T } {
  const ms: number[] = [];
  let value: T = fn();
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    value = fn();
    ms.push(performance.now() - t0);
  }
  return { ms: Math.round(median(ms) * 100) / 100, value };
}

async function run(reps = 5): Promise<Record<string, unknown>> {
  const fixtures = buildFixtureTracks(1);
  const keyframes = fixtures.reduce((n, f) => n + f.track.keyframes.length, 0);

  // ── A: keyframes as ordinary annotations ─────────────────────────────
  const buildA = time(reps, () => buildKeyframeAnnotations(fixtures));
  const state: AnnotationState<OsdFields> = {
    byImage: { [imageId]: Object.fromEntries(buildA.value.map((a) => [a.id, a])) },
    changeCounter: 1,
  };
  const writeA = time(reps, () => JSON.stringify(serialize(state)));
  const jsonA = writeA.value;
  const parseA = time(reps, () => JSON.parse(jsonA) as unknown);
  const baseOnly = time(reps, () => deserialize(parseA.value));
  const loadA = time(reps, () => deserializeKeyframeAnnotations(parseA.value));
  const groupA = time(reps, () => groupKeyframeAnnotations(loadA.value.annotations, readerAxis));
  const firstLoaded = Object.values(baseOnly.value.byImage[imageId] ?? {})[0] as
    | Record<string, unknown>
    | undefined;
  const rawBytes = buildA.value.reduce((n, a) => n + JSON.stringify(a.rawAnnotationData).length, 0);
  const vectorRawBytes = buildA.value
    .filter((a) => a.geometry.type !== 'mask')
    .reduce((n, a) => n + JSON.stringify(a.rawAnnotationData).length, 0);
  const vectorCount = buildA.value.filter((a) => a.geometry.type !== 'mask').length;
  const roundTripA = compareTracks(fixtures, groupA.value.tracks);

  // ── B: TrackDocument (complete: image/context/label, FrameRef, masks) ──
  const buildB = time(reps, () => buildTrackDocument(fixtures));
  const writeB = time(reps, () => JSON.stringify(buildB.value));
  const jsonB = writeB.value;
  const parseB = time(reps, () => JSON.parse(jsonB) as unknown);
  const validateB = time(reps, () => parseTrackDocument(parseB.value));
  const toTracksB = time(reps, () =>
    validateB.value.tracks.map((t) =>
      createTrack<unknown>({
        id: t.id as TrackBase['id'],
        geometryType: t.geometryType,
        keyframes: t.keyframes.map(
          (k): Keyframe<unknown> => ({
            frame: resolveFrameRef(readerAxis, k.frame),
            geometry: k.geometry as Geometry,
            visibility: k.visibility,
            ...(k.mask !== undefined ? { payload: k.mask } : {}),
          }),
        ),
      }),
    ),
  );
  const roundTripB = compareTracks(fixtures, toTracksB.value);

  // The PoC's first TrackDocument (index frames, no image/context/label, no mask pixels).
  const v1 = JSON.stringify(
    toTrackDocument(
      fixtures.map(({ track }) => ({
        ...track,
        keyframes: track.keyframes.map(({ frame, geometry, visibility }) => ({
          frame,
          geometry,
          visibility,
        })),
      })),
    ),
  );

  const keyframeFieldsSurviveDeserialize =
    firstLoaded !== undefined && 'trackId' in firstLoaded && 'frame' in firstLoaded;

  const rows = [
    {
      format: 'A keyframe annotations (serialize/deserialize)',
      tracks: fixtures.length,
      keyframes,
      jsonBytes: jsonA.length,
      gzipBytes: await gzipBytes(jsonA),
      buildMs: buildA.ms,
      stringifyMs: writeA.ms,
      parseMs: parseA.ms,
      validateMs: loadA.ms,
      toTracksMs: groupA.ms,
      roundTripMismatches: roundTripA.mismatches,
      samplesCompared: roundTripA.samples,
    },
    {
      format: 'B TrackDocument v2 (complete, Valibot schema)',
      tracks: fixtures.length,
      keyframes,
      jsonBytes: jsonB.length,
      gzipBytes: await gzipBytes(jsonB),
      buildMs: buildB.ms,
      stringifyMs: writeB.ms,
      parseMs: parseB.ms,
      validateMs: validateB.ms,
      toTracksMs: toTracksB.ms,
      roundTripMismatches: roundTripB.mismatches,
      samplesCompared: roundTripB.samples,
    },
    {
      format: 'B0 TrackDocument v1 (first PoC: index only, no masks/context)',
      tracks: fixtures.length,
      keyframes,
      jsonBytes: v1.length,
      gzipBytes: await gzipBytes(v1),
    },
  ];
  return {
    rows,
    a: {
      deserializeOnlyMs: baseOnly.ms,
      keyframeFieldPassMs: Math.round((loadA.ms - baseOnly.ms) * 100) / 100,
      keyframeFieldsSurviveDeserialize,
      rawAnnotationDataBytes: rawBytes,
      vectorRawAnnotationDataBytesPerKeyframe: Math.round(vectorRawBytes / vectorCount),
      conflicts: groupA.value.conflicts.length,
      mismatched: groupA.value.mismatched.length,
      skipped: loadA.value.skipped.length,
      roundTrip: roundTripA,
      sampleKeyframe: buildA.value[0],
    },
    b: { roundTrip: roundTripB },
    readerAxis: 'writer 30000/1001 axis truncated to integer µs',
    reps,
  };
}

declare global {
  interface Window {
    __keyframes: { run: typeof run; ready: boolean };
  }
}

window.__keyframes = { run, ready: true };
export type { KeyframeFields };
