"""Tabulate results/run-*.json into markdown tables (stdout)."""
import glob
import json
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
rows = {}
for f in sorted(glob.glob(os.path.join(here, 'results', 'run-osd_*.json'))):
    r = json.load(open(f))
    rows[r['qs']] = r

order = [
    'osd=5&mode=base&drawer=canvas', 'osd=5&mode=base&drawer=webgl',
    'osd=5&mode=osd-grid&d=128&drawer=canvas', 'osd=5&mode=osd-grid&d=128&drawer=webgl',
    'osd=5&mode=osd-grid&d=8&drawer=canvas', 'osd=5&mode=osd-grid&d=8&drawer=webgl',
    'osd=5&mode=osd-sparse&drawer=canvas', 'osd=5&mode=osd-sparse&drawer=webgl',
    'osd=5&mode=fabric-grid&d=128&drawer=canvas', 'osd=5&mode=fabric-grid&d=8&drawer=canvas',
    'osd=5&mode=multi-tiled&n=50&drawer=canvas', 'osd=5&mode=multi-label&n=50&drawer=canvas',
    'osd=5&mode=multi-tiled&n=50&drawer=webgl', 'osd=5&mode=multi-label&n=50&drawer=webgl',
    'osd=6&mode=osd-sparse&drawer=canvas', 'osd=6&mode=osd-sparse&drawer=webgl',
]


def name(qs):
    p = dict(kv.split('=') for kv in qs.split('&'))
    m = p['mode']
    label = {'base': 'image only', 'osd-grid': f"OSD layer, grid d={p.get('d')}", 'osd-sparse': 'OSD layer, sparse L0',
             'fabric-grid': f"Fabric canvas, grid d={p.get('d')}", 'multi-tiled': f"{p.get('n')} masks, 1 TiledImage each",
             'multi-label': f"{p.get('n')} masks, 1 label layer"}[m]
    extra = ''.join(f", {k}={p[k]}" for k in ('mtpf', 'transp', 'immediate') if k in p)
    return f"{label} ({p['drawer']}, OSD {p['osd']}{extra})"


def g(r, *path, default='-'):
    cur = r
    for k in path:
        if cur is None or not isinstance(cur, dict) or k not in cur:
            return default
        cur = cur[k]
    return '-' if cur is None else cur


def mb(x):
    return '-' if x in ('-', None) else f"{x / 1048576:.1f}"


present = [q for q in order if q in rows] + [q for q in rows if q not in order]

print('### Setup, first frame, memory\n')
print('| Config | store build ms | store MB | first frame overview ms (tiles) | first frame 1:1 ms (tiles) | mask tile canvases at 1:1 MB | RSS at 1:1 MB (GPU proc) | RSS end MB |')
print('|---|---|---|---|---|---|---|---|')
for q in present:
    r = rows[q]
    if 'error' in r:
        print(f"| {name(q)} | ERROR {r['error'][:80]} |"); continue
    ffo = r.get('firstFrameOverview', {})
    ff1 = r.get('firstFrame11', {})
    fabric = 'fabric-grid' in q
    ffo_s = f"{g(ffo,'ms')} (build {g(ffo,'buildCanvasMs')} + render {g(ffo,'firstRenderMs')})" if fabric else f"{g(ffo,'ms')} ({g(ffo,'maskTiles')})"
    ff1_s = f"{g(ff1,'ms')}" if fabric else f"{g(ff1,'ms')} ({g(ff1,'maskTiles')})"
    tilemb = mb(g(r, 'memAt11', 'maskTileBytes'))
    if fabric:
        tilemb = f"{mb(g(r,'memAt11','fabricCanvasBytes'))} (one canvas)"
    print(f"| {name(q)} | {g(r,'setup','buildMs')} | {mb(g(r,'setup','storeBytes'))} | {ffo_s} | {ff1_s} | {tilemb} | {g(r,'rssAt11','totalMB')} ({g(r,'rssAt11','gpuMB')}) | {g(r,'rssEnd','totalMB')} |")

print('\n### Frame cost while moving (CPU ms per frame = OSD update + OSD draw + Fabric renderAll; p50 / p95 / max; fps)\n')
print('| Config | pan overview | zoom overview | pan 1:1 boundary | dive overview to 1:1 (mask tiles made, ms) | frames > 50 ms (zoom/dive/pan1:1) |')
print('|---|---|---|---|---|---|')
for q in present:
    r = rows[q]
    if 'error' in r:
        continue
    def m(k):
        x = r.get(k)
        if not x:
            return '-'
        return f"{x['cpu']['p50']} / {x['cpu']['p95']} / {x['cpu']['max']}; {x['fps']} fps"
    dv = r.get('dive') or {}
    lf = '/'.join(str(g(r, k, 'longFrames50')) for k in ('zoomOverview', 'dive', 'pan11'))
    print(f"| {name(q)} | {m('panOverview')} | {m('zoomOverview')} | {m('pan11')} | {m('dive')} ({g(dv,'maskTilesMade')}, {g(dv,'maskTileMs')}) | {lf} |")

