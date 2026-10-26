# One row per slide: lesion count and the slide's nearest-neighbour gap distribution (um).
# usage: python -I per_slide.py <out.csv> <gaps_*.csv>...
import csv, math, sys
from collections import defaultdict
MPP = 0.243
out, *ins = sys.argv[1:]
by = defaultdict(list)
for p in ins:
    for r in csv.DictReader(open(p)):
        if r['kind'] == 'lesion':
            by[(r['dataset'], r['slide'])].append(float(r['nn_gap_px']) * MPP)
def q(xs, p):
    xs = sorted(xs); i = p * (len(xs) - 1); lo, hi = math.floor(i), math.ceil(i)
    return xs[lo] + (xs[hi] - xs[lo]) * (i - lo)
with open(out, 'w', newline='') as fh:
    w = csv.writer(fh)
    w.writerow(['dataset', 'slide', 'lesions', 'nn_gap_min_um', 'nn_gap_p25_um', 'nn_gap_median_um', 'nn_gap_max_um'])
    for (ds, sl), g in sorted(by.items()):
        f = [x for x in g if math.isfinite(x)]
        w.writerow([ds, sl, len(g)] + ([f"{min(f):.1f}", f"{q(f,.25):.1f}", f"{q(f,.5):.1f}", f"{max(f):.1f}"] if f else ['', '', '', '']))
multi = {k: [x for x in v if math.isfinite(x)] for k, v in by.items() if len(v) >= 2}
print(f"{len(by)} slides, {len(multi)} with >=2 lesions")
for t in (2.9, 5, 10, 25, 50, 100):
    print(f"  slides whose closest lesion pair is within {t} um: {sum(1 for v in multi.values() if min(v) <= t)} ({100*sum(1 for v in multi.values() if min(v) <= t)/len(multi):.0f}%)")
