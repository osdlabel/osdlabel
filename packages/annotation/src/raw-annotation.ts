/** A generic interface to hold raw annotation data from rendering libraries such as Fabric.js. */
export interface RawAnnotationData<
  TFormat extends string,
  TAnnotationData extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly format: TFormat;
  readonly data: TAnnotationData;
}
