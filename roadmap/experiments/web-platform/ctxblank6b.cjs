const {
  chromium,
} = require('/home/user/osdlabel/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core');
const OSD =
  '/tmp/claude-0/-home-user-osdlabel/d2340e79-db4e-595c-a199-55b42694fb93/scratchpad/pkgs/osd6/package/build/openseadragon/openseadragon.min.js';
(async () => {
  const browser = await chromium.launch({
    executablePath:
      '/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',
  });
  const page = await browser.newPage({ viewport: { width: 2000, height: 1200 } });
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.setContent(
    '<html><body style="margin:0;background:#000"><div id="grid" style="display:flex;flex-wrap:wrap;width:2000px"></div></body></html>',
  );
  await page.addScriptTag({ path: OSD });
  const res = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = 'rgb(200,100,50)';
    g.fillRect(0, 0, 256, 256);
    const url = c.toDataURL('image/png');
    const viewers = [];
    for (let i = 0; i < 20; i++) {
      const d = document.createElement('div');
      d.style.cssText = 'width:180px;height:180px';
      document.getElementById('grid').appendChild(d);
      const v = OpenSeadragon({
        element: d,
        drawer: 'webgl',
        tileSources: { type: 'image', url },
        showNavigationControl: false,
        animationTime: 0,
      });
      await new Promise((r) => v.addOnceHandler('open', r));
      viewers.push(v);
    }
    await new Promise((r) => setTimeout(r, 800));
    viewers.forEach((v) => {
      v.viewport.panBy(new OpenSeadragon.Point(0.01, 0), true);
      v.forceRedraw();
    });
    await new Promise((r) => setTimeout(r, 800));
    return viewers.map((v, i) => {
      const d = v.drawer;
      const gl =
        d._gl ||
        (d._contextManager && d._contextManager.getContext && d._contextManager.getContext()) ||
        null;
      const keys = Object.keys(d).filter((k) => /gl|context|canvas/i.test(k));
      return {
        i,
        type: d.getType(),
        lost: gl ? gl.isContextLost() : 'n/a',
        keys: i === 0 ? keys : undefined,
        ctor: d.constructor.name,
      };
    });
  });
  console.log(
    JSON.stringify(res.slice(0, 2)),
    'lost:',
    res.filter((r) => r.lost === true).map((r) => r.i),
  );
  console.log('tooMany', logs.filter((l) => /Too many active WebGL/.test(l)).length);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
