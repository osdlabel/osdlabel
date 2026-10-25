# Whole-slide-as-one-mask case: every positive polygon on a slide stored at the slide's d.
import json, sys, glob, math, os
sys.path.insert(0, os.path.dirname(__file__))
from c16_quant import measure, d_for, perim, MPP  # noqa
import statistics as st
root=sys.argv[1]
for name in sys.argv[2:]:
    j=json.load(open(os.path.join(root,name)))
    pos=[[tuple(x) for x in p['vertices']] for p in j['positive']]
    xs=[x for v in pos for x,_ in v]; ys=[y for v in pos for _,y in v]
    D=d_for(max(xs)-min(xs)+1, max(ys)-min(ys)+1)
    A0=AD=I=S=0; P=0; small=[]
    for v in pos:
        a0,ad,inter,sym=measure(v,D)
        A0+=a0; AD+=ad; I+=inter; S+=sym; P+=perim(v)
        if a0*MPP*MPP < 0.01e6:   # lesions under 0.01 mm2 (~110 um across)
            small.append((a0, ad, 2*inter/(a0+ad) if a0+ad else 1.0))
    dice=2*I/(A0+AD)
    print(f"{name}: one mask per slide -> d={D} ({D*MPP:.2f} um cells), {len(pos)} polygons, area {A0*MPP*MPP/1e6:.2f} mm2, "
          f"dice={dice:.6f}, meanBoundaryShift={S/P*MPP:.2f} um")
    if small:
        ds=sorted(s[2] for s in small)
        lost=sum(1 for s in small if s[1]==0)
        print(f"   {len(small)} lesions < 0.01 mm2: per-lesion dice median {st.median(ds):.3f}, min {ds[0]:.3f}, p10 {ds[len(ds)//10]:.3f}; vanished {lost}; "
              f"smallest lesion {min(s[0] for s in small)*MPP*MPP:.0f} um2")
