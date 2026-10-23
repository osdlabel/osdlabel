import OpenSeadragon from 'openseadragon';
import { getImage, jsHeapMB } from './common.js';
import { decodeRamp, h1Setup } from './exp-h1.js';
import { h2Full, h2Osd, h2Workers } from './exp-h2.js';
import { h3Alignment, h3Equivalence, h3Osd, h3Upload } from './exp-h3.js';

/** Capabilities the report's caveats depend on. */
function environment(): object {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
  const info = {
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    devicePixelRatio: window.devicePixelRatio,
    crossOriginIsolated,
    webgl2: !!gl,
    renderer: gl && dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
    maxTextureSize: gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : null,
    extTextureNorm16: gl ? gl.getExtension('EXT_texture_norm16') !== null : null,
    oesTextureFloatLinear: gl ? gl.getExtension('OES_texture_float_linear') !== null : null,
    osdVersion: OpenSeadragon.version.versionStr,
  };
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  return info;
}

function imageInfo(): object {
  const out: Record<string, object> = {};
  for (const name of ['ct', 'mammo', 'ramp'] as const) {
    const img = getImage(name);
    out[name] = {
      width: img.full.width,
      height: img.full.height,
      type: img.full.data.constructor.name,
      range: img.range,
      levels: img.levels.length,
      generateMs: img.genMs,
    };
  }
  return out;
}

const api = {
  environment,
  imageInfo,
  h1Setup,
  decodeRamp,
  h2Full,
  h2Workers,
  h2Osd,
  h3Upload,
  h3Osd,
  h3Equivalence,
  h3Alignment,
  jsHeapMB,
};

declare global {
  interface Window {
    __poc?: typeof api;
  }
}

window.__poc = api;
document.documentElement.dataset['ready'] = 'true';
