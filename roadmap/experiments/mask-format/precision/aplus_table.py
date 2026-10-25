import math
CAP = 64*1024*1024
def d_for(w, h):
    d = 1
    while math.ceil(w/d)*math.ceil(h/d) > CAP: d *= 2
    return d
print("Square region of side L mm (bbox = L x L):")
print("mpp  L_mm  side_px  bbox/cap  d  cells(MCells)  cell_um  mean_boundary_shift_um(~d/4)  max_shift_um(~0.71d)")
for mpp in (0.25, 0.5):
    for L in (1, 2, 5, 10, 20):
        s = round(L*1000/mpp)
        d = d_for(s, s)
        cells = math.ceil(s/d)**2
        print(f"{mpp:4} {L:5} {s:8} {s*s/CAP:8.2f} {d:3} {cells/1e6:10.2f} {d*mpp:8.2f} {d*mpp/4:10.2f} {0.71*d*mpp:10.2f}")
print()
print("Whole-slide model output imported as ONE mask (2 cm x 1.5 cm tissue box):")
for mpp in (0.25, 0.5):
    w = round(20000/mpp); h = round(15000/mpp)
    d = d_for(w, h)
    print(f"mpp={mpp}: {w}x{h} px = {w*h/1e9:.2f} Gpx = {w*h/CAP:.1f}x cap -> d={d}, grid {math.ceil(w/d)}x{math.ceil(h/d)} = {math.ceil(w/d)*math.ceil(h/d)/1e6:.2f} M cells, cell = {d*mpp:.2f} um")
print()
print("Largest bbox that stays at d=1 (square):", f"{math.sqrt(CAP)*0.25/1000:.3f} mm at 0.25 um/px, {math.sqrt(CAP)*0.5/1000:.3f} mm at 0.5 um/px;",
      f"area {CAP*0.25*0.25/1e6:.2f} mm2 / {CAP*0.5*0.5/1e6:.2f} mm2")
