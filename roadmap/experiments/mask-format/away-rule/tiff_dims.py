# Level-0 size and pixel spacing of CAMELYON16 slides, read from the first IFD
# of each TIFF on the AWS open-data bucket with HTTP range requests (no full
# download). usage: python -I tiff_dims.py tumor_001 tumor_002 ...
import struct, subprocess, sys

BASE = 'https://camelyon-dataset.s3.amazonaws.com/CAMELYON16/images/'


def rng(name, start, n):
    return subprocess.run(['curl', '-s', '-m', '60', '-r', f'{start}-{start + n - 1}', BASE + name + '.tif'],
                          capture_output=True, check=True).stdout


def dims(name):
    h = rng(name, 0, 16)
    e = '<' if h[:2] == b'II' else '>'
    magic = struct.unpack(e + 'H', h[2:4])[0]
    big = magic == 43
    off = struct.unpack(e + 'Q', h[8:16])[0] if big else struct.unpack(e + 'I', h[4:8])[0]
    ifd = rng(name, off, 8192)
    if big:
        n = struct.unpack(e + 'Q', ifd[:8])[0]; p = 8; esz = 20
    else:
        n = struct.unpack(e + 'H', ifd[:2])[0]; p = 2; esz = 12
    tags = {}
    for k in range(n):
        ent = ifd[p + k * esz: p + (k + 1) * esz]
        tag, typ = struct.unpack(e + 'HH', ent[:4])
        if big:
            cnt = struct.unpack(e + 'Q', ent[4:12])[0]; val = ent[12:20]
        else:
            cnt = struct.unpack(e + 'I', ent[4:8])[0]; val = ent[8:12]
        if typ == 3:
            tags[tag] = struct.unpack(e + 'H', val[:2])[0]
        elif typ == 4:
            tags[tag] = struct.unpack(e + 'I', val[:4])[0]
        elif typ == 16:
            tags[tag] = struct.unpack(e + 'Q', val[:8])[0]
        elif typ == 5:  # rational, stored at an offset
            o = struct.unpack(e + ('Q' if big else 'I'), val[:8] if big else val[:4])[0]
            num, den = struct.unpack(e + 'II', rng(name, o, 8))
            tags[tag] = num / den if den else float('nan')
    w, hgt = tags.get(256), tags.get(257)
    xres, unit = tags.get(282), tags.get(296, 2)
    mpp = None
    if xres:
        mpp = (1e4 if unit == 3 else 25400.0) / xres
    return w, hgt, mpp


for name in sys.argv[1:]:
    w, h, mpp = dims(name)
    print(f"{name}: {w} x {h} px, {mpp if mpp is None else round(mpp, 4)} um/px; "
          f"fit-to-1000px-cell scale {max(w, h) / 1000:.0f} img px per CSS px"
          + (f" = {max(w, h) / 1000 * mpp:.1f} um per CSS px" if mpp else ""))
