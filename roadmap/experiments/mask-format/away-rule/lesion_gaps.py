# Gaps between separate tumour regions in CAMELYON16/17 annotations.
#
# A "lesion" is a connected component of (union of tumour polygons) minus
# (union of exclusion polygons) -- the region a ground-truth mask actually
# marks (CAMELYON16 masks are made with _2 / Exclusion painted over _0/_1).
# For every lesion we record the edge-to-edge distance to the nearest other
# lesion on the same slide (level-0 px), plus its bounding box and area.
#
# Also records the same numbers for the raw positive polygons (no union, no
# exclusion), which is what the earlier c16_away.py measured, for comparison.
#
# usage: python -I lesion_gaps.py <out.csv> <dataset-label> <file-or-dir>...
#   files: NCRF JSON ({"positive": [{"vertices": [[x,y],...]}], "negative": [...]})
#          or ASAP XML (<Annotation PartOfGroup=...><Coordinate X= Y= Order=/>)
import csv, glob, json, os, sys
import xml.etree.ElementTree as ET
from collections import Counter

import numpy as np
import shapely
from shapely.geometry import Polygon, MultiPolygon, GeometryCollection
from shapely.ops import unary_union
from shapely.validation import make_valid

POS_GROUPS = {'_0', '_1', 'tumor', 'metastases'}
NEG_GROUPS = {'_2', 'exclusion'}
MIN_AREA_PX = 16.0  # drop slivers left by the difference (16 px^2 ~ 0.9 um^2)
# Components closer than this are one region in any level-0 raster (8-connected),
# e.g. the two lobes make_valid() splits a self-crossing outline into.
TOUCH_PX = 1.0

group_counts = Counter()


def load_json(path):
    j = json.load(open(path))
    return ([p['vertices'] for p in j.get('positive', [])],
            [p['vertices'] for p in j.get('negative', [])])


def load_xml(path):
    pos, neg = [], []
    root = ET.parse(path).getroot()
    for a in root.iter('Annotation'):
        g = (a.get('PartOfGroup') or '').strip()
        group_counts[g] += 1
        coords = sorted(a.iter('Coordinate'), key=lambda c: float(c.get('Order', 0)))
        v = [(float(c.get('X')), float(c.get('Y'))) for c in coords]
        gl = g.lower()
        if gl in POS_GROUPS:
            pos.append(v)
        elif gl in NEG_GROUPS:
            neg.append(v)
        # anything else (e.g. "None") is reported in group_counts and skipped
    return pos, neg


def polygons_of(g):
    if g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    if isinstance(g, (MultiPolygon, GeometryCollection)):
        out = []
        for h in g.geoms:
            out += polygons_of(h)
        return out
    return []  # lines / points carry no area


def to_poly(v):
    v = [tuple(map(float, p)) for p in v]
    if len(set(v)) < 3:
        return []
    g = Polygon(v)
    if not g.is_valid:
        g = make_valid(g)
    return polygons_of(g)


def cluster_touching(geoms):
    n = len(geoms)
    if n < 2:
        return geoms
    arr = np.array(geoms, dtype=object)
    tree = shapely.STRtree(arr)
    a, b = tree.query(arr, predicate='dwithin', distance=TOUCH_PX)
    parent = list(range(n))
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for i, j in zip(a, b):
        ri, rj = find(int(i)), find(int(j))
        if ri != rj:
            parent[ri] = rj
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(geoms[i])
    return [g[0] if len(g) == 1 else MultiPolygon(g) for g in groups.values()]


def nn(geoms):
    """Edge-to-edge distance from each geometry to its nearest other one."""
    n = len(geoms)
    if n < 2:
        return [float('inf')] * n
    arr = np.array(geoms, dtype=object)
    tree = shapely.STRtree(arr)
    idx, dist = tree.query_nearest(arr, exclusive=True, return_distance=True, all_matches=False)
    out = [float('inf')] * n
    for i, d in zip(idx[0], dist):
        out[int(i)] = min(out[int(i)], float(d))
    return out


PAIR_MAX_PX = 4200.0  # record every lesion pair within ~1 mm (for chain / cap analysis)


