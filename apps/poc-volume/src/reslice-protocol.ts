import type { PlaneIndexMapping, VolumeGrid } from '@osdlabel/spatial';
import type { Interpolation, ReslicePath } from '@osdlabel/volume';

export interface InitMessage {
  readonly type: 'init';
  readonly grid: VolumeGrid;
  /** The whole volume, contiguous, shared with the main thread (zero copy). */
  readonly voxels: SharedArrayBuffer;
}

export interface JobMessage {
  readonly type: 'job';
  readonly id: number;
  readonly mapping: PlaneIndexMapping;
  readonly width: number;
  readonly height: number;
  readonly out: SharedArrayBuffer;
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly interpolation: Interpolation;
}

export type WorkerRequest = InitMessage | JobMessage;

export type WorkerReply =
  | { readonly type: 'ready' }
  | { readonly type: 'done'; readonly id: number; readonly ms: number; readonly path: ReslicePath };
