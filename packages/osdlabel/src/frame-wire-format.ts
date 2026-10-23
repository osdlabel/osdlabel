import type { FrameRef } from '@osdlabel/frame';
import type { FrameRefSchema } from '@osdlabel/validation';
import type * as v from 'valibot';

/**
 * Compile-time proof that the frame wire format is declared consistently:
 * `FrameRef` lives in `@osdlabel/frame` and its schema in
 * `@osdlabel/validation`, which may not import each other. Same pattern as
 * `mask-wire-format.ts`. Nothing here runs.
 */
type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

export type FrameRefSchemaAgrees = Assert<
  Equal<v.InferOutput<typeof FrameRefSchema>, { index: number; key?: string; time?: number }>
>;
export type FrameRefTypeAgrees = Assert<
  Equal<
    Required<FrameRef>,
    { readonly index: number; readonly key: string | undefined; readonly time: number | undefined }
  >
>;
