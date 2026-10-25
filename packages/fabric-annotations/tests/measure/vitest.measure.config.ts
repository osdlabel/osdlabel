import { defineConfig } from 'vitest/config';

/**
 * Runs the mask-downsample measurement (not part of `pnpm test`):
 *
 *   pnpm --filter @osdlabel/fabric-annotations measure:mask-downsample
 *
 * jsdom, because the renderer and the brush build canvases; the `canvas`
 * package jsdom finds makes those real rasters rather than stubs.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/measure/**/*.measure.ts'],
    testTimeout: 600_000,
    // One file, one worker, so timings are not shared with another suite.
    fileParallelism: false,
  },
});
