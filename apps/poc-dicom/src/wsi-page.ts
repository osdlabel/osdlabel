/**
 * H2 benchmark page: a DICOM WSI series in a plain OpenSeadragon viewer
 * through @osdlabel/dicom-wsi. `?role=sm-jpeg|sm-j2k&mode=part10|range|dicomweb`.
 *
 * Exposes `window.__wsi` for scripts/bench.mjs: `ready` resolves when the
 * home view is fully loaded; `zoomToBase(x, y)` zooms to 1:1 on the base level
 * at an image point and resolves when that view is fully loaded.
 */
import OpenSeadragon from 'openseadragon';
import { loadWsi, type WsiMode } from './wsi-source.js';

interface PhaseResult {
  readonly phase: string;
  readonly ms: number;
  readonly tiles: number;
  readonly tileFetchMs: readonly number[];
  readonly tileDecodeMs: readonly number[];
  readonly bytes: number;
  readonly failed: number;
}

const params = new URLSearchParams(location.search);
const role = params.get('role') ?? 'sm-jpeg';
const mode = (params.get('mode') ?? 'dicomweb') as WsiMode;
const drawerParam = params.get('drawer') ?? 'webgl';

const tStart = performance.now();
const wsi = await loadWsi(role, mode);
const tMeta = performance.now();

const viewer = OpenSeadragon({
  element: document.getElementById('viewer')!,
  prefixUrl: '',
  showNavigationControl: false,
  animationTime: 0,
  springStiffness: 100,
  crossOriginPolicy: false,
  drawer: drawerParam === 'canvas' ? 'canvas' : 'webgl',
});

let firstTileAt: number | undefined;
viewer.addHandler('tile-loaded', () => {
  if (firstTileAt === undefined) firstTileAt = performance.now();
});

function waitFullyLoaded(): Promise<void> {
  return new Promise((resolve) => {
    const item = viewer.world.getItemAt(0);
    const check = (): boolean => {
      if (item.getFullyLoaded()) {
        resolve();
        return true;
      }
      return false;
    };
    // Give OSD a frame to schedule tiles for the new view first.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (check()) return;
        const h = (): void => {
          if (check()) item.removeHandler('fully-loaded-change', h);
        };
        item.addHandler('fully-loaded-change', h);
      }),
    );
  });
}

function phase(name: string, since: number, fromTile: number): PhaseResult {
  const ts = wsi.tiles.slice(fromTile);
  return {
    phase: name,
    ms: performance.now() - since,
    tiles: ts.length,
    tileFetchMs: ts.map((t) => t.fetchMs),
    tileDecodeMs: ts.map((t) => t.decodeMs),
    bytes: ts.reduce((n, t) => n + t.bytes, 0),
    failed: ts.filter((t) => !t.ok).length,
  };
}

const tOpen0 = performance.now();
const opened = new Promise<void>((r) => viewer.addOnceHandler('open', () => r()));
viewer.open(wsi.tileSource as unknown as OpenSeadragon.TileSourceOptions);
await opened;
await waitFullyLoaded();
const home = phase('home', tOpen0, 0);

const api = {
  role,
  mode,
  drawer: (viewer.drawer as unknown as { getType(): string }).getType(),
  pyramid: {
    levels: wsi.pyramid.levels.map((l) => ({
      width: l.width,
      height: l.height,
      tile: l.tileWidth,
      frames: l.frameCount,
      downsample: +l.downsample.toFixed(3),
      ts: l.transferSyntaxUid,
    })),
    pixelSpacing: wsi.pyramid.pixelSpacing,
    notes: wsi.pyramid.notes,
  },
  metadataMs: tMeta - tStart,
  firstTileMs: (firstTileAt ?? NaN) - tOpen0,
  home,
  /** Zoom to 1 image pixel per screen pixel at image point (x, y) of the base level. */
  async zoomToBase(x: number, y: number): Promise<PhaseResult> {
    const from = wsi.tiles.length;
    const t0 = performance.now();
    const vp = viewer.viewport;
    const zoom = vp.imageToViewportZoom(1);
    vp.zoomTo(zoom, undefined, true);
    vp.panTo(vp.imageToViewportCoordinates(x, y), true);
    await waitFullyLoaded();
    return phase(`zoom(${Math.round(x)},${Math.round(y)})`, t0, from);
  },
  j2kWorkerMs: () => [...wsi.j2kWorkerMs],
};
(window as unknown as { __wsi: typeof api }).__wsi = api;
document.body.dataset['ready'] = '1';
