/**
 * DRAFT (research, not wired into any tool): what the contract needs beyond
 * {@link SegmentationProvider} for stacks, volumes and video.
 *
 * Derived from the APIs of the backends osdlabel would talk to:
 *
 * - SAM 2 video predictor (`sam2/sam2_video_predictor.py`):
 *   `init_state(video)`, `add_new_points_or_box(state, frame_idx, obj_id,
 *   points, labels, box)`, `add_new_mask(...)`, and `propagate_in_video(state,
 *   start_frame_idx, max_frame_num_to_track, reverse)`, a generator of
 *   `(frame_idx, obj_ids, masks)`. State (the memory bank) lives in the
 *   session; prompts carry a frame index and an object id.
 * - MedSAM2 (SAM 2.1 fine-tuned on 3D CT/MR and ultrasound video): the same
 *   API, used as "box on the middle slice, propagate both ways".
 * - nnInteractive (`nnInteractiveInferenceSession` / the HTTP
 *   `nnInteractiveRemoteInferenceSession`): `set_image(volume)`,
 *   `set_target_buffer`, `add_point|bbox|scribble|lasso_interaction(...,
 *   include_interaction)`; each call updates a 3D mask in place and returns
 *   the bounding box of the changed sub-volume. Natively 3D: one prompt on one
 *   slice segments the whole structure, no propagation step.
 * - MONAI Label: `POST /infer/{model}?image=<id>` with `params` JSON
 *   (foreground / background points, …); the server owns the image (datastore
 *   id or uploaded session) and returns a label volume.
 *
 * What changes relative to the 2D contract:
 *
 * 1. State. Every 3D/video backend is a stateful session (memory bank,
 *    accumulated interactions, target buffer). The 2D provider is stateless
 *    per call apart from its cache.
 * 2. A third axis on prompts and results: `frame` (time) or `slice` (z),
 *    plus an `objectId`, since propagation tracks several objects at once.
 * 3. Results stream. Propagation yields one frame at a time over seconds;
 *    the UI paints as they arrive and the user can stop it.
 * 4. Results can be partial updates (nnInteractive's changed bounding box)
 *    rather than a whole new mask per call.
 * 5. Prompt kinds beyond points and boxes: scribbles and lassos (nnInteractive).
 * 6. The server owns the pixels (a DICOM series, a video file); the browser
 *    references them by key, as the 2D remote topology already does.
 */
import type { PromptBox, PromptPoint, RasterMask, SegmentationImageKey } from './types.js';
import type { ProviderCapabilities } from './provider.js';

/** Index along the third axis: a slice of a stack/volume or a frame of a cine/video. */
export type FrameIndex = number;

/** Tracks one structure across frames (SAM 2 `obj_id`). */
export type SegmentationObjectId = number;

export interface SessionCapabilities extends ProviderCapabilities {
  /** Which third axis the backend propagates along, if any. */
  readonly axis: 'none' | 'slice' | 'time';
  /** Propagates prompts from one frame to others (SAM 2, MedSAM2). */
  readonly propagate: boolean;
  /** One prompt yields a 3D result directly (nnInteractive). */
  readonly volumetric: boolean;
  readonly scribble: boolean;
  readonly lasso: boolean;
  /** Tracks several objects in one session. */
  readonly multiObject: boolean;
}

/** A prompt on one frame for one object. `include: false` = negative scribble / lasso. */
export type FramePrompt =
  | {
      readonly kind: 'points-box';
      readonly points?: readonly PromptPoint[] | undefined;
      readonly box?: PromptBox | undefined;
    }
  | { readonly kind: 'scribble'; readonly mask: RasterMask; readonly include: boolean }
  | { readonly kind: 'lasso'; readonly ring: readonly PromptPoint[]; readonly include: boolean }
  | { readonly kind: 'mask'; readonly mask: RasterMask };

export interface FrameResult {
  readonly frame: FrameIndex;
  readonly objectId: SegmentationObjectId;
  /** The object's mask on this frame (full, or the changed window when `partial`). */
  readonly mask: RasterMask;
  /** True when `mask` only covers the region that changed (nnInteractive). */
  readonly partial: boolean;
  readonly predictedIou?: number | undefined;
}

export interface PropagateRequest {
  readonly objectIds?: readonly SegmentationObjectId[] | undefined;
  readonly from: FrameIndex;
  /** Inclusive; omitted = to the end (or start, backwards) of the series. */
  readonly to?: FrameIndex | undefined;
  readonly direction: 'forward' | 'backward' | 'both';
}

export interface SegmentationSession {
  readonly capabilities: SessionCapabilities;
  /** Adds a prompt; resolves with the prompted frame's result (and, for volumetric backends, others). */
  addPrompt(
    frame: FrameIndex,
    objectId: SegmentationObjectId,
    prompt: FramePrompt,
    signal: AbortSignal,
  ): Promise<readonly FrameResult[]>;
  /** Streams per-frame results; breaking out of the loop or aborting stops the backend. */
  propagate(request: PropagateRequest, signal: AbortSignal): AsyncIterable<FrameResult>;
  /** Drops one object's prompts and memory, or everything. */
  reset(objectId?: SegmentationObjectId): Promise<void>;
  close(): Promise<void>;
}

export interface SeriesTarget {
  readonly imageKey: SegmentationImageKey;
  /** See `EncodeView.variant`: window/level etc. */
  readonly variant?: string | undefined;
  readonly frameCount: number;
  readonly frameSize: { readonly width: number; readonly height: number };
}

/** Opens sessions on a series; a 2D-only backend does not implement this. */
export interface SegmentationSessionBackend {
  readonly capabilities: SessionCapabilities;
  openSession(target: SeriesTarget, signal: AbortSignal): Promise<SegmentationSession>;
}
