#!/bin/sh
for q in "osd=5&mode=base&drawer=canvas" "osd=5&mode=osd-grid&d=128&drawer=canvas" "osd=5&mode=osd-grid&d=8&drawer=canvas" "osd=5&mode=osd-sparse&drawer=canvas" "osd=5&mode=fabric-grid&d=128&drawer=canvas" "osd=5&mode=fabric-grid&d=8&drawer=canvas" "osd=5&mode=multi-label&n=50&drawer=canvas" "osd=5&mode=multi-tiled&n=50&drawer=canvas"; do
  node run.mjs "qs:$q"
done
echo REP2-DONE
