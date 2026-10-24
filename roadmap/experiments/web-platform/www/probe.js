const R = {};
const tests = {
  async isolation() {
    return {
      crossOriginIsolated: self.crossOriginIsolated,
      SharedArrayBuffer: typeof SharedArrayBuffer,
      wasmThreadsMemory: (() => {
        try {
          new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
          return 'ok';
        } catch (e) {
          return String(e);
        }
      })(),
    };
  },
  async webglContexts() {
    const out = {};
    for (const kind of ['webgl', 'webgl2']) {
      const lost = [];
      const ctxs = [];
      for (let i = 0; i < 40; i++) {
        const c = document.createElement('canvas');
        c.width = c.height = 64;
        document.body.appendChild(c);
        c.addEventListener('webglcontextlost', () => lost.push(i));
        const gl = c.getContext(kind);
        if (!gl) {
          out[kind + '_nullAt'] = i;
          break;
        }
        gl.clearColor(1, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        ctxs.push(gl);
      }
      await new Promise((r) => setTimeout(r, 500));
      out[kind] = {
        created: ctxs.length,
        lostCount: lost.length,
        lostIdx: lost.slice(0, 30),
        stillAlive: ctxs.filter((g) => !g.isContextLost()).length,
      };
      ctxs.forEach((g) => g.getExtension('WEBGL_lose_context')?.loseContext());
      document.querySelectorAll('canvas').forEach((c) => c.remove());
      await new Promise((r) => setTimeout(r, 300));
    }
    // worker offscreen contexts
    const src = `onmessage=async()=>{const ctx=[];let lost=0;for(let i=0;i<20;i++){const c=new OffscreenCanvas(64,64);c.addEventListener('webglcontextlost',()=>lost++);const g=c.getContext('webgl2');if(!g)break;g.clear(g.COLOR_BUFFER_BIT);ctx.push(g);}await new Promise(r=>setTimeout(r,500));postMessage({created:ctx.length,lost,alive:ctx.filter(g=>!g.isContextLost()).length});}`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    out.worker_webgl2 = await new Promise((r) => {
      w.onmessage = (e) => r(e.data);
      w.postMessage(0);
    });
    w.terminate();
    return out;
  },
  async webgl2Params() {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return 'no webgl2';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const p = (n) => gl.getParameter(gl[n]);
    const exts = gl.getSupportedExtensions();
    // probe R16UI / R16 norm / R32F linear upload of a 3D texture
    const res = {
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
      MAX_TEXTURE_SIZE: p('MAX_TEXTURE_SIZE'),
      MAX_3D_TEXTURE_SIZE: p('MAX_3D_TEXTURE_SIZE'),
      MAX_ARRAY_TEXTURE_LAYERS: p('MAX_ARRAY_TEXTURE_LAYERS'),
      MAX_RENDERBUFFER_SIZE: p('MAX_RENDERBUFFER_SIZE'),
      MAX_TEXTURE_IMAGE_UNITS: p('MAX_TEXTURE_IMAGE_UNITS'),
      hasNorm16: exts.includes('EXT_texture_norm16'),
      hasFloatLinear: exts.includes('OES_texture_float_linear'),
      hasColorBufferFloat: exts.includes('EXT_color_buffer_float'),
      extensions: exts,
    };
    // try a 512x512x256 R16UI and R32F 3D texture allocation (128 MB / 256 MB)
    for (const [name, ifmt, fmt, type, bpp] of [
      ['R16UI', gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT, 2],
      ['R16F', gl.R16F, gl.RED, gl.HALF_FLOAT, 2],
      ['R32F', gl.R32F, gl.RED, gl.FLOAT, 4],
    ]) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_3D, t);
      const t0 = performance.now();
      gl.texStorage3D(gl.TEXTURE_3D, 1, ifmt, 512, 512, 256);
      const err = gl.getError();
      const data = bpp === 2 ? new Uint16Array(512 * 512 * 256) : new Float32Array(512 * 512 * 256);
      gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, 512, 512, 256, fmt, type, data);
      const err2 = gl.getError();
      gl.finish();
      res['tex3d_512x512x256_' + name] = {
        allocErr: err,
        uploadErr: err2,
        ms: +(performance.now() - t0).toFixed(1),
        MB: data.byteLength / 2 ** 20,
      };
      gl.deleteTexture(t);
    }
    return res;
  },
  async webgpu() {
    if (!('gpu' in navigator)) return { navigatorGpu: false };
    const ad = await navigator.gpu.requestAdapter();
    if (!ad) return { navigatorGpu: true, adapter: null };
    const lim = {};
    for (const k in ad.limits) lim[k] = ad.limits[k];
    const info = ad.info
      ? {
          vendor: ad.info.vendor,
          architecture: ad.info.architecture,
          description: ad.info.description,
          isFallbackAdapter: ad.info.isFallbackAdapter,
        }
      : null;
    return {
      navigatorGpu: true,
      info,
      features: [...ad.features].sort(),
      limits: lim,
      wgslLanguageFeatures: navigator.gpu.wgslLanguageFeatures
        ? [...navigator.gpu.wgslLanguageFeatures]
        : null,
    };
  },
  async arrayBufferMax() {
    const out = {};
    for (const sz of [
      2 ** 30,
      1.5 * 2 ** 30,
      2 ** 31 - 4096,
      2 ** 31 - 1,
      2 ** 31,
      3 * 2 ** 30,
      2 ** 32,
      2 ** 33,
      2 ** 34,
      2 ** 35 - 1,
      2 ** 35,
    ]) {
      const key = (sz / 2 ** 30).toFixed(4) + 'GiB';
      try {
        let b = new ArrayBuffer(sz);
        out[key] = 'ok';
        b = null;
      } catch (err) {
        out[key] = err.name + ': ' + err.message;
      }
    }
    try {
      new Uint8Array(2 ** 32 + 1);
      out.u8_len_2pow32p1 = 'ok';
    } catch (err) {
      out.u8_len_2pow32p1 = String(err);
    }
    try {
      new ArrayBuffer(1, { maxByteLength: 2 ** 34 });
      out.resizableMax2pow34 = 'ok';
    } catch (err) {
      out.resizableMax2pow34 = String(err);
    }
    // wasm memory32 / memory64
    try {
      const m = new WebAssembly.Memory({ initial: 1, maximum: 65536 });
      m.grow(65535);
      out.wasm32_grow_to_4GiB = m.buffer.byteLength;
    } catch (err) {
      out.wasm32_grow_to_4GiB = String(err);
    }
    for (const pages of [65537, 131072, 262144, 262145, 1048576]) {
      try {
        const m = new WebAssembly.Memory({ initial: 1n, maximum: BigInt(pages), address: 'i64' });
        m.grow(BigInt(pages - 1));
        out['wasm64_' + ((pages * 65536) / 2 ** 30).toFixed(2) + 'GiB'] =
          'ok byteLength=' + m.buffer.byteLength;
      } catch (err) {
        out['wasm64_' + ((pages * 65536) / 2 ** 30).toFixed(2) + 'GiB'] = String(err).slice(0, 160);
      }
    }
    return out;
  },
  async codecs() {
    const out = { video: {}, encode: {}, image: {} };
    const vc = {
      'h264-baseline': 'avc1.42E01E',
      'h264-high-4.0': 'avc1.640028',
      'h264-high10': 'avc1.6E0028',
      'hevc-main': 'hev1.1.6.L93.B0',
      'hevc-main10': 'hev1.2.4.L120.B0',
      vp8: 'vp8',
      'vp9-p0-8bit': 'vp09.00.10.08',
      'vp9-p2-10bit': 'vp09.02.10.10',
      'av1-main-8bit': 'av01.0.04M.08',
      'av1-main-10bit': 'av01.0.04M.10',
    };
    for (const [k, codec] of Object.entries(vc)) {
      try {
        out.video[k] = (
          await VideoDecoder.isConfigSupported({ codec, codedWidth: 1920, codedHeight: 1080 })
        ).supported;
      } catch (e) {
        out.video[k] = String(e);
      }
      try {
        out.encode[k] = (
          await VideoEncoder.isConfigSupported({ codec, width: 1920, height: 1080, bitrate: 8e6 })
        ).supported;
      } catch (e) {
        out.encode[k] = String(e);
      }
    }
    if ('ImageDecoder' in self)
      for (const t of [
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/avif',
        'image/jxl',
        'image/jp2',
        'image/gif',
        'image/bmp',
        'image/tiff',
      ])
        out.image[t] = await ImageDecoder.isTypeSupported(t);
    out.compression = {};
    for (const f of ['gzip', 'deflate', 'deflate-raw', 'brotli', 'zstd']) {
      try {
        new CompressionStream(f);
        out.compression['C:' + f] = true;
      } catch {
        out.compression['C:' + f] = false;
      }
      try {
        new DecompressionStream(f);
        out.compression['D:' + f] = true;
      } catch {
        out.compression['D:' + f] = false;
      }
    }
    out.Float16Array = typeof Float16Array;
    return out;
  },
  async opfs() {
    const est = await navigator.storage.estimate();
    const src = `onmessage=async(e)=>{const MB=e.data;const root=await navigator.storage.getDirectory();const fh=await root.getFileHandle('vol.bin',{create:true});const h=await fh.createSyncAccessHandle();const chunk=new Uint8Array(16*2**20);for(let i=0;i<chunk.length;i++)chunk[i]=i&255;let t=performance.now();for(let o=0;o<MB;o+=16)h.write(chunk,{at:o*2**20});h.flush();const w=performance.now()-t;const buf=new Uint8Array(MB*2**20);t=performance.now();h.read(buf,{at:0});const r=performance.now()-t;const sz=h.getSize();h.close();await root.removeEntry('vol.bin');postMessage({MB,writeMs:w,readMs:r,size:sz,writeMBps:MB/(w/1000),readMBps:MB/(r/1000)});}`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    const res = await new Promise((r) => {
      w.onmessage = (e) => r(e.data);
      w.onerror = (e) => r(String(e.message));
      w.postMessage(512);
    });
    w.terminate();
    let persisted = null;
    try {
      persisted = await navigator.storage.persisted();
    } catch {}
    return { quotaGiB: est.quota / 2 ** 30, usage: est.usage, persisted, syncHandle512MB: res };
  },
  async rangeFetch() {
    // range requests against the local server
    const r = await fetch('big.bin', { headers: { Range: 'bytes=1000-1999' } });
    const b = await r.arrayBuffer();
    return { status: r.status, len: b.byteLength, contentRange: r.headers.get('content-range') };
  },
};
(async () => {
  const which = new URLSearchParams(location.search).get('t');
  for (const [k, f] of Object.entries(tests)) {
    if (which && !which.split(',').includes(k)) continue;
    try {
      R[k] = await f();
    } catch (e) {
      R[k] = 'ERR ' + e;
    }
  }
  window.__results = R;
})();
