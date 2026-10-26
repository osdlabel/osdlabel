# Turns lesion_gaps.py's CSVs into the tables for the "start a new mask when the
# first stamp is more than T CSS px from the selected mask" rule.
# usage: python -I analyze.py <gaps_*.csv>...
import csv, math, sys
from collections import defaultdict

MPP = 0.243  # um per level-0 px (CAMELYON16 Radboud; Utrecht is 0.226)
# um per CSS px. Objective nX ~ 0.25 * 40 / n um per screen px (40x ~ 0.25).
ZOOMS = [
    ('overview', 100 * MPP),  # 100k-px-wide slide fit to a ~1000 px cell
    ('1x', 10.0), ('2x', 5.0), ('5x', 2.0), ('10x', 1.0), ('20x', 0.5), ('40x', 0.25),
]
TS = [0, 2, 4, 6, 8, 10, 12, 16, 24, 32, 48]
QS = [0.01, 0.05, 0.10, 0.25, 0.50, 0.75, 0.90]
DEFAULT_R, MAX_R = 12, 512  # #149 brush radius, image px

rows = []
for p in sys.argv[1:]:
    with open(p) as fh:
        for r in csv.DictReader(fh):
            for k in ('n_on_slide', 'nn_gap_px', 'rep_gap_px', 'bbox_w_px', 'bbox_h_px', 'area_px'):
                r[k] = float(r[k])
            rows.append(r)


def q(xs, p):
    xs = sorted(xs)
    if not xs:
        return float('nan')
    i = p * (len(xs) - 1)
    lo, hi = math.floor(i), math.ceil(i)
    return xs[lo] + (xs[hi] - xs[lo]) * (i - lo)


def pct(n, d):
    return f"{100 * n / d:.1f}%" if d else "-"


def subset(ds, kind='lesion'):
    return [r for r in rows if (ds == 'all' or r['dataset'] == ds) and r['kind'] == kind]


datasets = sorted({r['dataset'] for r in rows}) + ['all']

print("## 1. Lesions and nearest-neighbour gaps (edge to edge, um)\n")
print("| set | kind | slides | slides with >=2 | lesions | lesions/slide median, p90, max | "
      + " | ".join(f"p{int(x*100)}" for x in QS) + " |")
print("|---|---|---|---|---|---|" + "---|" * len(QS))
for ds in datasets:
    for kind in ('lesion', 'rawpoly'):
        S = subset(ds, kind)
        by = defaultdict(list)
        for r in S:
            by[(r['dataset'], r['slide'])].append(r)
        multi = [k for k, v in by.items() if len(v) >= 2]
        counts = [len(v) for v in by.values()]
        gaps = [r['nn_gap_px'] * MPP for r in S if math.isfinite(r['nn_gap_px'])]
        print(f"| {ds} | {kind} | {len(by)} | {len(multi)} | {len(S)} | "
              f"{q(counts, .5):.0f}, {q(counts, .9):.0f}, {max(counts)} | "
              + " | ".join(f"{q(gaps, x):.1f}" for x in QS) + " |")

print("\n## 2. Per slide: smallest and median nearest-neighbour gap on the slide (um), across slides with >=2 lesions\n")
print("| set | slides | min gap p10 | p25 | p50 | p75 | p90 | slide median gap p25 | p50 | p75 |")
print("|---|---|---|---|---|---|---|---|---|---|")
for ds in datasets:
    by = defaultdict(list)
    for r in subset(ds):
        if math.isfinite(r['nn_gap_px']):
            by[(r['dataset'], r['slide'])].append(r['nn_gap_px'] * MPP)
    mins = [min(v) for v in by.values()]
    meds = [q(v, .5) for v in by.values()]
    print(f"| {ds} | {len(by)} | " + " | ".join(f"{q(mins, x):.1f}" for x in (.1, .25, .5, .75, .9))
          + " | " + " | ".join(f"{q(meds, x):.1f}" for x in (.25, .5, .75)) + " |")

print("\n## 3. Gap quantiles in CSS px at fixed zooms (all three sets pooled, lesions with a neighbour)\n")
gaps_all = [r['nn_gap_px'] * MPP for r in subset('all') if math.isfinite(r['nn_gap_px'])]
print("| zoom | um per CSS px | brush r=12 img px in CSS px | r=512 in CSS px | " + " | ".join(f"gap p{int(x*100)}" for x in QS) + " |")
print("|---|---|---|---|" + "---|" * len(QS))
for name, z in ZOOMS:
    print(f"| {name} | {z:g} | {DEFAULT_R*MPP/z:.2f} | {MAX_R*MPP/z:.1f} | "
          + " | ".join(f"{q(gaps_all, x)/z:.1f}" for x in QS) + " |")


