declare const imageIdBrand: unique symbol;
/** Unique image identifier */
export type ImageId = string & { readonly __brand: typeof imageIdBrand };

// ── Raw Annotation Data ──────────────────────────────────────────────────

/** A generic interface to hold raw annotation data from rendering libraries such as Fabric.js. */
export interface RawAnnotationData<
  TFormat extends string,
  TAnnotationData extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly format: TFormat;
  readonly data: TAnnotationData;
}

// ── Image Source ──────────────────────────────────────────────────────────

/** Image source descriptor */
export interface ImageSource {
  readonly id: ImageId;
  readonly tileSource: string;
  readonly thumbnailUrl?: string | undefined;
  readonly label?: string | undefined;
}
