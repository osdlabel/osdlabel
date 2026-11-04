import { createImageId, type ImageSource } from 'osdlabel';

/**
 * Opt-in filmstrip entries for testing by hand at whole-slide scale, which the
 * bundled images (2000 px at most) cannot reach. Shared by both dev apps, and
 * read from the page's query once, at module load. Neither parameter changes
 * anything when absent, and no spec but `large-image.spec.ts` passes them.
 *
 * - `?largeImage` adds "Large (synthetic)" (image id `large`) at the end of the
 *   filmstrip: a deep-zoom image of {@link DEFAULT_LARGE_IMAGE_SIZE} that is
 *   drawn tile by tile in the page, so it needs no file and makes no request.
 *   `?largeImage=WxH` sets its size, each side clamped to
 *   {@link MIN_LARGE_IMAGE_SIDE}..{@link MAX_LARGE_IMAGE_SIDE}. The label ends
 *   with the size it opens at, so a value that was clamped or not understood
 *   shows on the page (iOS has no console to warn in). Given more than once,
 *   the last value wins; `0`, `false`, `off` or `no` leaves the image out.
 * - `?image=<url>`, repeatable, adds one entry per URL (ids `url-1`, `url-2`,
 *   …, before the synthetic one; empty values are skipped and take no
 *   number), handed to the library as is: a DZI, an IIIF `info.json` or a
 *   plain image. A plain image is decoded and drawn whole into one canvas, so
 *   past 16,777,216 px (4,096²) it fails on iOS Safari: anything larger must
 *   be a DZI or IIIF. URL-encode a value holding `&`, `+` or `#`.
 *
 * The viewer's deepest zoom is absolute (`maxZoomLevel: 40` in
 * `DEFAULT_VIEWER_OPTIONS`): a cell then shows a fortieth of the image's width,
 * so one image pixel spans 40 × cell CSS width ÷ image width CSS pixels. At the
 * default 100,000 px that is 0.4 CSS px in a 1,000 px cell: too little to see
 * one image pixel, and OSD usually stops a level short of full resolution.
 * Checks at the scale of one image pixel need the image width at most about
 * 40 × cell CSS width × device pixel ratio (e.g. `?largeImage=32768x24576`, or
 * `16384x16384` on a phone). The same limit applies to a real slide opened
 * through `?image=`.
 */

export const DEFAULT_LARGE_IMAGE_SIZE = { width: 100_000, height: 80_000 } as const;
export const MIN_LARGE_IMAGE_SIDE = 1_024;
export const MAX_LARGE_IMAGE_SIDE = 1_048_576;

export function queryImages(search: string): ImageSource[] {
  const params = new URLSearchParams(search);
  const images: ImageSource[] = params
    .getAll('image')
    .map((url) => url.trim())
    .filter((url) => url.length > 0)
    .map((url, i) => ({
      id: createImageId(`url-${i + 1}`),
      tileSource: url,
      label: labelFromUrl(url),
    }));
  // The last value wins, so a value appended to a URL that has one already
  // takes effect.
  const large = params.getAll('largeImage').at(-1);
  if (large !== undefined && !LARGE_IMAGE_OFF.test(large.trim())) {
    const { width, height } = parseLargeImageSize(large);
    images.push({
      id: createImageId('large'),
      tileSource: createSyntheticTileSource(width, height),
      label: `Large (synthetic) ${formatNumber(width)} × ${formatNumber(height)}`,
    });
  }
  return images;
}

/** `?largeImage=` values that leave the synthetic image out. */
const LARGE_IMAGE_OFF = /^(0|false|off|no)$/i;

/** `WxH` (`x`, `X`, `×` or `*`), each side clamped; anything else is the default. */
export function parseLargeImageSize(value: string): { width: number; height: number } {
  const match = /^\s*(\d+)\s*[xX×*]\s*(\d+)\s*$/.exec(value);
  if (!match) {
    if (value.trim() !== '' && !/^(1|true|on|yes)$/i.test(value.trim())) {
      console.warn(`?largeImage=${value} is not WxH; using the default size.`);
    }
    return { ...DEFAULT_LARGE_IMAGE_SIZE };
  }
  const side = (digits: string): number =>
    Math.min(MAX_LARGE_IMAGE_SIDE, Math.max(MIN_LARGE_IMAGE_SIDE, Number(digits)));
  return { width: side(match[1]!), height: side(match[2]!) };
}

const MAX_LABEL_LENGTH = 24;

