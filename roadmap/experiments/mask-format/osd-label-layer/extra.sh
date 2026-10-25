#!/bin/sh
# Extra variants after the main matrix (run from this directory).
node run.mjs "osd=6&mode=osd-sparse" 
node run.mjs "qs:osd=5&mode=osd-sparse&drawer=canvas&mtpf=4"
node run.mjs "qs:osd=5&mode=multi-tiled&n=10&drawer=canvas"
node run.mjs "qs:osd=5&mode=multi-tiled&n=50&drawer=canvas&transp=0"
node run.mjs "qs:osd=5&mode=multi-label&n=200&drawer=canvas"
echo EXTRA-DONE
