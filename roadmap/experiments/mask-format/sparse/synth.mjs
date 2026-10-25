// Synthetic SAM-like overview result on the exact S1 frame recorded by the
// SAM PoC (origin/claude/poc-sam:apps/poc-sam/results/representative.json,
// step S1 "overview, first click (cold encode): tissue island"):
//   image 100000 x 80000, frame origin (31594, 16574), cell 234.379 x 234.381,
//   raster 256 x 160 logits.
// The field is a large lobed tissue island that reaches all four raster
// edges (as S1's did: its pre-check box is the whole frame plus the 0.5-cell
// bilinear spill, 60237 x 37737 = 2,273,163,669 px), 4 holes and 10 islets,
// i.e. 15 rings / 4 holes like S1's polygon trace.

export const IMAGE = { width: 100000, height: 80000 };
export const FRAME = {
  originX: 31594,
  originY: 16574,
  pixelWidth: 234.379,
  pixelHeight: 234.381,
  width: 256,
  height: 160,
};

export function buildLogits() {
  const { width: W, height: H } = FRAME;
  const L = new Float32Array(W * H);
  const holes = [
    [70, 70, 9],
    [150, 55, 7],
    [175, 100, 10],
    [110, 112, 6],
  ];
  const islets = [
    [12, 10, 5],
    [30, 8, 3.5],
    [10, 30, 3.5],
    [244, 12, 5],
    [226, 7, 3],
    [246, 148, 6],
    [224, 152, 3.5],
    [12, 150, 5],
    [33, 153, 3],
    [8, 128, 3],
  ];
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      const p = (u + 0.5 - 128) / 128;
      const q = (v + 0.5 - 80) / 80;
      const d = Math.hypot(p, q);
      const th = Math.atan2(q, p);
      const R =
        0.9 +
        0.16 * Math.cos(4 * th) +
        0.06 * Math.sin(7 * th + 0.5) +
        0.03 * Math.cos(11 * th + 2);
      // Logits in SAM's usual range (roughly +-20), boundary wobble from a
      // low-amplitude texture so rows cross the contour irregularly.
      let val = 14 * (R - d) + 0.7 * Math.sin(u * 0.37 + v * 0.11) * Math.cos(v * 0.23 - u * 0.07);
      for (const [hu, hv, hr] of holes) {
        const dist = Math.hypot(u + 0.5 - hu, v + 0.5 - hv);
        val = Math.min(val, 6 * (dist / hr - 1));
      }
      for (const [iu, iv, ir] of islets) {
        const dist = Math.hypot(u + 0.5 - iu, v + 0.5 - iv);
        val = Math.max(val, 6 * (1 - dist / ir));
      }
      L[v * W + u] = val;
    }
  }
  return L;
}

/** Foreground components (8-connected) and holes (4-connected background not touching the border). */
export function topology(bits, W, H) {
  const label = new Int32Array(W * H).fill(-1);
  let comps = 0;
  let holes = 0;
  const stack = [];
  for (let start = 0; start < W * H; start++) {
    if (label[start] !== -1) continue;
    const fg = bits[start] === 1;
    let touches = false;
    label[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop();
      const x = i % W;
      const y = (i - x) / W;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) touches = true;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (!fg && dx !== 0 && dy !== 0) continue; // 4-connected background
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (label[j] !== -1 || (bits[j] === 1) !== fg) continue;
          label[j] = 1;
          stack.push(j);
        }
      }
    }
    if (fg) comps++;
    else if (!touches) holes++;
  }
  return { components: comps, holes, rings: comps + holes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const L = buildLogits();
  const { width: W, height: H } = FRAME;
  const bits = new Uint8Array(W * H);
  let fg = 0;
  let edges = { top: 0, bottom: 0, left: 0, right: 0 };
  for (let v = 0; v < H; v++)
    for (let u = 0; u < W; u++) {
      const b = L[v * W + u] > 0 ? 1 : 0;
      bits[v * W + u] = b;
      fg += b;
      if (b) {
        if (v === 0) edges.top++;
        if (v === H - 1) edges.bottom++;
        if (u === 0) edges.left++;
        if (u === W - 1) edges.right++;
      }
    }
  console.log('model raster', W, 'x', H, 'fg cells', fg, 'of', W * H, 'edge contact', edges);
  console.log('topology at model resolution', topology(bits, W, H));
  // ASCII preview at 1/4 resolution
  for (let v = 0; v < H; v += 4) {
    let s = '';
    for (let u = 0; u < W; u += 2) s += bits[v * W + u] ? '#' : '.';
    console.log(s);
  }
}
