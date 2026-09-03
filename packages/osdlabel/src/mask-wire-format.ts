import { MASK_RAW_FORMAT, type MaskRawData } from '@osdlabel/annotation';
import { CANONICAL_MASK_FORMAT, type CanonicalMaskData } from '@osdlabel/mask';

/**
 * Compile-time proof that the mask wire format is declared consistently.
 *
 * The format lives in two dependency-free packages that cannot import each
 * other: `@osdlabel/annotation` owns the annotation-facing side
 * (`MASK_RAW_FORMAT` / `MaskRawData`) and `@osdlabel/mask` owns the codec-facing
 * side (`CANONICAL_MASK_FORMAT` / `CanonicalMaskData`). `osdlabel` is the first
 * package to depend on both, so it is where the two can be checked against each
 * other.
 *
 * Nothing here runs. If either declaration drifts — a renamed field, a widened
 * type, a changed literal, a field added on one side only — `pnpm typecheck`
 * fails in this file and names the mismatch, instead of the divergence
 * surfacing as a payload one half of the codebase silently refuses to read.
 */

type Assert<T extends true> = T;
type Extends<A, B> = A extends B ? true : false;
/** Invariant-position comparison, so `unknown` and `any` do not slip through. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** The fields both declarations must describe identically. */
type WireField = 'x' | 'y' | 'width' | 'height' | 'imageWidth' | 'imageHeight' | 'counts';

// The format strings are the same literal, checked both ways.
export type MaskFormatLiteralsAgree = Assert<
  Equal<typeof MASK_RAW_FORMAT, typeof CANONICAL_MASK_FORMAT>
>;

// Every shared field has exactly the same type on both sides.
//
// Whole-shape assignability is not usable here: `MaskRawData` extends
// `Record<string, unknown>` so that it fits the generic raw-data envelope,
// while `CanonicalMaskData` is a plain interface with no index signature.
// Comparing the named fields is the actual invariant either way.
export type WireFieldsAgree = Assert<
  Equal<Pick<CanonicalMaskData, WireField>, Pick<MaskRawData, WireField>>
>;

// A codec-side field the annotation side does not know about would be dropped
// on the way into state, so require the codec payload to stay within the shared
// set.
//
// The reverse cannot be checked: `MaskRawData`'s index signature makes its
// `keyof` plain `string`, so a field added only there is invisible to the type
// system. `fill` is one such annotation-only field on purpose — a rendering
// hint the codecs have no use for — and any future one needs a decision about
// whether the codecs should carry it too.
export type CanonicalHasNoExtraFields = Assert<Extends<keyof CanonicalMaskData, WireField>>;
