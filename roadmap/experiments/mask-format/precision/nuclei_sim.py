# What a d x d cell grid (cell-centre rule) does to nuclei of diameter D um at 0.25 um/px.
import numpy as np
rng = np.random.default_rng(1)
MPP = 0.25
def disc_cells(cx, cy, r, d, W):
    # level-0 raster of a disc (pixel centres), then sample at cell-centre pixels
    yy, xx = np.mgrid[0:W, 0:W]
    m = (xx + 0.5 - cx)**2 + (yy + 0.5 - cy)**2 <= r*r
    c = m[d//2::d, d//2::d]
    return m, c
def components4(c):
    c = c.copy(); n = 0
    H, W = c.shape
    for y in range(H):
        for x in range(W):
            if c[y, x]:
                n += 1; st = [(y, x)]; c[y, x] = False
                while st:
                    a, b = st.pop()
                    for aa, bb in ((a+1,b),(a-1,b),(a,b+1),(a,b-1)):
                        if 0 <= aa < H and 0 <= bb < W and c[aa, bb]:
                            c[aa, bb] = False; st.append((aa, bb))
    return n
print("d  cell_um  D_um  P(vanish)  mean|areaErr|  medianIoU  P(two nuclei 1um apart merge)  P(2um apart merge)")
for d in (4, 8, 16):
    for D in (5, 7, 10):
        r = D/2/MPP
        W = int(2*r + 4*d + 8)//d*d + d
        van = 0; errs = []; ious = []
        for _ in range(400):
            cx = W/2 + rng.uniform(0, d); cy = W/2 + rng.uniform(0, d)
            m, c = disc_cells(cx, cy, r, d, W)
            q = np.repeat(np.repeat(c, d, 0), d, 1)[:W, :W]
            a0 = m.sum(); a1 = q.sum()
            if a1 == 0: van += 1
            errs.append(abs(a1 - a0)/a0)
            ious.append((m & q).sum()/(m | q).sum())
        merges = {}
        for g in (1.0, 2.0):
            k = 0; T = 200
            gp = g/MPP
            for _ in range(T):
                W2 = int(4*r + gp + 6*d)//d*d + d
                ox = rng.uniform(0, d); oy = rng.uniform(0, d)
                yy, xx = np.mgrid[0:W2//2+d, 0:W2]
                cy = (W2//2+d)/2 + oy
                c1 = 2*d + r + ox; c2 = c1 + 2*r + gp
                m = ((xx+0.5-c1)**2 + (yy+0.5-cy)**2 <= r*r) | ((xx+0.5-c2)**2 + (yy+0.5-cy)**2 <= r*r)
                c = m[d//2::d, d//2::d]
                if components4(c) < 2: k += 1
            merges[g] = k/T
        print(f"{d:2} {d*MPP:6.2f} {D:5} {van/400:9.3f} {np.mean(errs):13.3f} {np.median(ious):10.3f} {merges[1.0]:12.3f} {merges[2.0]:22.3f}")
