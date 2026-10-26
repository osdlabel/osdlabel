# What the "new mask beyond T CSS px" rule does to mask sizes against #149's
# 64 Mi-pixel cap. Worst case: every lesion is painted right after a neighbour
# within reach, so lesions chain into one mask wherever consecutive gaps are
# <= R = T * (um per CSS px) -- connected components of the "gap <= R" graph.
# usage: python -I chains.py <gaps_*.csv>...   (reads the matching pairs_*.csv)
import csv, math, sys
from collections import defaultdict, Counter

CAP = 64 * 1024 * 1024
MPP = 0.243
ZOOMS = [('overview', 100 * MPP), ('1x', 10.0), ('2x', 5.0), ('5x', 2.0), ('10x', 1.0), ('20x', 0.5), ('40x', 0.25)]
TS = [4, 8, 16, 32]


def d_for(w, h):
    d = 1
    while math.ceil(w / d) * math.ceil(h / d) > CAP:
        d *= 2
    return d


lesions = defaultdict(dict)   # (ds, slide) -> idx -> bounds
pairs = defaultdict(list)     # (ds, slide) -> [(i, j, dist_px)]
for p in sys.argv[1:]:
    for r in csv.DictReader(open(p)):
        if r['kind'] != 'lesion':
            continue
        lesions[(r['dataset'], r['slide'])][int(r['idx'])] = tuple(float(r[k]) for k in ('x0', 'y0', 'x1', 'y1'))
    for r in csv.DictReader(open(p.replace('gaps_', 'pairs_'))):
        pairs[(r['dataset'], r['slide'])].append((int(r['i']), int(r['j']), float(r['dist_px'])))


def groups(n, edges):
    parent = list(range(n))
    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for i, j in edges:
        a, b = find(i), find(j)
        if a != b:
            parent[a] = b
    g = defaultdict(list)
    for i in range(n):
        g[find(i)].append(i)
    return list(g.values())


def d_of(bounds, idx):
    x0 = min(bounds[i][0] for i in idx); y0 = min(bounds[i][1] for i in idx)
    x1 = max(bounds[i][2] for i in idx); y1 = max(bounds[i][3] for i in idx)
    return d_for(math.floor(x1) - math.floor(x0) + 1, math.floor(y1) - math.floor(y0) + 1)


def summarise(label, grouping):
    masks = 0; over = 0; over8 = 0; dh = Counter()
    for key, b in lesions.items():
        gs = grouping(key, b)
        masks += len(gs)
        ds = [d_of(b, g) for g in gs]
        dh.update(ds)
        over += any(d > 1 for d in ds)
        over8 += any(d >= 8 for d in ds)
    n = len(lesions)
    print(f"| {label} | {masks} | {over} ({100*over/n:.0f}%) | {over8} | {dict(sorted(dh.items()))} |")


print(f"{len(lesions)} slides, {sum(len(b) for b in lesions.values())} lesions; reach R = T x um/CSS px\n")
print("| rule | masks | slides with a mask past the cap (d>1) | slides with a mask at d>=8 | masks by d |")
print("|---|---|---|---|---|")
summarise("one mask per slide (#149 today)", lambda k, b: [list(b.keys())])
summarise("one mask per lesion (ideal)", lambda k, b: [[i] for i in b])
for name, z in ZOOMS:
    for t in TS:
        R_px = t * z / MPP
        if R_px > 4200:
            continue  # pairs were only recorded up to ~1 mm
        summarise(f"{name}, T={t} (R={t*z:g} um)",
                  lambda k, b, R_px=R_px: groups(len(b), [(i, j) for i, j, d in pairs[k] if d <= R_px]))
