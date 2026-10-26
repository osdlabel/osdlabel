# sanity: interior-point gap >= edge gap; quantiles of both in um
import csv, sys, math
MPP = 0.243
rows = [r for p in sys.argv[1:] for r in csv.DictReader(open(p)) if r['kind'] == 'lesion' and math.isfinite(float(r['nn_gap_px']))]
bad = sum(1 for r in rows if float(r['rep_gap_px']) + 1e-6 < float(r['nn_gap_px']))
print(f"{len(rows)} lesions with a neighbour; interior gap < edge gap: {bad}")
for k in ('nn_gap_px', 'rep_gap_px'):
    xs = sorted(float(r[k]) * MPP for r in rows)
    print(k, ' '.join(f"p{int(q*100)}={xs[int(q*(len(xs)-1))]:.1f}" for q in (.01, .05, .1, .25, .5, .75, .9)), 'um')
print("share of lesions whose first dab, centred at an interior point, already reaches the nearest other lesion (rep gap < r):")
for rad in (12, 24, 48, 96, 192, 512):
    print(f"  r={rad} img px ({rad*MPP:.1f} um): {100*sum(1 for r in rows if float(r['rep_gap_px']) < rad)/len(rows):.1f}%")
