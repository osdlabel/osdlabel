"""Sample IDC instances for the header survey (scripts/survey.mjs).

    .venv/bin/python -I scripts/py/survey-manifest.py > survey-manifest.json

For each modality, up to PER_MODALITY series under CC BY licences, spread
across collections (round-robin), one instance per series. The survey then
reads only each file's header with an HTTP Range request, so it measures how
often the calibration / display / timing paths the adapter implements occur
in real public data — and exercises the parser on hundreds of real headers.
"""

import json
import random
import sys

from idc_index import IDCClient

MODALITIES = ["CT", "MR", "US", "DX", "CR", "MG", "XA", "PT", "NM", "SM"]
PER_MODALITY = 40
SEED = 1500


def main() -> None:
    rng = random.Random(SEED)
    client = IDCClient()
    idx = client.index
    idx = idx[idx.license_short_name.str.startswith("CC BY") & ~idx.license_short_name.str.contains("NC")]
    out = {"seed": SEED, "per_modality": PER_MODALITY, "base_url": "https://storage.googleapis.com", "items": []}
    for m in MODALITIES:
        sub = idx[idx.Modality == m]
        by_coll = {c: g for c, g in sub.groupby("collection_id")}
        colls = sorted(by_coll)
        rng.shuffle(colls)
        picked = []
        round_ = 0
        while len(picked) < PER_MODALITY and any(len(by_coll[c]) > round_ for c in colls):
            for c in colls:
                g = by_coll[c]
                if len(g) > round_ and len(picked) < PER_MODALITY:
                    picked.append(g.sample(n=1, random_state=rng.randint(0, 2**31 - 1)).iloc[0])
            round_ += 1
        for r in picked:
            urls = client.get_series_file_URLs(r.SeriesInstanceUID, source_bucket_location="gcs")
            if not urls:
                continue
            # <scheme>://<bucket>/<series_uuid>/<instance_uuid>.dcm; the same
            # bucket/key pair is served by storage.googleapis.com.
            key = sorted(urls)[0].split("://", 1)[1]
            out["items"].append({
                "modality": m,
                "collection_id": r.collection_id,
                "license": r.license_short_name,
                "manufacturer": None if str(r.Manufacturer) == "nan" else str(r.Manufacturer),
                "series_instance_uid": r.SeriesInstanceUID,
                "key": key,
            })
    json.dump(out, sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
