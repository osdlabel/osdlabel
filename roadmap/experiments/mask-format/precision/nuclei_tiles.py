# Does C's sparse EMPTY/FULL/MIXED store stay sparse for a whole-slide nuclei map?
import math
MPP = 0.25
dens_pannuke = 189744 / (7901 * (256*MPP)**2 / 1e6)     # nuclei per mm2 from PanNuke's published counts
print(f"PanNuke-derived density: {dens_pannuke:.0f} nuclei/mm2 (189,744 nuclei / 7,901 patches of 256x256 px at 0.25 um/px)")
print(f"Hou et al.: ~5e9 nuclei / 5,060 WSIs = {5e9/5060:,.0f} nuclei per slide")
for rho_mm2 in (1000, 3000, dens_pannuke):
    rho = rho_mm2 / 1e6   # per um2
    for D in (7.0,):
        r = D/2
        for tile_px in (64, 256):
            s = tile_px*MPP
            A = s*s + 4*s*r + math.pi*r*r   # area of tile dilated by nucleus radius
            p_touch = 1 - math.exp(-rho*A)
            print(f"rho={rho_mm2:6.0f}/mm2 D={D}um tile={tile_px}px ({s:.0f}um): P(tile MIXED) ~= {p_touch:.3f}")
# memory for a 2 cm x 1.5 cm tissue box at 0.25 um/px if ~all tiles MIXED
W, H = 80000, 60000
print(f"2x1.5 cm at 0.25 um/px = {W*H/1e9:.1f} Gpx -> all-MIXED tiled store ~= {W*H/8/2**20:,.0f} MiB bit-packed, {W*H/2**30:.2f} GiB as bytes")
# rough row run count for canonical RLE
rho = dens_pannuke/1e6; D = 7.0
crossings_per_row_um = rho * D        # nuclei whose vertical extent covers a given row, per um of row
runs = 2 * crossings_per_row_um * (W*MPP) * H
print(f"canonical RLE: ~{crossings_per_row_um*W*MPP:,.0f} nuclei crossed per row -> ~{runs/1e6:,.0f} M runs over {H} rows")
