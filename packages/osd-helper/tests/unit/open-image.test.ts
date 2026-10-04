import { describe, it, expect, vi, beforeEach } from 'vitest';
import type OpenSeadragon from 'openseadragon';
import { createImageId } from '@osdlabel/viewer-api';
import type { ImageSource, TileSourceSpec } from '@osdlabel/viewer-api';
import { openImage } from '../../src/open-image.js';

function createMockViewer(): OpenSeadragon.Viewer {
  return { open: vi.fn() } as unknown as OpenSeadragon.Viewer;
}

function createSource(tileSource: TileSourceSpec): ImageSource {
  return { id: createImageId('img'), tileSource };
}

describe('openImage', () => {
  let viewer: OpenSeadragon.Viewer;

  beforeEach(() => {
    viewer = createMockViewer();
  });

  describe('simple image extensions', () => {
    it.each(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])(
      'opens %s as a simple image',
      (ext) => {
        const url = `http://example.com/photo${ext}`;
        openImage(viewer, createSource(url));
        expect(viewer.open).toHaveBeenCalledWith({ type: 'image', url });
      },
    );
  });

  describe('case insensitivity', () => {
    it('handles uppercase extension', () => {
      const url = 'http://example.com/photo.JPG';
      openImage(viewer, createSource(url));
      expect(viewer.open).toHaveBeenCalledWith({ type: 'image', url });
    });

    it('handles mixed case extension', () => {
      const url = 'http://example.com/photo.Png';
      openImage(viewer, createSource(url));
      expect(viewer.open).toHaveBeenCalledWith({ type: 'image', url });
    });
  });

  describe('non-image tile sources', () => {
    it('passes DZI URL directly to viewer.open', () => {
      const url = 'http://example.com/slide.dzi';
      openImage(viewer, createSource(url));
      expect(viewer.open).toHaveBeenCalledWith(url);
    });

    it('passes URL without extension directly', () => {
      const url = 'http://tiles.example.com/api/v1/slide';
      openImage(viewer, createSource(url));
      expect(viewer.open).toHaveBeenCalledWith(url);
    });
  });

  describe('query strings and hashes', () => {
    it('strips query string before checking extension', () => {
      const url = 'http://example.com/photo.png?token=abc';
      openImage(viewer, createSource(url));
      expect(viewer.open).toHaveBeenCalledWith({ type: 'image', url });
    });

    it('strips hash before checking extension', () => {
      const url = 'http://example.com/photo.jpg#section';
      openImage(viewer, createSource(url));
      expect(viewer.open).toHaveBeenCalledWith({ type: 'image', url });
    });

    it('strips both query string and hash', () => {
      const url = 'http://example.com/photo.webp?v=1#x';
      openImage(viewer, createSource(url));
      expect(viewer.open).toHaveBeenCalledWith({ type: 'image', url });
    });

    it('does not match image extension in query string only', () => {
      const url = 'http://example.com/slide.dzi?fallback=img.png';
      openImage(viewer, createSource(url));
      expect(viewer.open).toHaveBeenCalledWith(url);
    });
  });

  describe('edge cases', () => {
    it('handles empty tileSource', () => {
      const url = '';
      openImage(viewer, createSource(url));
      expect(viewer.open).toHaveBeenCalledWith(url);
    });
  });

  describe('tile-source objects (#83)', () => {
    it('passes a copy of an options object, with the same fields', () => {
      const tileSource = {
        type: 'image',
        url: 'http://example.com/photo.png',
        buildPyramid: false,
      };
      openImage(viewer, createSource(tileSource));
      expect(viewer.open).toHaveBeenCalledWith(tileSource);
      expect(vi.mocked(viewer.open).mock.calls[0]![0]).not.toBe(tileSource);
    });

    it("never lets OpenSeadragon write into the host's object", () => {
      // OSD 5 adds these two keys to a plain object it is given. Written into
      // the host's object, they would make every equal object the host later
      // re-creates compare unequal, and the cell reload each time.
      vi.mocked(viewer.open).mockImplementation((ts) => {
        Object.assign(ts as object, { crossOriginPolicy: false, ajaxWithCredentials: false });
        return viewer;
      });
      const tileSource = { type: 'image', url: 'http://example.com/photo.png' };
      openImage(viewer, createSource(tileSource));
      expect(tileSource).toEqual({ type: 'image', url: 'http://example.com/photo.png' });
    });

    it("never lets OpenSeadragon write into a TiledImage wrapper's nested tile source", () => {
      // Given `{ tileSource, … }`, OSD 5 treats the outer object as TiledImage
      // options and writes the two keys into both it and its plain
      // `tileSource`, for each item of an array alike.
      const mutate = (item: unknown) => {
        const keys = { crossOriginPolicy: false, ajaxWithCredentials: false };
        const options = item as { tileSource?: unknown };
        Object.assign(options, keys);
        if (typeof options.tileSource === 'object' && options.tileSource !== null) {
          Object.assign(options.tileSource, keys);
        }
      };
      vi.mocked(viewer.open).mockImplementation((ts) => {
        if (Array.isArray(ts)) ts.forEach(mutate);
        else mutate(ts);
        return viewer;
      });
      const wrapper = () => ({ tileSource: { type: 'image', url: 'a.png' }, opacity: 0.8 });
      const single = wrapper();
      openImage(viewer, createSource(single));
      expect(single).toEqual(wrapper());
      const inArray = wrapper();
      openImage(viewer, createSource([inArray]));
      expect(inArray).toEqual(wrapper());
    });

    it("passes a wrapper's non-plain tile source as is", () => {
      class FakeTileSource {}
      const instance = new FakeTileSource();
      openImage(viewer, createSource({ tileSource: instance, opacity: 0.5 }));
      const passed = vi.mocked(viewer.open).mock.calls[0]![0] as { tileSource: unknown };
      expect(passed.tileSource).toBe(instance);
    });

    it('keeps functions such as getTileUrl in the copy', () => {
      const getTileUrl = (level: number) => `t/${level}`;
      openImage(viewer, createSource({ height: 10, width: 10, tileSize: 256, getTileUrl }));
      const passed = vi.mocked(viewer.open).mock.calls[0]![0] as { getTileUrl: unknown };
      expect(passed.getTileUrl).toBe(getTileUrl);
    });

    it('copies each plain object in an array, and passes instances as is', () => {
      class FakeTileSource {}
      const instance = new FakeTileSource();
      const first = { type: 'image', url: 'a.png' };
      openImage(viewer, createSource([first, instance]));
      const passed = vi.mocked(viewer.open).mock.calls[0]![0] as unknown[];
      expect(passed[0]).toEqual(first);
      expect(passed[0]).not.toBe(first);
      expect(passed[1]).toBe(instance);
    });

    it('passes a TileSource-like instance itself', () => {
      class FakeTileSource {}
      const instance = new FakeTileSource();
      openImage(viewer, createSource(instance));
      expect(vi.mocked(viewer.open).mock.calls[0]![0]).toBe(instance);
    });

    it('passes an inline DZI descriptor unchanged', () => {
      const tileSource = {
        Image: {
          xmlns: 'http://schemas.microsoft.com/deepzoom/2008',
          Url: 'http://example.com/slide_files/',
          Format: 'jpg',
          Overlap: '1',
          TileSize: '254',
          Size: { Width: '4000', Height: '3000' },
        },
      };
      openImage(viewer, createSource(tileSource));
      expect(viewer.open).toHaveBeenCalledWith(tileSource);
    });
  });
});
