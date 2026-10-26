# Compare 2x2 coarsening rules on real CAMELYON16 tumour polygons.
# Level 0 raster (PIL fill) on an image-aligned grid; then for d in 2..16:
#   centre : cell on iff the level-0 pixel at the cell centre (offset d//2) is on (memo's c16_quant rule)
#   any    : cell on iff any level-0 pixel in the d x d block is on (2x2 OR, associative: progressive == one-shot)
#   maj2   : progressive 2x2 steps 1->2->4..., cell on iff >=2 of its 4 children are on
#   maj3   : progressive 2x2 steps, cell on iff >=3 of 4 children are on
# Reports Dice/IoU vs level 0, relative area error, and lesions that vanish.
import json, sys, glob, os, math, random
import numpy as np
from PIL import Image, ImageDraw
D_LIST = [2, 4, 8, 16]
def raster(v):
    xs=[p[0] for p in v]; ys=[p[1] for p in v]
    x0=(min(xs)//16)*16; y0=(min(ys)//16)*16
    W=((max(xs)-x0)//16+1)*16; H=((max(ys)-y0)//16+1)*16
    img=Image.new('1',(W,H),0)
    ImageDraw.Draw(img).polygon([(x-x0,y-y0) for x,y in v], fill=1)
    return np.asarray(img,dtype=bool)
def blocks(m, d):
    H,W=m.shape
    return m.reshape(H//d, d, W//d, d)
def up(c, d):
    return np.repeat(np.repeat(c, d, axis=0), d, axis=1)
def step(c, k):  # 2x2 step with threshold k; k=='cb' -> >=2 with ties on a checkerboard
    H,W=c.shape
    s=c.reshape(H//2,2,W//2,2).sum(axis=(1,3))
    if k=='cb':
        yy,xx=np.indices(s.shape)
        return (s>=3) | ((s==2) & (((xx+yy)&1)==0))
    return s>=k
def score(m, q):
    inter=np.logical_and(m,q).sum(); a0=m.sum(); a1=q.sum()
    return 2*inter/(a0+a1) if a0+a1 else 1.0, (a1-a0)/a0 if a0 else 0.0, a1==0
def main(folder, n, seed):
    polys=[]
    for f in sorted(glob.glob(os.path.join(folder,'*.json'))):
        for p in json.load(open(f)).get('positive',[]):
            v=[tuple(x) for x in p['vertices']]
            if len(v)<3: continue
            xs=[a for a,b in v]; ys=[b for a,b in v]
            w=max(xs)-min(xs)+1; h=max(ys)-min(ys)+1
            if w*h<=8192*8192: polys.append((w*h, os.path.basename(f), v))
    polys.sort(key=lambda t:t[0])
    rnd=random.Random(seed)
    # stratify by bbox area (log10 bins)
    bins={}
    for t in polys: bins.setdefault(int(math.log10(max(t[0],1))),[]).append(t)
    pick=[]
    per=max(1, n//len(bins))
    for k in sorted(bins): pick+= rnd.sample(bins[k], min(per,len(bins[k])))
    print(f"polygons with bbox<=8192^2: {len(polys)}; sampled {len(pick)} across log10 bins {sorted(bins)}", flush=True)
    rows=[]
    for area,name,v in pick:
        m=raster(v)
        res={'name':name,'bbox':area,'a0':int(m.sum())}
        c2=m.copy(); c3=m.copy(); cb=m.copy(); cur=1
        for d in D_LIST:
            b=blocks(m,d)
            centre=m[d//2::d, d//2::d]
            anyc=b.any(axis=(1,3))
            while cur<d:
                c2=step(c2,2); c3=step(c3,3); cb=step(cb,'cb'); cur*=2
            for rule,c in (('centre',centre),('any',anyc),('maj2',c2),('maj3',c3),('maj2cb',cb)):
                dice,aerr,lost=score(m, up(c,d))
                res[(rule,d)]=(dice,aerr,lost)
        rows.append(res)
    print(f"{'rule':7s} {'d':>3s} {'medDice':>8s} {'p5Dice':>8s} {'minDice':>8s} {'medAreaErr':>11s} {'p95|AreaErr|':>12s} {'lost':>5s}")
    for rule in ('centre','any','maj2','maj3','maj2cb'):
        for d in D_LIST:
            ds=np.array([r[(rule,d)][0] for r in rows]); ae=np.array([r[(rule,d)][1] for r in rows]); lost=sum(r[(rule,d)][2] for r in rows)
            print(f"{rule:7s} {d:3d} {np.median(ds):8.4f} {np.percentile(ds,5):8.4f} {ds.min():8.4f} {np.median(ae):+11.4f} {np.percentile(np.abs(ae),95):12.4f} {lost:5d}")
    # area-weighted (pooled) Dice per rule and d
    print("pooled (area-weighted) Dice:")
    for rule in ('centre','any','maj2','maj3','maj2cb'):
        print(rule, ' '.join(f"d{d}={np.average([r[(rule,d)][0] for r in rows], weights=[r['a0'] for r in rows]):.5f}" for d in D_LIST))
if __name__=='__main__':
    main(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]))
