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
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.setContent(
    '<html><body style="margin:0"><div id="grid" style="display:flex;flex-wrap:wrap;width:2000px"></div></body></html>',
  );
  // 1) raw contexts
  const raw = await page.evaluate(() => {
    const out = {};
    for (const kind of ['webgl', 'webgl2']) {
      const ctxs = [];
      for (let i = 0; i < 24; i++) {
        const c = document.createElement('canvas');
        ctxs.push(c.getContext(kind));
      }
      out[kind] = {
        created: ctxs.filter(Boolean).length,
        lost: ctxs.filter((g) => g && g.isContextLost()).length,
      };
      ctxs.forEach((g) => g && g.getExtension('WEBGL_lose_context')?.loseContext());
    }
    const gl = document.createElement('canvas').getContext('webgl2');
    out.renderer = gl && gl.getParameter(gl.RENDERER);
    out.norm16 = !!(gl && gl.getExtension('EXT_texture_norm16'));
    out.floatLinear = !!(gl && gl.getExtension('OES_texture_float_linear'));
    out.maxTex = gl && gl.getParameter(gl.MAX_TEXTURE_SIZE);
    out.max3D = gl && gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
    return out;
  });
  console.log('RAW', JSON.stringify(raw));
  await page.reload();
  await page.setContent(
    '<html><body style="margin:0"><div id="grid" style="display:flex;flex-wrap:wrap;width:2000px"></div></body></html>',
  );
  await page.addScriptTag({ path: OSD });
  const res = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#888';
    g.fillRect(0, 0, 256, 256);
    const url = c.toDataURL('image/png');
    const viewers = [];
    for (let i = 0; i < 20; i++) {
      const d = document.createElement('div');
      d.style.cssText = 'width:200px;height:200px';
      document.getElementById('grid').appendChild(d);
      const v = OpenSeadragon({
        element: d,
        tileSources: { type: 'image', url },
        showNavigationControl: false,
      });
      await new Promise((r) => v.addOnceHandler('open', r));
      viewers.push(v);
    }
    await new Promise((r) => setTimeout(r, 1000));
    return viewers.map((v, i) => ({
      i,
      type: v.drawer.getType(),
      lost: v.drawer._gl ? v.drawer._gl.isContextLost() : null,
    }));
  });
  const types = [...new Set(res.map((r) => r.type))];
  console.log(
    'OSD drawer types',
    types,
    'lost',
    res.filter((r) => r.lost).map((r) => r.i),
  );
  console.log('warnings', logs.filter((l) => /WebGL|context/i.test(l)).slice(0, 5));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