print('\n### Brush stamp to screen, hit test, selection (ms)\n')
print('| Config | stamp r=150 at 1:1: store / repaint (tiles) / to drawn | 30-stamp stroke p50 / p95 | full-tile repaint / reset | stamp r=3000 at overview: store / repaint / to drawn | hit test p50 / max (1:1, overview) | outline layer first frame (1:1, overview) | dim / re-tint to drawn |')
print('|---|---|---|---|---|---|---|---|')
for q in present:
    r = rows[q]
    if 'error' in r or 'stamp11' not in r:
        continue
    s = r['stamp11']
    fabric = 'fabric-grid' in q
    if fabric:
        st = f"{s['storeMs']} / putImageData + renderAll {g(s,'renderMs')} / {g(s,'totalMs')}"
        rb = r.get('stamp11Rebuild', {})
        alt = f"#149 rebuild: {g(rb,'rebuildMs')} + render {g(rb,'renderMs')} = {g(rb,'totalMs')}"
        so = r.get('stampOverview', {})
        sov = f"{g(so,'storeMs')} / {g(so,'renderMs')} / {g(so,'totalMs')}"
        sor = r.get('stampOverviewRebuild', {})
        sov += f"; rebuild {g(sor,'totalMs')}"
    else:
        st = f"{s['storeMs']} / {s['invalidateMs']} ({s['tilesRepainted']}) / {s['toDrawMs']}"
        fr = r.get('stamp11FullRepaint') or {}
        rs = r.get('stamp11Reset') or {}
        alt = f"full tiles {g(fr,'invalidateMs')} ({g(fr,'tilesRepainted')}); reset {g(rs,'toCompleteMs')} ({g(rs,'drawsUntilComplete')} draws)"
        if r.get('stamp11Osd6'):
            o6 = r['stamp11Osd6']
            alt += f"; OSD 6 await requestInvalidate {g(o6,'toDrawMs')} (promise {g(o6,'invalidatePromiseMs')})"
        if r.get('stamp11Osd6Event'):
            o6 = r['stamp11Osd6Event']
            alt += f"; OSD 6 tile-invalidated setData {g(o6,'toDrawMs')}"
        so = r.get('stampOverview', {})
        sov = f"{g(so,'storeMs')} / {g(so,'invalidateMs')} ({g(so,'tilesRepainted')}) / {g(so,'toDrawMs')}"
    sk = r.get('stroke11', {})
    h1, ho = r.get('hit11', {}), r.get('hitOverview', {})
    ol1, olo = r.get('outline11', {}), r.get('outlineOverview', {})
    ss = r.get('selectionStyle', {})
    print(f"| {name(q)} | {st} | {g(sk,'p50')} / {g(sk,'p95')} | {alt} | {sov} | {g(h1,'p50')} / {g(h1,'max')}; {g(ho,'p50')} / {g(ho,'max')} | {g(ol1,'ms')}; {g(olo,'ms')} | {g(ss,'dimToDrawMs')} / {g(ss,'retintToDrawMs')} |")

print('\n### Correctness checks\n')
for q in present:
    r = rows[q]
    if 'error' in r:
        continue
    bits = []
    for k in ('stamp11', 'stamp11Reset', 'stamp11ResetNoNudge', 'stamp11Osd6', 'stamp11Osd6Event', 'stampOverview'):
        s = r.get(k)
        if s and 'before' in s:
            bits.append(f"{k}: {s['before'][:3]} -> {s['after'][:3]}")
    if r.get('rotateFlip'):
        bits.append('rotateFlip: ' + json.dumps(r['rotateFlip']))
    for k in ('hit11', 'hitOverview'):
        h = r.get(k)
        if h:
            bits.append(f"{k}: {h['hits']}/{h['probes']} hits, {h['agreeWithStore']} agree")
    if r.get('errorsA') or r.get('errorsB'):
        bits.append('errors: ' + json.dumps((r.get('errorsA') or []) + (r.get('errorsB') or []))[:300])
    print(f"- {name(q)}: " + '; '.join(bits))
print('\nload1 at start of each config: ' + ', '.join(f"{name(q)} {rows[q].get('load1', 0):.2f}" for q in present if 'error' not in rows[q]))
