import type { DicomDataset, FrameIndex, Part10File } from '@osdlabel/dicom';
import {
  frameData,
  fromDicomJson,
  indexFrames,
  readPart10,
  TAGS,
  type DicomJsonDataset,
} from '@osdlabel/dicom';
import type { PyramidInstance } from './pyramid.js';

/** Compressed (or native) bytes of one frame, with the syntax they are encoded in. */
export interface FrameBytes {
  readonly bytes: Uint8Array;
  readonly transferSyntaxUid: string;
}

/** Statistics a source reports per frame fetch, for the benchmark. */
export interface FrameFetchStat {
  readonly sopInstanceUid: string;
  readonly frameNumber: number;
  readonly bytes: number;
  readonly ms: number;
  /** Network requests this fetch issued (0 when served from an already-fetched file). */
  readonly requests: number;
}

/**
 * Where frames come from. The tile source only ever asks for "frame n of
 * instance u", so swapping local files for DICOMweb (or a cache, or a
 * service worker) does not touch rendering.
 */
export interface FrameSource {
  /** Instance headers for {@link describePyramid}. */
  instances(signal?: AbortSignal): Promise<readonly PyramidInstance[]>;
  frame(sopInstanceUid: string, frameNumber: number, signal?: AbortSignal): Promise<FrameBytes>;
  onFetch?: ((stat: FrameFetchStat) => void) | undefined;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

// ── Part 10 files, fetched whole ───────────────────────────────────────────

/**
 * Whole Part 10 files (local or static hosting): each instance is fetched once,
 * indexed, and frames are sliced out of memory. Simple and robust (works with
 * any offset table); the cost is downloading every level in full.
 */
export function createPart10FrameSource(options: {
  readonly urls: readonly string[];
  readonly fetch?: Fetch;
}): FrameSource {
  const fetchFn: Fetch = options.fetch ?? ((u, i) => fetch(u, i));
  const files = new Map<string, { file: Part10File; index: FrameIndex }>();
  const src: FrameSource = {
    async instances(signal) {
      const out: PyramidInstance[] = [];
      await Promise.all(
        options.urls.map(async (url) => {
          const res = await fetchFn(url, signal ? { signal } : {});
          const file = readPart10(new Uint8Array(await res.arrayBuffer()));
          const uid = file.dataset.strings(TAGS.SOPInstanceUID.tag)?.[0] ?? url;
          if (file.pixelData) {
            try {
              files.set(uid, { file, index: indexFrames(file) });
            } catch {
              // Associated images we cannot index are not levels anyway.
            }
          }
          out.push({ dataset: file.dataset, transferSyntaxUid: file.transferSyntaxUid });
        }),
      );
      return out;
    },
    async frame(uid, n) {
      const t0 = performance.now();
      const f = files.get(uid);
      const range = f?.index.frames[n - 1];
      if (!f || !range) throw new Error(`frame ${n} of ${uid} not available`);
      const bytes = frameData(f.file.source, range);
      src.onFetch?.({
        sopInstanceUid: uid,
        frameNumber: n,
        bytes: bytes.length,
        ms: performance.now() - t0,
        requests: 0,
      });
      return { bytes, transferSyntaxUid: f.file.transferSyntaxUid };
    },
  };
  return src;
}

// ── Part 10 files via HTTP Range (static hosting: a bucket, a CDN) ─────────

/**
 * Part 10 files on static hosting, read with HTTP Range requests: one request
 * for the header (grown until it covers the Pixel Data offset table), then one
 * per frame. Needs an offset table (Basic or Extended); an empty Basic Offset
 * Table would need a fragment walk, which this falls back to with a full GET.
 */
export function createRangeFrameSource(options: {
  readonly urls: readonly string[];
  readonly fetch?: Fetch;
  readonly headerBytes?: number;
}): FrameSource {
  const fetchFn: Fetch = options.fetch ?? ((u, i) => fetch(u, i));
  const meta = new Map<
    string,
    { url: string; ts: string; frames: { offset: number; length: number }[] }
  >();
  const full = new Map<string, { bytes: Uint8Array; index: FrameIndex }>();
  const src: FrameSource = {
    async instances(signal) {
      const out: PyramidInstance[] = [];
      await Promise.all(
        options.urls.map(async (url) => {
          let size = options.headerBytes ?? 262144;
          for (;;) {
            const res = await fetchFn(url, {
              headers: { Range: `bytes=0-${size - 1}` },
              ...(signal ? { signal } : {}),
            });
            const head = new Uint8Array(await res.arrayBuffer());
            const total = Number(
              /\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1] ?? head.length,
            );
            const file = readPart10(head, { untilTag: TAGS.PixelData.tag });
            const px = file.pixelData;
            const uid = file.dataset.strings(TAGS.SOPInstanceUID.tag)?.[0] ?? url;
            const complete = !file.truncated || head.length < size;
            if (px && px.length === undefined) {
              // Encapsulated: we need the Basic Offset Table item in full.
              const botEnd = botExtent(head, px.offset);
              if (botEnd === undefined && !complete) {
                size *= 4;
                continue;
              }
              out.push({ dataset: file.dataset, transferSyntaxUid: file.transferSyntaxUid });
              const frames =
                botEnd !== undefined
                  ? framesFromBot(head, px.offset, file.dataset, total)
                  : undefined;
              if (frames) meta.set(uid, { url, ts: file.transferSyntaxUid, frames });
              else {
                // Empty BOT: fall back to fetching the whole file once.
                const all = new Uint8Array(
                  await (await fetchFn(url, signal ? { signal } : {})).arrayBuffer(),
                );
                const f = readPart10(all);
                full.set(uid, { bytes: all, index: indexFrames(f) });
                meta.set(uid, { url, ts: f.transferSyntaxUid, frames: [] });
              }
              return;
            }
            if (!px && !complete) {
              size *= 4;
              continue;
            }
            out.push({ dataset: file.dataset, transferSyntaxUid: file.transferSyntaxUid });
            return;
          }
        }),
      );
      return out;
    },
    async frame(uid, n, signal) {
      const m = meta.get(uid);
      if (!m) throw new Error(`unknown instance ${uid}`);
      const t0 = performance.now();
      const whole = full.get(uid);
      if (whole) {
        const bytes = frameData(whole.bytes, whole.index.frames[n - 1]!);
        src.onFetch?.({
          sopInstanceUid: uid,
          frameNumber: n,
          bytes: bytes.length,
          ms: performance.now() - t0,
          requests: 0,
        });
        return { bytes, transferSyntaxUid: m.ts };
      }
      const r = m.frames[n - 1];
      if (!r) throw new Error(`frame ${n} of ${uid} out of range`);
      const res = await fetchFn(m.url, {
        headers: { Range: `bytes=${r.offset}-${r.offset + r.length - 1}` },
        ...(signal ? { signal } : {}),
      });
      const bytes = new Uint8Array(await res.arrayBuffer());
      src.onFetch?.({
        sopInstanceUid: uid,
        frameNumber: n,
        bytes: bytes.length,
        ms: performance.now() - t0,
        requests: 1,
      });
      return { bytes, transferSyntaxUid: m.ts };
    },
  };
  return src;
}

