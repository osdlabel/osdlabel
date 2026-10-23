// Installed with Playwright's addInitScript before any page script runs, on
// both the harness grid page and the stock osdlabel dev app, so the two are
// measured identically. Records every WebGL context a page creates, and
// whether (and when) it was lost or restored.
(() => {
  if (window.__ctxProbe) return;
  const records = [];
  const seen = new WeakSet();
  const wrap = (proto, surface) => {
    const orig = proto.getContext;
    proto.getContext = function getContext(type, attrs) {
      const ctx = orig.call(this, type, attrs);
      if (ctx && /webgl/.test(String(type)) && !seen.has(ctx)) {
        seen.add(ctx);
        const stack = (new Error().stack || '')
          .split('\n')
          .slice(2, 6)
          .map((s) => s.trim())
          .join(' | ');
        const rec = {
          id: records.length,
          type: String(type),
          surface,
          createdAt: performance.now(),
          lostEvents: 0,
          restoredEvents: 0,
          ctx,
          canvas: this,
          stack,
        };
        records.push(rec);
        this.addEventListener('webglcontextlost', () => {
          rec.lostEvents++;
        });
        this.addEventListener('webglcontextrestored', () => {
          rec.restoredEvents++;
        });
      }
      return ctx;
    };
  };
  wrap(HTMLCanvasElement.prototype, 'canvas');
  if (typeof OffscreenCanvas !== 'undefined') wrap(OffscreenCanvas.prototype, 'offscreen');
  window.__ctxProbe = {
    summary() {
      let live = 0;
      let lost = 0;
      const byType = {};
      for (const r of records) {
        if (r.ctx.isContextLost()) lost++;
        else live++;
        byType[r.type] = (byType[r.type] || 0) + 1;
      }
      return {
        created: records.length,
        live,
        lost,
        byType,
        lostEvents: records.reduce((a, r) => a + r.lostEvents, 0),
        restoredEvents: records.reduce((a, r) => a + r.restoredEvents, 0),
      };
    },
    records() {
      return records.map((r) => ({
        id: r.id,
        type: r.type,
        surface: r.surface,
        lost: r.ctx.isContextLost(),
        lostEvents: r.lostEvents,
        restoredEvents: r.restoredEvents,
        connected: r.canvas && 'isConnected' in r.canvas ? r.canvas.isConnected : null,
        stack: r.stack,
      }));
    },
  };
})();
