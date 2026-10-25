# Quantization error of A+'s per-mask downsample on real CAMELYON16 tumour polygons.
# Level-0 raster (PIL polygon fill) vs the same mask stored on a d x d cell grid
# (cell in iff the level-0 pixel at the cell centre is in), expanded back to level 0.
import json, sys, glob, math, os, time
import numpy as np
from PIL import Image, ImageDraw
CAP = 64*1024*1024; MPP = 0.243
def d_for(w, h):
    d = 1
    while math.ceil(w/d)*math.ceil(h/d) > CAP: d *= 2
    return d
def perim(v):
    return sum(math.hypot(v[(i+1)%len(v)][0]-v[i][0], v[(i+1)%len(v)][1]-v[i][1]) for i in range(len(v)))
def measure(v, d, band=2048):
    px=[a for a,b in v]; py=[b for a,b in v]
    x0=min(px)//d*d; y0=min(py)//d*d
    W=(max(px)-x0)//d*d+d; H=(max(py)-y0)//d*d+d
    band = band//d*d
    inter=union=a0=ad=sym=0
    for by in range(0, H, band):
        bh=min(band, H-by)
        img=Image.new('1',(W,bh),0)
        ImageDraw.Draw(img).polygon([(x-x0, y-y0-by) for x,y in v], fill=1)
        m=np.asarray(img,dtype=bool)
        c=m[d//2::d, d//2::d]          # cell-centre sample
        q=np.repeat(np.repeat(c,d,axis=0),d,axis=1)[:bh,:W]
        a0+=int(m.sum()); ad+=int(q.sum())
        x=np.logical_xor(m,q); sym+=int(x.sum())
        inter+=int(np.logical_and(m,q).sum())
    return a0, ad, inter, sym
if __name__ == '__main__':
    files = {os.path.basename(f): f for f in glob.glob(os.path.join(sys.argv[1],'*.json'))}
    cands=[]
    for name,f in files.items():
        for p in json.load(open(f)).get('positive',[]):
            v=[tuple(x) for x in p['vertices']]
            px=[a for a,b in v]; py=[b for a,b in v]
            w=max(px)-min(px)+1; h=max(py)-min(py)+1
            d=d_for(w,h)
            if d>1: cands.append((w*h,name,v,d))
    cands.sort(key=lambda c:-c[0])
    pick = cands[:6] + [c for c in cands if c[3]==4][:4] + [c for c in cands if c[3]==2][:4]
    seen=set()
    for area,name,v,d in pick:
        key=(name,area)
        if key in seen: continue
        seen.add(key)
        t=time.time()
        a0,ad,inter,sym=measure(v,d)
        P=perim(v)
        dice=2*inter/(a0+ad); iou=inter/(a0+ad-inter)
        print(f"{name} d={d} cell={d*MPP:.2f}um bbox={area/CAP:.1f}xcap area={a0*MPP*MPP/1e6:.2f}mm2 "
              f"dice={dice:.6f} iou={iou:.6f} areaErr={(ad-a0)/a0:+.2e} meanBoundaryShift={sym/P*MPP:.3f}um "
              f"({sym/P:.2f}px, {sym/P/d:.3f} cells) [{time.time()-t:.0f}s]", flush=True)
    