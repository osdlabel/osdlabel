import type {
  EncodeView,
  MaskCandidate,
  ProviderCapabilities,
  RasterFrame,
  SegmentationProvider,
} from '@osdlabel/segmentation';
import { decodeWire } from './wire.js';

interface SegmentMeta {
  readonly view: EncodeView;
  readonly candidates: readonly { readonly predictedIou: number; readonly frame: RasterFrame }[];
  readonly cached?: boolean;
  readonly timings?: Record<string, number>;
}

export interface RemoteProviderOptions {
  /** POST endpoint; receives `{ target, prompt }`, returns candidates in the wire format. */
  readonly url: string;
  readonly capabilities: ProviderCapabilities;
  readonly fetch?: typeof fetch | undefined;
}

/**
 * All on the server, over this package's own wire format: every prompt is a
 * round trip and the server keeps whatever state it needs. The PoC's harness
 * server speaks it; an existing service (MONAI Label, nnInteractive) is
 * wrapped with {@link createServiceSegmentationProvider} instead, in its own
 * protocol. The result is the same {@link MaskCandidate} rasters, so the tool
 * and the mask/polygon conversion are unchanged.
 */
export function createRemoteSegmentationProvider(
  options: RemoteProviderOptions,
): SegmentationProvider {
  const doFetch = options.fetch ?? fetch;
  return {
    capabilities: options.capabilities,
    async segment(target, prompt, signal) {
      const t0 = performance.now();
      const body = JSON.stringify({
        target,
        prompt: { points: prompt.points, box: prompt.box },
      });
      const res = await doFetch(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal,
      });
      if (!res.ok) throw new Error(`remote segment failed: HTTP ${res.status} ${await res.text()}`);
      const buffer = await res.arrayBuffer();
      const t1 = performance.now();
      const { blobs, meta } = decodeWire<SegmentMeta>(buffer);
      const candidates: MaskCandidate[] = meta.candidates.map((c, i) => ({
        predictedIou: c.predictedIou,
        mask: { frame: c.frame, data: blobs[i]!.data },
      }));
      return {
        candidates,
        view: meta.view,
        cached: meta.cached,
        timings: { ...meta.timings, roundTrip: t1 - t0, wireBytes: buffer.byteLength },
      };
    },
  };
}
