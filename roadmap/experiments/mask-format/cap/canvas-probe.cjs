// Replays buildMaskFabricObject's raster path (mask-fabric-object.ts:55-71 on 58a379f) in headless Chromium.
const {
  chromium,
} = require('/home/user/osdlabel/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core');
(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome',
  });
  const page = await browser.newPage();
  console.log('UA', await page.evaluate(() => navigator.userAgent));
  const sizes = [
    [2048, 2048],
    [8192, 8192],
    [16384, 4096],
    [32767, 2048],
    [32768, 2048],
    [65535, 1024],
    [65536, 1024],
    [1047993, 3],
    [16384, 16384],
  ];
  for (const [w, h] of sizes) {
    const r = await page.evaluate(
      ([w, h]) => {
        const out = { w, h, px: w * h };
        try {
          const t0 = performance.now();
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          out.canvasDims = canvas.width + 'x' + canvas.height;
          const ctx = canvas.getContext('2d');
          out.ctx = ctx ? 'ok' : 'null';
          if (!ctx) return out;
          const img = ctx.createImageData(w, h);
          const p = img.data;
          for (let i = 0; i < w * h; i++) {
            const o = i * 4;
            p[o] = 33;
            p[o + 1] = 150;
            p[o + 2] = 243;
            p[o + 3] = 115;
          }
          ctx.putImageData(img, 0, 0);
          out.ms = Math.round(performance.now() - t0);
          // Did it actually draw? Read one pixel back.
          const probe = ctx.getImageData(Math.floor(w / 2), Math.floor(h / 2), 1, 1).data;
          out.readback = Array.from(probe).join(',');
        } catch (e) {
          out.error = e.name + ': ' + e.message;
        }
        return out;
      },
      [w, h],
    );
    console.log(JSON.stringify(r));
  }
  await browser.close();
})();
