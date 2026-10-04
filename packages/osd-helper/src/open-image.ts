import type OpenSeadragon from 'openseadragon';
import type { ImageSource } from '@osdlabel/viewer-api';

const SUPPORTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'];

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * A copy of a plain options object, deep enough that OpenSeadragon never
 * writes into the host's. `viewer.open()` adds `crossOriginPolicy` and
 * `ajaxWithCredentials` to a plain tile source it is given, which would make
 * the host's object differ from an equal one it re-creates later, so the cell
 * would reload the image every time (#83). It writes them at the top level of
 * a bare tile source, and into the nested `tileSource` of a TiledImage options
 * wrapper (`{ tileSource, opacity, … }`), so a wrapper's plain `tileSource` is
 * copied too. A spread keeps functions such as `getTileUrl`. Anything else,
 * such as a `TileSource` instance, is passed as is.
 */
function copyPlain(item: unknown): unknown {
  if (!isPlainObject(item)) return item;
  const nested = item['tileSource'];
  return isPlainObject(nested) ? { ...item, tileSource: { ...nested } } : { ...item };
}

function forOpenSeadragon(tileSource: object): object {
  if (Array.isArray(tileSource)) return tileSource.map(copyPlain);
  return copyPlain(tileSource) as object;
}

/**
 * Open an image source in an OpenSeadragon viewer.
 *
 * A tile-source object goes to `viewer.open()` as is, except that a plain
 * options object is copied first (see `forOpenSeadragon`). A URL is opened
 * with `{ type: 'image', url }` when its extension marks it as a simple image,
 * and passed directly otherwise (DZI or another tile source).
 */
export function openImage(viewer: OpenSeadragon.Viewer, source: ImageSource): void {
  const tileSource = source.tileSource;
  if (typeof tileSource !== 'string') {
    viewer.open(forOpenSeadragon(tileSource));
    return;
  }
  // Remove query string and hash, then check extension
  const path = (tileSource.split(/[?#]/)[0] ?? '').toLowerCase();
  const isSimpleImage = SUPPORTED_EXTENSIONS.some((ext) => path.endsWith(ext));

  if (isSimpleImage) {
    viewer.open({ type: 'image', url: tileSource });
  } else {
    viewer.open(tileSource);
  }
}
