# How a "touching" target rule would split CAMELYON16's tumour annotations into masks.
# Worst case: the annotator always paints the next lesion beside the selected mask, so every
# chain of lesions whose gaps are <= R (brush radius + tolerance) becomes one mask (connected
# components of the "gap <= R" graph). Compared against #149 today (one mask per slide) and
# against one mask per annotated polygon.
import json, sys, glob, os, math, statistics as st
from collections import Counter
import numpy as np
from shapely.geometry import Polygon, LineString, Point
from shapely.strtree import STRtree
from shapely.validation import make_valid

CAP = 64 * 1024 * 1024
MPP = 0.243  # um/px, as in c16_quant.py

def d_for(w, h):
    d = 1
    while math.ceil(w / d) * math.ceil(h / d) > CAP:
        d *= 2
    return d

thresholds_um = [0, 2.9, 10, 25, 50, 75, 100, 250, 500, 1000]
maxR = max(thresholds_um) / MPP

degenerate = 0
slides = []
nn_gaps = []  # per polygon: gap to nearest other polygon on the slide, um
for f in sorted(glob.glob(os.path.join(sys.argv[1], '*.json'))):
    pos = json.load(open(f)).get('positive', [])
    if not pos:
        continue
    polys = []
    for p in pos:
        v = [tuple(x) for x in p['vertices']]
        if len(set(v)) < 3:
            degenerate += 1
        if len(set(v)) >= 3:
            g = Polygon(v)
        elif len(set(v)) == 2:
            g = LineString(list(dict.fromkeys(v)))
        else:
            g = Point(v[0])
        if not g.is_valid:
            g = make_valid(g)
        polys.append(g)
    tree = STRtree(polys)
    pairs = {}
    for i, g in enumerate(polys):
        for j in tree.query(g.buffer(0).envelope.buffer(maxR)):
            j = int(j)
            if j <= i:
                continue
            dist = g.distance(polys[j])
            if dist <= maxR:
                pairs[(i, j)] = dist
    n = len(polys)
    nearest = [math.inf] * n
    for (i, j), dist in pairs.items():
        nearest[i] = min(nearest[i], dist)
        nearest[j] = min(nearest[j], dist)
    nn_gaps += [x * MPP for x in nearest]
    slides.append((os.path.basename(f), polys, pairs))

def components(n, edges):
    parent = list(range(n))
    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for i, j in edges:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[ri] = rj
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    return list(groups.values())

def bbox_d(polys, idx):
    xs0, ys0, xs1, ys1 = zip(*(polys[i].bounds for i in idx))
    w = math.floor(max(xs1)) - math.floor(min(xs0)) + 1
    h = math.floor(max(ys1)) - math.floor(min(ys0)) + 1
    return d_for(w, h)

print(f"slides {len(slides)}, polygons {sum(len(s[1]) for s in slides)} ({degenerate} with fewer than 3 distinct vertices)")
g = sorted(nn_gaps)
fin = [x for x in g if math.isfinite(x)]
print(f"nearest-neighbour gap between separate tumour polygons (um), {len(g)} polygons, "
      f"{len(g) - len(fin)} with none within {max(thresholds_um)} um:")
for q in (0.05, 0.1, 0.25, 0.5, 0.75, 0.9):
    print(f"  p{int(q*100)}: {g[int(q*len(g))]:.1f}")
for t in (0, 2.9, 10, 25, 50, 75, 100, 250):
    print(f"  share with a neighbour within {t} um: {100*sum(1 for x in g if x <= t)/len(g):.1f}%")

def report(label, groups_per_slide):
    masks = sum(len(gs) for gs in groups_per_slide)
    over = sum(1 for (name, polys, _), gs in zip(slides, groups_per_slide) if any(bbox_d(polys, gr) > 1 for gr in gs))
    over8 = sum(1 for (name, polys, _), gs in zip(slides, groups_per_slide) if any(bbox_d(polys, gr) >= 8 for gr in gs))
    dhist = Counter(bbox_d(polys, gr) for (name, polys, _), gs in zip(slides, groups_per_slide) for gr in gs)
    print(f"| {label} | {masks} | {over} | {over8} | {dict(sorted(dhist.items()))} |")

print()
print("| rule | masks | slides with a mask past the cap (d>1) | slides with a mask at d>=8 | masks by d |")
print("|---|---|---|---|---|")
report("one mask per slide (#149 today, 'selected')", [[list(range(len(s[1])))] for s in slides])
for t in thresholds_um:
    R = t / MPP
    report(f"'touching', R = {t} um ({R:.0f} px)", [components(len(s[1]), [e for e, dist in s[2].items() if dist <= R]) for s in slides])
report("one mask per polygon (ideal 'explicit')", [[[i] for i in range(len(s[1]))] for s in slides])
