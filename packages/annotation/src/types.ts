declare const imageIdBrand: unique symbol;
/** Unique image identifier */
export type ImageId = string & { readonly __brand: typeof imageIdBrand };

// ── Raw Annotation Data ──────────────────────────────────────────────────

/** Discriminated union for raw annotation data from rendering libraries */
export type RawAnnotationData = {
  readonly format: 'fabric';
  readonly fabricVersion: string;
  readonly data: Record<string, unknown>;
};

// ── Image Source ──────────────────────────────────────────────────────────

/** Image source descriptor */
export interface ImageSource {
  readonly id: ImageId;
  readonly tileSource: string;
  readonly thumbnailUrl?: string | undefined;
  readonly label?: string | undefined;
}
