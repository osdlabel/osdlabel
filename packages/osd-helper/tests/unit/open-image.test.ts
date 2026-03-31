import { describe, it, expect, vi, beforeEach } from 'vitest';
import type OpenSeadragon from 'openseadragon';
import { createImageId } from '@osdlabel/annotation';
import type { ImageSource } from '@osdlabel/annotation';
import { openImage } from '../../src/open-image.js';

function createMockViewer(): OpenSeadragon.Viewer {
  return { open: vi.fn() } as unknown as OpenSeadragon.Viewer;
}

function createSource(tileSource: string): ImageSource {
  return { id: createImageId(), tileSource };
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
});