def rep_gaps(geoms, gaps):
    """Distance from an interior point of each lesion (shapely's representative
    point, i.e. a stroke started inside the lesion rather than on its facing
    edge) to the nearest other lesion."""
    n = len(geoms)
    if n < 2:
        return [float('inf')] * n
    arr = np.array(geoms, dtype=object)
    tree = shapely.STRtree(arr)
    out = []
    for i, g in enumerate(geoms):
        pt = g.representative_point()
        x0, y0, x1, y1 = g.bounds
        reach = gaps[i] + ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5 + 1
        cand = [int(j) for j in tree.query(pt, predicate='dwithin', distance=reach) if int(j) != i]
        out.append(min(pt.distance(geoms[j]) for j in cand) if cand else float('inf'))
    return out


def pairs_within(geoms, max_px):
    n = len(geoms)
    if n < 2:
        return []
    arr = np.array(geoms, dtype=object)
    tree = shapely.STRtree(arr)
    a, b = tree.query(arr, predicate='dwithin', distance=max_px)
    return [(int(i), int(j), float(geoms[int(i)].distance(geoms[int(j)])))
            for i, j in zip(a, b) if int(i) < int(j)]


def main():
    out_csv, label, *paths = sys.argv[1:]
    pair_rows = []
    files = []
    for p in paths:
        files += sorted(glob.glob(os.path.join(p, '*'))) if os.path.isdir(p) else [p]
    rows = []
    dropped = 0
    merged_touching = 0
    for f in files:
        if f.endswith('.json'):
            pos, neg = load_json(f)
        elif f.endswith('.xml'):
            pos, neg = load_xml(f)
        else:
            continue
        per_annotation = [to_poly(v) for v in pos]
        P = [g for parts in per_annotation for g in parts]
        # one geometry per positive annotation, as drawn (a self-crossing
        # outline make_valid() split into lobes stays one entry)
        raw_geoms = [p[0] if len(p) == 1 else MultiPolygon(p) for p in per_annotation if p]
        N = [g for v in neg for g in to_poly(v)]
        if not P:
            continue
        region = unary_union(P)
        if N:
            region = region.difference(unary_union(N))
        comps = polygons_of(region)
        dropped += sum(1 for c in comps if c.area < MIN_AREA_PX)
        comps = [c for c in comps if c.area >= MIN_AREA_PX]
        n_before = len(comps)
        comps = cluster_touching(comps)
        merged_touching += n_before - len(comps)
        slide = os.path.basename(f).rsplit('.', 1)[0]
        for kind, geoms in (('lesion', comps), ('rawpoly', raw_geoms)):
            gaps = nn(geoms)
            reps = rep_gaps(geoms, gaps) if kind == 'lesion' else [float('nan')] * len(geoms)
            for idx, (g, gap, rep) in enumerate(zip(geoms, gaps, reps)):
                x0, y0, x1, y1 = g.bounds
                rows.append({
                    'dataset': label, 'slide': slide, 'kind': kind, 'idx': idx, 'n_on_slide': len(geoms),
                    'nn_gap_px': gap, 'rep_gap_px': rep,
                    'x0': x0, 'y0': y0, 'x1': x1, 'y1': y1,
                    'bbox_w_px': x1 - x0, 'bbox_h_px': y1 - y0, 'area_px': g.area,
                })
        for i, j, dist in pairs_within(comps, PAIR_MAX_PX):
            pair_rows.append({'dataset': label, 'slide': slide, 'i': i, 'j': j, 'dist_px': dist})
    with open(out_csv, 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    with open(out_csv.replace('gaps_', 'pairs_'), 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=['dataset', 'slide', 'i', 'j', 'dist_px'])
        w.writeheader()
        w.writerows(pair_rows)
    les = [r for r in rows if r['kind'] == 'lesion']
    raw = [r for r in rows if r['kind'] == 'rawpoly']
    print(f"{label}: {len(files)} files, {len({r['slide'] for r in les})} slides with tumour, "
          f"{len(raw)} positive polygons -> {len(les)} lesions (components); "
          f"{dropped} slivers < {MIN_AREA_PX} px^2 dropped, {merged_touching} components merged "
          f"into a neighbour within {TOUCH_PX} px")
    if group_counts:
        print(f"  XML groups: {dict(group_counts)}")


if __name__ == '__main__':
    main()