def merge_table(title, gap_css_fn, sets=('all',), extra=None):
    print(f"\n## {title}\n")
    for ds in sets:
        S = [r for r in subset(ds) if math.isfinite(r['nn_gap_px'])]
        slides = defaultdict(list)
        for r in S:
            slides[(r['dataset'], r['slide'])].append(r)
        print(f"set {ds}: {len(S)} lesions with a neighbour on {len(slides)} slides. "
              "Cell = lesions whose nearest other lesion is within T (share of lesions) / slides with at least one such lesion\n")
        print("| zoom | " + " | ".join(f"T={t}" for t in TS) + " |")
        print("|---|" + "---|" * len(TS))
        for name, z in ZOOMS:
            cells = []
            for t in TS:
                hit = [r for r in S if gap_css_fn(r, z) <= t]
                hs = {(r['dataset'], r['slide']) for r in hit}
                cells.append(f"{pct(len(hit), len(S))} / {pct(len(hs), len(slides))}")
            print(f"| {name} | " + " | ".join(cells) + " |")


merge_table("4. Centre rule: a new lesion is swallowed when its edge is within T CSS px of the selected mask "
            "(worst case: its nearest neighbour is the selected mask and the stroke starts on the facing edge)",
            lambda r, z: r['nn_gap_px'] * MPP / z, sets=('c16ncrf', 'all'))

merge_table("4b. Same, but the stroke starts at an interior point of the new lesion (shapely representative_point), "
            "not on its facing edge",
            lambda r, z: r['rep_gap_px'] * MPP / z, sets=('all',))


def fit_zoom(r, S_css):
    long_um = max(r['bbox_w_px'], r['bbox_h_px']) * MPP
    return min(max(long_um / S_css, 0.25), 100 * MPP)


print("\n## 5. Lesion-fit zoom model: each lesion is painted at the zoom where its long side spans S CSS px "
      "(clamped to 40x .. overview). Share of lesions whose nearest neighbour is within T CSS px at that zoom\n")
S_all = [r for r in subset('all') if math.isfinite(r['nn_gap_px'])]
print("| S (CSS px) | median zoom (um/CSS px) | " + " | ".join(f"T={t}" for t in TS) + " |")
print("|---|---|" + "---|" * len(TS))
for S_css in (150, 300, 600, 1000):
    zs = [fit_zoom(r, S_css) for r in S_all]
    cells = [pct(sum(1 for r, z in zip(S_all, zs) if r['nn_gap_px'] * MPP / z <= t), len(S_all)) for t in TS]
    print(f"| {S_css} | {q(zs, .5):.2f} | " + " | ".join(cells) + " |")

print("\n## 6. Lesions closer than the brush (image px; all sets pooled, lesions with a neighbour)\n")
print("| radius r (img px) | r (um) | nn gap < r | nn gap < 2r | slides with a lesion gap < r |")
print("|---|---|---|---|---|")
slides_all = {(r['dataset'], r['slide']) for r in S_all}
for rad in (1, 4, 12, 24, 48, 96, 192, 512):
    lt = [r for r in S_all if r['nn_gap_px'] < rad]
    lt2 = [r for r in S_all if r['nn_gap_px'] < 2 * rad]
    print(f"| {rad} | {rad*MPP:.1f} | {pct(len(lt), len(S_all))} | {pct(len(lt2), len(S_all))} | "
          f"{pct(len({(r['dataset'], r['slide']) for r in lt}), len(slides_all))} |")

print("\n## 7. Disc rule (stroke continues when the brush DISC is within T of the mask: gap - r <= T)\n")
for label, rfn in (
    ("r = #149 default 12 img px", lambda z: DEFAULT_R * MPP / z),
    ("brush held at 10 CSS px radius (r_img = 10*z/0.243, clamped 1..512)",
     lambda z: min(max(10 * z / MPP, 1), MAX_R) * MPP / z),
    ("brush held at 25 CSS px radius (clamped 1..512 img px)",
     lambda z: min(max(25 * z / MPP, 1), MAX_R) * MPP / z),
):
    print(f"\n{label}: share of lesions swallowed\n")
    print("| zoom | r (CSS px) | " + " | ".join(f"T={t}" for t in TS) + " |")
    print("|---|---|" + "---|" * len(TS))
    for name, z in ZOOMS:
        rc = rfn(z)
        cells = [pct(sum(1 for r in S_all if r['nn_gap_px'] * MPP / z - rc <= t), len(S_all)) for t in TS]
        print(f"| {name} | {rc:.1f} | " + " | ".join(cells) + " |")

print("\n## 8. How big lesions are on screen (long side of bbox, CSS px; all lesions)\n")
L = subset('all')
longs = [max(r['bbox_w_px'], r['bbox_h_px']) * MPP for r in L]
print(f"long side um: p10 {q(longs,.1):.0f}, p25 {q(longs,.25):.0f}, p50 {q(longs,.5):.0f}, "
      f"p75 {q(longs,.75):.0f}, p90 {q(longs,.9):.0f}, max {max(longs):.0f}")
print("| zoom | " + " | ".join(f"p{int(x*100)}" for x in (.1, .25, .5, .75, .9)) + " | share < 20 CSS px |")
print("|---|---|---|---|---|---|---|")
for name, z in ZOOMS:
    print(f"| {name} | " + " | ".join(f"{q(longs, x)/z:.0f}" for x in (.1, .25, .5, .75, .9))
          + f" | {pct(sum(1 for l in longs if l / z < 20), len(longs))} |")
