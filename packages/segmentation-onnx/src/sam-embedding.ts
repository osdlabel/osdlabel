import type { SamTensor } from './sam-tensor.js';

/**
 * The `TEmbedding` for the SAM server-encode → client-decode topology. The
 * server runs the heavy image encoder and returns the embedding tensor
 * (`[1, 256, 64, 64]`) plus the metadata the client decoder needs to map prompt
 * coordinates into model space and to set `orig_im_size`.
 */
export interface SamEmbedding {
  /** Image encoder output, shape `[1, 256, 64, 64]`. */
  readonly embedding: SamTensor;
  /** Original image width in pixels (pre-resize). */
  readonly origWidth: number;
  /** Original image height in pixels (pre-resize). */
  readonly origHeight: number;
  /** Encoder input side length (SAM uses 1024). */
  readonly inputSize: number;
}
