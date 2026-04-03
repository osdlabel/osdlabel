declare const imageIdBrand: unique symbol;
/** Unique image identifier */
export type ImageId = string & { readonly __brand: typeof imageIdBrand };
