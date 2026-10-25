import json, sys, glob, math, os, statistics as st
CAP = 64*1024*1024
MPP = 0.243
def d_for(w, h):
    d = 1
    while math.ceil(w/d)*math.ceil(h/d) > CAP: d *= 2
    return d
def poly_area(v):
    a = 0
    for i in range(len(v)):
        x1,y1 = v[i]; x2,y2 = v[(i+1)%len(v)]
        a += x1*y2 - x2*y1
    return abs(a)/2
rows = []; slides = []; seglens = []
for f in sorted(glob.glob(os.path.join(sys.argv[1], '*.json'))):
    j = json.load(open(f))
    pos = j.get('positive', []); neg = j.get('negative', [])
    xs=[];ys=[]
    for p in pos:
        v = p['vertices']
        px=[a for a,b in v]; py=[b for a,b in v]
        w = max(px)-min(px)+1; h = max(py)-min(py)+1
        area = poly_area(v)
        rows.append((os.path.basename(f), w, h, w*h, area, d_for(w,h), len(v)))
        xs += px; ys += py
        for i in range(len(v)):
            x1,y1=v[i]; x2,y2=v[(i+1)%len(v)]
            seglens.append(math.hypot(x2-x1,y2-y1))
    if pos:
        W = max(xs)-min(xs)+1; H = max(ys)-min(ys)+1
        slides.append((os.path.basename(f), W, H, W*H, d_for(W,H), len(pos), len(neg)))
n = len(rows)
print(f"slides with positive polygons: {len(slides)}; positive polygons: {n}")
over = [r for r in rows if r[3] > CAP]
print(f"polygons whose level-0 bbox exceeds 64 Mi px: {len(over)} ({100*len(over)/n:.1f}%)")
tot_area = sum(r[4] for r in rows); over_area = sum(r[4] for r in over)
print(f"share of annotated tumour area in those polygons: {100*over_area/tot_area:.1f}%")
side2mm = 2000/MPP
long_side = [r for r in rows if max(r[1],r[2]) > side2mm]
print(f"polygons with long bbox side > 2 mm: {len(long_side)} ({100*len(long_side)/n:.1f}%)")
from collections import Counter
print("per-polygon d histogram:", sorted(Counter(r[5] for r in rows).items()))
print("per-slide (one mask per slide) d histogram:", sorted(Counter(s[4] for s in slides).items()))
big = sorted(rows, key=lambda r: -r[3])[:8]
for r in big:
    print(f"  {r[0]} bbox {r[1]}x{r[2]} = {r[1]*MPP/1000:.2f}x{r[2]*MPP/1000:.2f} mm, {r[3]/CAP:.1f}x cap, d={r[5]}, cell {r[5]*MPP:.2f} um, polygon area {r[4]*MPP*MPP/1e6:.2f} mm2, vertices {r[6]}")
areas_mm2 = sorted(r[4]*MPP*MPP/1e6 for r in rows)
print(f"polygon area mm2: median {st.median(areas_mm2):.4f}, p90 {areas_mm2[int(0.9*n)]:.3f}, max {areas_mm2[-1]:.2f}")
seglens.sort()
m = len(seglens)
print(f"vertex spacing (level-0 px): median {st.median(seglens):.1f}, p10 {seglens[int(0.1*m)]:.1f}, p90 {seglens[int(0.9*m)]:.1f}; in um: median {st.median(seglens)*MPP:.2f}")
