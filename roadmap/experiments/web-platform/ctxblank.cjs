const {
  chromium,
} = require('/home/user/osdlabel/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core');
const OSD =
  '/home/user/osdlabel/node_modules/.pnpm/openseadragon@5.0.1/node_modules/openseadragon/build/openseadragon/openseadragon.min.js';
(async () => {
  const browser = await chromium.launch({
    executablePath:
      '/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',
  });
  const page = await browser.newPage({ viewport: { width: 2000, height: 1200 } });
  await page.setContent(
    '<html><body style="margin:0;background:#000"><div id="grid" style="display:flex;flex-wrap:wrap;width:2000px"></div></body></html>',
  );
  await page.addScriptTag({ path: OSD });
  const N = Number(process.argv[2] || 20);
  const drawer = process.argv[3] || 'webgl';
  const res = await page.evaluate(
    async ({ N, drawer }) => {
      const c = document.createElement('canvas');
      c.width = 256;
      c.height = 256;
      const g = c.getContext('2d');
      g.fillStyle = 'rgb(200,100,50)';
      g.fillRect(0, 0, 256, 256);
      const url = c.toDataURL('image/png');
      const viewers = [];
      for (let i = 0; i < N; i++) {
        const d = document.createElement('div');
        d.style.cssText = 'width:180px;height:180px';
        document.getElementById('grid').appendChild(d);
        const v = OpenSeadragon({
          element: d,
          drawer,
          tileSources: { type: 'image', url },
          showNavigationControl: false,
          animationTime: 0,
        });
        await new Promise((r) => v.addOnceHandler('open', r));
        viewers.push(v);
      }
      await new Promise((r) => setTimeout(r, 800));
      // force every viewer to redraw after all contexts exist
      viewers.forEach((v) => {
        v.viewport.panBy(new OpenSeadragon.Point(0.01, 0), true);
        v.forceRedraw();
      });
      await new Promise((r) => setTimeout(r, 800));
      return viewers.map((v, i) => {
        const cv = v.drawer.canvas;
        const ctx = cv.getContext('2d');
        const p = ctx.getImageData(Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1).data;
        return {
          i,
          type: v.drawer.getType(),
          lost: v.drawer._gl ? v.drawer._gl.isContextLost() : null,
          center: [p[0], p[1], p[2], p[3]],
        };
      });
    },
    { N, drawer },
  );
  const blank = res
    .filter((r) => r.center[3] === 0 || (r.center[0] < 10 && r.center[1] < 10))
    .map((r) => r.i);
  console.log(
    `N=${N} drawer=${drawer} types=${[...new Set(res.map((r) => r.type))]} lost=${JSON.stringify(res.filter((r) => r.lost).map((r) => r.i))} blankCenters=${JSON.stringify(blank)} sample0=${res[0].center} sampleLast=${res[N - 1].center}`,
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