/** End offset of the Basic Offset Table item if fully contained in `head`. */
function botExtent(head: Uint8Array, offset: number): number | undefined {
  if (offset + 8 > head.length) return undefined;
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const len = v.getUint32(offset + 4, true);
  const end = offset + 8 + len;
  // Also need the first fragment's item header to anchor offsets.
  return end + 8 <= head.length ? end : undefined;
}

/** Frame byte ranges from a non-empty BOT: frame k spans [bot[k], bot[k+1]) minus item headers. */
function framesFromBot(
  head: Uint8Array,
  offset: number,
  ds: DicomDataset,
  fileSize: number,
): { offset: number; length: number }[] | undefined {
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const botLen = v.getUint32(offset + 4, true);
  if (botLen === 0) return undefined;
  const firstItem = offset + 8 + botLen;
  const count = ds.numbers(TAGS.NumberOfFrames.tag)?.[0] ?? botLen / 4;
  const offs: number[] = [];
  for (let i = 0; i < botLen / 4; i++) offs.push(v.getUint32(offset + 8 + i * 4, true));
  if (offs.length !== count) return undefined;
  // PoC: assumes one fragment per frame (true of every IDC WSI we fetched);
  // the fragment's own item header gives its exact length, but reading it
  // would cost a request, so the length is derived from the next offset —
  // and, for the last frame, from the file size minus the 8-byte sequence
  // delimiter (assuming Pixel Data is the last element, as it is here).
  return offs.map((o, i) => {
    const start = firstItem + o + 8;
    const next = i + 1 < offs.length ? firstItem + offs[i + 1]! : fileSize - 8;
    return { offset: start, length: next - start };
  });
}

