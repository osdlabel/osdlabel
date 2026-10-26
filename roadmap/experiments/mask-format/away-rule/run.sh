#!/bin/sh
# Reproduces every number in the spacing study. Needs network for the downloads
# and a venv with shapely + numpy (python3 -m venv ../spacing-venv && ../spacing-venv/bin/pip install shapely numpy).
set -e
H=$(cd "$(dirname "$0")/.." && pwd)
PY="$H/spacing-venv/bin/python -I"
D=$H/spacing-data; O=$H/spacing-out; mkdir -p $D/c16 $D/c16xml $D/c17xml $O
# 1. CAMELYON16 train/valid tumour annotations as converted by NCRF (110 slides)
for s in train valid; do for i in $(seq 1 111); do n=$(printf "%03d" $i)
  code=$(curl -s -o $D/c16/${s}_Tumor_$n.json -w '%{http_code}' https://raw.githubusercontent.com/baidu-research/NCRF/master/jsons/$s/Tumor_$n.json)
  [ "$code" = 200 ] || rm -f $D/c16/${s}_Tumor_$n.json; done; done
# 2. CAMELYON16 test (49) and CAMELYON17 (50) ASAP XMLs from the AWS open-data bucket
#    (key list: s3keys.txt, from https://camelyon-dataset.s3.amazonaws.com/?list-type=2&prefix=CAMELYON1{6,7}/annotations/)
grep -E 'CAMELYON16/annotations/test_|CAMELYON17/' $D/s3keys.txt | while read k; do
  case $k in CAMELYON16*) dir=c16xml;; *) dir=c17xml;; esac
  curl -s -o $D/$dir/$(basename $k) "https://camelyon-dataset.s3.amazonaws.com/$k"; done
cd "$(dirname "$0")"
$PY lesion_gaps.py $O/gaps_c16ncrf.csv c16ncrf $D/c16
$PY lesion_gaps.py $O/gaps_c16test.csv c16test $D/c16xml
$PY lesion_gaps.py $O/gaps_c17.csv c17 $D/c17xml
G="$O/gaps_c16ncrf.csv $O/gaps_c16test.csv $O/gaps_c17.csv"
$PY analyze.py $G > $O/analyze.out
$PY chains.py $G > $O/chains.out
$PY chains.py $O/gaps_c16ncrf.csv > $O/chains_c16ncrf.out
$PY per_slide.py $O/per_slide.csv $G > $O/per_slide.out
$PY check_rep.py $G > $O/check_rep.out
$PY tiff_dims.py tumor_001 tumor_011 tumor_021 tumor_031 tumor_044 tumor_054 tumor_076 tumor_089 tumor_095 tumor_101 tumor_111 > $O/tiff_dims.out
