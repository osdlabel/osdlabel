import {
  throwIfAborted,
  type ImageRegion,
  type MaskCandidate,
  type ProviderCapabilities,
  type SegmentationImageKey,
  type SegmentationPrompt,
  type SegmentationProvider,
  type SegmentationResult,
  type SegmentationTarget,
} from '@osdlabel/segmentation';

/**
 * What a service answers to one interaction, already mapped back to image
 * space by the adapter. A service that returns a label image (MONAI Label
 * `output=image`, nnInteractive's changed sub-volume) places it with a
 * `RasterFrame`; one that returns contours (MONAI Label's pathology apps,
 * `output=json`) rasterises them with `@osdlabel/mask-contour`'s `fillRings`
 * into a `Uint8Array` raster, or the app commits its polygons directly.
 */
export interface ServiceAnswer {
  /** Best first; a service with a single answer returns one candidate. */
  readonly candidates: readonly MaskCandidate[];
  /** The image region the service looked at (default: the viewport). */
  readonly region?: ImageRegion | undefined;
  readonly timings?: Readonly<Record<string, number>> | undefined;
}

/**
 * The contract an existing interactive-segmentation service is wrapped by.
 * osdlabel ships no server: a deployment runs MONAI Label, nnInteractive's
 * server, or its own SAM service, and an adapter of a few dozen lines maps
 * this contract onto that service's own protocol. Nothing here prescribes a
 * wire format; this package's float16 format is one option for servers the
 * app writes itself.
 *
 * Sketch of two mappings (unverified against live servers):
 *
 * - MONAI Label: `open` resolves the image id in its datastore (or uploads
 *   the region as `file`); `infer` is `POST /infer/{model}?image={id}&output=image|json`
 *   with the clicks in the `params` form field (model-specific keys, e.g. a
 *   pathology NuClick model's foreground clicks); the answer is a label image
 *   or contours.
 * - nnInteractive (`nninteractive-server`): `open` claims a session
 *   (`POST /claim`, lease token) and uploads the image and an empty target
 *   buffer; `infer` sends the newest point / box / scribble / lasso
 *   interaction (the session accumulates them server-side, so only the delta
 *   travels); the answer is the blosc2-compressed bounding box of what
 *   changed, which the adapter writes into its own buffer and returns as one
 *   candidate. `close` is `POST /release`. Its 3D use goes through
 *   `@osdlabel/segmentation`'s `SegmentationSessionBackend` instead.
 */
export interface SegmentationServiceAdapter<TSession> {
  readonly capabilities: ProviderCapabilities;
  /** Server-side state for one image; opened once per image key and reused. */
  open(target: SegmentationTarget, signal: AbortSignal): Promise<TSession>;
  /** One interaction, with the whole prompt so far (the adapter may send only the delta). */
  infer(
    session: TSession,
    target: SegmentationTarget,
    prompt: SegmentationPrompt,
    signal: AbortSignal,
  ): Promise<ServiceAnswer>;
  close?(session: TSession): Promise<void>;
}

/**
 * A {@link SegmentationProvider} over a service adapter: opens one session
 * per image key on first use (concurrent first prompts share it), forwards
 * every prompt, and closes sessions on `dispose`. The tool, the mask
 * conversion and the bindings cannot tell it from an in-browser model.
 */
export function createServiceSegmentationProvider<TSession>(
  adapter: SegmentationServiceAdapter<TSession>,
): SegmentationProvider {
  const sessions = new Map<SegmentationImageKey, Promise<TSession>>();
  const sessionFor = (
    target: SegmentationTarget,
    signal: AbortSignal,
  ): { session: Promise<TSession>; reused: boolean } => {
    const existing = sessions.get(target.imageKey);
    if (existing) return { session: existing, reused: true };
    const opened = adapter.open(target, signal);
    sessions.set(target.imageKey, opened);
    // A failed open must not poison later prompts for this image.
    opened.catch(() => {
      if (sessions.get(target.imageKey) === opened) sessions.delete(target.imageKey);
    });
    return { session: opened, reused: false };
  };
  return {
    capabilities: adapter.capabilities,
    async prepare(target, signal) {
      await sessionFor(target, signal).session;
    },
    async segment(target, prompt, signal): Promise<SegmentationResult> {
      const t0 = performance.now();
      const { session, reused } = sessionFor(target, signal);
      const s = await session;
      const t1 = performance.now();
      throwIfAborted(signal);
      const answer = await adapter.infer(s, target, prompt, signal);
      const t2 = performance.now();
      const first = answer.candidates[0]?.mask.frame;
      return {
        candidates: answer.candidates,
        view: {
          imageKey: target.imageKey,
          variant: target.variant,
          imageSize: target.imageSize,
          region: answer.region ?? target.viewport,
          // Raster px per image px of the answer (what an encode's scale means).
          scale: first ? 1 / first.pixelWidth : target.viewportScale,
        },
        cached: reused,
        timings: { ...answer.timings, open: t1 - t0, infer: t2 - t1 },
      };
    },
    dispose(imageKey) {
      for (const [key, session] of [...sessions]) {
        if (imageKey !== undefined && key !== imageKey) continue;
        sessions.delete(key);
        void session.then((s) => adapter.close?.(s)).catch(() => {});
      }
    },
  };
}