// ── DICOMweb (WADO-RS) ─────────────────────────────────────────────────────

/** Extracts the first part's body from a `multipart/related` response. */
export function firstMultipartPart(body: Uint8Array, contentType: string): Uint8Array {
  const m = /boundary="?([^";]+)"?/i.exec(contentType);
  if (!m) return body;
  const boundary = new TextEncoder().encode(`--${m[1]}`);
  const find = (from: number, needle: Uint8Array): number => {
    outer: for (let i = from; i <= body.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) if (body[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  };
  const start = find(0, boundary);
  if (start < 0) return body;
  const headerEnd = find(start, new Uint8Array([13, 10, 13, 10]));
  const end = find(headerEnd + 4, boundary);
  // The body ends with CRLF before the next boundary.
  return body.subarray(headerEnd + 4, end < 0 ? body.length : end - 2);
}

/**
 * DICOMweb: series metadata from `…/series/{uid}/metadata` (the DICOM JSON
 * model, read through `fromDicomJson`) and each frame from
 * `…/instances/{uid}/frames/{n}` (WADO-RS), the production path.
 */
export function createDicomWebFrameSource(options: {
  readonly baseUrl: string;
  readonly studyInstanceUid: string;
  readonly seriesInstanceUid: string;
  readonly fetch?: Fetch;
  /** Ask for the stored transfer syntax (default), so frames arrive still compressed. */
  readonly accept?: string;
}): FrameSource {
  const fetchFn: Fetch = options.fetch ?? ((u, i) => fetch(u, i));
  const series = `${options.baseUrl}/studies/${options.studyInstanceUid}/series/${options.seriesInstanceUid}`;
  const syntax = new Map<string, string>();
  const src: FrameSource = {
    async instances(signal) {
      const res = await fetchFn(`${series}/metadata`, {
        headers: { Accept: 'application/dicom+json' },
        ...(signal ? { signal } : {}),
      });
      const json = (await res.json()) as DicomJsonDataset[];
      return json.map((j) => {
        const dataset = fromDicomJson(j);
        const uid = dataset.strings(TAGS.SOPInstanceUID.tag)?.[0] ?? '';
        const ts = dataset.strings(TAGS.TransferSyntaxUID.tag)?.[0];
        if (ts) syntax.set(uid, ts);
        return { dataset, transferSyntaxUid: ts };
      });
    },
    async frame(uid, n, signal) {
      const t0 = performance.now();
      const res = await fetchFn(`${series}/instances/${uid}/frames/${n}`, {
        headers: {
          Accept:
            options.accept ??
            'multipart/related; type="application/octet-stream"; transfer-syntax=*',
        },
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) throw new Error(`frame ${n} of ${uid}: HTTP ${res.status}`);
      const body = new Uint8Array(await res.arrayBuffer());
      const ct = res.headers.get('content-type') ?? '';
      const bytes = ct.startsWith('multipart/') ? firstMultipartPart(body, ct) : body;
      const partTs = /transfer-syntax=([0-9.]+)/.exec(ct)?.[1];
      src.onFetch?.({
        sopInstanceUid: uid,
        frameNumber: n,
        bytes: bytes.length,
        ms: performance.now() - t0,
        requests: 1,
      });
      return { bytes, transferSyntaxUid: partTs ?? syntax.get(uid) ?? '1.2.840.10008.1.2.4.50' };
    },
  };
  return src;
}