/**
 * The URL's file name, or for an IIIF `info.json` the identifier before it,
 * shortened in the middle to {@link MAX_LABEL_LENGTH} characters.
 */
export function labelFromUrl(url: string): string {
  const path = url.split(/[?#]/)[0] ?? url;
  const segments = path.split('/').filter((s) => s !== '' && s !== '.');
  const last = segments.at(-1) ?? url;
  const previous = segments.at(-2);
  let name = last.toLowerCase() === 'info.json' && previous ? `${previous}/${last}` : last;
  try {
    name = decodeURIComponent(name);
  } catch {
    // Not percent-encoded after all; show it as written.
  }
  if (name.length <= MAX_LABEL_LENGTH) return name;
  const head = Math.ceil((MAX_LABEL_LENGTH - 1) / 2);
  const tail = MAX_LABEL_LENGTH - 1 - head;
  return `${name.slice(0, head)}…${name.slice(-tail)}`;
}

// ── The synthetic tile source ───────────────────────────────────────────────

const TILE_SIZE = 256;
const TILE_OVERLAP = 1;
/** Prefix of the key each tile is cached under. Never fetched: see `downloadTileStart`. */
const KEY_PREFIX = 'osdlabel-synthetic:';
/** Grid tiers closer than this, in pixels of the level drawn, are left out. */
const MIN_LINE_SPACING = 8;
/**
 * A label's font size in level pixels on a screen of one device pixel per CSS
 * pixel. OSD shows a level at between half and one device pixel per level
 * pixel once its tiles are in, so this is 8 to 15 px on screen there.
 */
const LABEL_FONT_SIZE = 15;

/**
 * The part of OpenSeadragon 5's `ImageJob` that a tile source's
 * `downloadTileStart` / `downloadTileAbort` use.
 */
interface TileJob {
  readonly src: string;
  readonly userData: { timer?: number };
  finish(data: HTMLCanvasElement | null, request: null, errorMessage?: string): void;
}

/** What OpenSeadragon 5 keeps per cached tile; the `*TileCache` hooks own `_data`. */
interface TileCacheRecord {
  _data?: HTMLCanvasElement | null;
}

/**
 * An OpenSeadragon 5 custom tile source (a plain object with `getTileUrl`)
 * whose tiles are drawn on canvases rather than downloaded.
 *
 * Each tile's URL is only a cache key. `downloadTileStart`, which OSD calls
 * only for a tile it is about to show, draws the tile a task later (not inside
 * OSD's update loop) and hands OSD the canvas itself, so nothing is encoded,
 * decoded or requested. The `*TileCache` hooks keep that canvas as the tile's
 * 2D context instead of copying it into another, so a cached tile costs one
 * canvas, as a downloaded one does; OSD's own cache bounds how many are kept
 * (`maxImageCacheCount`) and zeroes each canvas it evicts, which is what frees
 * canvas memory on iOS. A tile scrolled back into view is drawn again, in a
 * millisecond or two. `maxTilesPerFrame` (1) caps that at one tile a frame.
 *
 * Coupled to OSD 5's tile-source hooks; OSD 6 replaced the cache hooks, so an
 * upgrade must revisit this (`large-image.spec.ts` would fail: it checks tiles
 * are drawn).
 */
export function createSyntheticTileSource(width: number, height: number): object {
  const maxLevel = Math.ceil(Math.log2(Math.max(width, height)));
  // Read once, so every tile of this source draws its labels at one size.
  const pixelRatio = Math.min(3, Math.max(1, Math.round(window.devicePixelRatio || 1)));
  const spec: SyntheticImage = { width, height, maxLevel, pixelRatio };
  return {
    width,
    height,
    tileSize: TILE_SIZE,
    tileOverlap: TILE_OVERLAP,
    minLevel: 0,
    maxLevel,
    getTileUrl: (level: number, x: number, y: number): string =>
      `${KEY_PREFIX}${width}x${height}/${level}/${x}_${y}`,
    downloadTileStart: (job: TileJob): void => {
      job.userData.timer = window.setTimeout(() => {
        const match = /\/(\d+)\/(\d+)_(\d+)$/.exec(job.src);
        const canvas = match
          ? drawTile(spec, Number(match[1]), Number(match[2]), Number(match[3]))
          : null;
        if (canvas) job.finish(canvas, null);
        else job.finish(null, null, `could not draw synthetic tile ${job.src}`);
      }, 0);
    },
    downloadTileAbort: (job: TileJob): void => {
      window.clearTimeout(job.userData.timer);
    },
    createTileCache: (record: TileCacheRecord, data: HTMLCanvasElement): void => {
      record._data = data;
    },
    destroyTileCache: (record: TileCacheRecord): void => {
      record._data = null;
    },
    getTileCacheData: (record: TileCacheRecord) => record._data ?? null,
    getTileCacheDataAsImage: (record: TileCacheRecord) => record._data ?? null,
    getTileCacheDataAsContext2D: (record: TileCacheRecord) =>
      record._data?.getContext('2d') ?? null,
  };
}

interface SyntheticImage {
  readonly width: number;
  readonly height: number;
  readonly maxLevel: number;
  /** The screen's device pixels per CSS pixel when the source was made, 1 to 3. */
  readonly pixelRatio: number;
}

/**
 * Draws tile (`x`, `y`) of pyramid level `level` with OSD's tile geometry:
 * level `maxLevel` is full resolution, each level below it half the one above,
 * tiles `TILE_SIZE` square plus `TILE_OVERLAP` on each inner side, and edge
 * tiles cut to the image. Everything is a function of the level's own pixel
 * coordinates, so neighbouring tiles meet without a seam.
 */
function drawTile(
  image: SyntheticImage,
  level: number,
  x: number,
  y: number,
): HTMLCanvasElement | null {
  const scale = 2 ** (level - image.maxLevel);
  const left = x === 0 ? 0 : x * TILE_SIZE - TILE_OVERLAP;
  const top = y === 0 ? 0 : y * TILE_SIZE - TILE_OVERLAP;
  const width = Math.min(TILE_SIZE + (x === 0 ? 1 : 2) * TILE_OVERLAP, image.width * scale - left);
  const height = Math.min(TILE_SIZE + (y === 0 ? 1 : 2) * TILE_OVERLAP, image.height * scale - top);
  if (!(width > 0 && height > 0)) return null;

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width);
  canvas.height = Math.ceil(height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // From here on, coordinates are the level's pixels: image pixel X is level
  // pixel X * scale.
  ctx.translate(-left, -top);
  const area: Area = { left, top, width: canvas.width, height: canvas.height };
  paintBackground(ctx, image, scale, area);
  paintGrid(ctx, image, scale, area);
  paintLabels(ctx, image, scale, area);
  return canvas;
}

interface Area {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const BACKGROUND_STOPS = 6;

/**
 * A colour field that says where you are when zoomed out: hue follows image x
 * (red at the left edge through green and blue to magenta at the right), and
 * lightness follows image y (pale at the top, darker at the bottom). Sampled at
 * a few stops per tile, so it is smooth across tiles at every level.
 */
function paintBackground(
  ctx: CanvasRenderingContext2D,
  image: SyntheticImage,
  scale: number,
  area: Area,
): void {
  const across = ctx.createLinearGradient(area.left, 0, area.left + area.width, 0);
  const down = ctx.createLinearGradient(0, area.top, 0, area.top + area.height);
  for (let i = 0; i <= BACKGROUND_STOPS; i++) {
    const t = i / BACKGROUND_STOPS;
    const fx = clamp01((area.left + t * area.width) / scale / image.width);
    across.addColorStop(t, `hsl(${(300 * fx).toFixed(2)}, 70%, 62%)`);
    const fy = clamp01((area.top + t * area.height) / scale / image.height);
    down.addColorStop(
      t,
      fy < 0.5
        ? `rgba(255, 255, 255, ${(0.6 * (1 - 2 * fy)).toFixed(4)})`
        : `rgba(0, 0, 0, ${(0.3 * (2 * fy - 1)).toFixed(4)})`,
    );
  }
  ctx.fillStyle = across;
  ctx.fillRect(area.left, area.top, area.width, area.height);
  ctx.fillStyle = down;
  ctx.fillRect(area.left, area.top, area.width, area.height);
}

/** Grid spacings in image pixels: 10, 100, 1,000, … up to the image's longer side. */
function gridTiers(image: SyntheticImage): number[] {
  const tiers: number[] = [];
  for (let g = 10; g <= Math.max(image.width, image.height); g *= 10) tiers.push(g);
  return tiers;
}

/**
 * Lines every 10, 100, 1,000, 10,000 … image pixels, each tier appearing once
 * zooming in spreads it {@link MIN_LINE_SPACING} level pixels apart and
 * darkening as it spreads further. The line for image x = X covers pixel
 * column X, [X, X + 1): at full resolution every line is exactly one image
 * pixel wide, so a brush cell can be checked against it, on an image narrow
 * enough for the viewer to reach full resolution (see the module comment: at
 * the default 100,000 px it does not, and the 10 px tier never shows). Coarser
 * levels draw the wider tiers thicker.
 */
function paintGrid(
  ctx: CanvasRenderingContext2D,
  image: SyntheticImage,
  scale: number,
  area: Area,
): void {
  for (const tier of gridTiers(image)) {
    const spacing = tier * scale;
    if (spacing < MIN_LINE_SPACING) continue;
    const alpha = spacing >= 1000 ? 0.85 : 0.25 + 0.35 * clamp01((spacing - MIN_LINE_SPACING) / 92);
    const weight = scale >= 1 ? 1 : spacing >= 1000 ? 3 : spacing >= 200 ? 2 : 1;
    const offset = Math.floor((weight - 1) / 2);
    ctx.fillStyle = `rgba(0, 0, 0, ${alpha.toFixed(3)})`;
    const first = (edge: number): number => Math.max(0, Math.ceil((edge - weight) / spacing));
    for (let k = first(area.left); k * spacing < area.left + area.width; k++) {
      if (k * tier >= image.width) break;
      ctx.fillRect(Math.floor(k * tier * scale) - offset, area.top, weight, area.height);
    }
    for (let k = first(area.top); k * spacing < area.top + area.height; k++) {
      if (k * tier >= image.height) break;
      ctx.fillRect(area.left, Math.floor(k * tier * scale) - offset, area.width, weight);
    }
  }
}

/**
 * The image coordinates of the grid's intersections, `x` over `y`, at the
 * bottom right of each: on the finest tier whose labels fit apart at this
 * level, so every intersection of that tier carries one.
 *
 * OSD picks a level by device pixels, so on a screen of two device pixels a
 * CSS pixel it shows levels twice as fine and a label drawn at a fixed size
 * reads half as large. Labels are drawn `pixelRatio` times larger to make up
 * for it, as far as the tier's spacing leaves room: at full resolution that
 * room is the 100 px tier, which a magnified view enlarges anyway.
 */
function paintLabels(
  ctx: CanvasRenderingContext2D,
  image: SyntheticImage,
  scale: number,
  area: Area,
): void {
  ctx.font = labelFont(LABEL_FONT_SIZE);
  ctx.textBaseline = 'top';
  // The widest label any intersection can carry: the last pixel's coordinate.
  const widest = ctx.measureText(
    `x ${formatNumber(Math.max(image.width, image.height) - 1)}`,
  ).width;
  const boxAt = (size: number) => ({
    width: Math.ceil((widest * size) / LABEL_FONT_SIZE) + 6,
    lineHeight: Math.ceil((size * 17) / 15),
    height: 2 * Math.ceil((size * 17) / 15) + 4,
  });
  const fits = (size: number, spacing: number): boolean => {
    const box = boxAt(size);
    return Math.max(box.width, box.height) + 8 <= spacing;
  };
  const tier = gridTiers(image).find((g) => fits(LABEL_FONT_SIZE, g * scale));
  if (tier === undefined) return;
  const spacing = tier * scale;
  let size = LABEL_FONT_SIZE * image.pixelRatio;
  while (size > LABEL_FONT_SIZE && !fits(size, spacing)) size--;
  const box = boxAt(size);
  ctx.font = labelFont(size);

  const firstI = Math.max(0, Math.floor((area.left - box.width - 4) / spacing));
  const firstJ = Math.max(0, Math.floor((area.top - box.height - 4) / spacing));
  for (let i = firstI; i * spacing < area.left + area.width && i * tier < image.width; i++) {
    for (let j = firstJ; j * spacing < area.top + area.height && j * tier < image.height; j++) {
      const bx = Math.floor(i * tier * scale) + 3;
      const by = Math.floor(j * tier * scale) + 3;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
      ctx.fillRect(bx, by, box.width, box.height);
      ctx.fillStyle = '#111';
      ctx.fillText(`x ${formatNumber(i * tier)}`, bx + 3, by + 2);
      ctx.fillText(`y ${formatNumber(j * tier)}`, bx + 3, by + 2 + box.lineHeight);
    }
  }
}

function labelFont(size: number): string {
  return `bold ${size}px monospace`;
}

function formatNumber(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Every opt-in entry the page's query asks for, in filmstrip order. Last in the
 * module: it runs `queryImages` at load, which reads the constants above.
 */
export const QUERY_IMAGES: readonly ImageSource[] = queryImages(window.location.search);
