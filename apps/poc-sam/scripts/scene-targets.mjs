// Picks deterministic click targets in the synthetic gigapixel scene, so the
// benchmark clicks on real structures (a tissue island, a gland, a nucleus)
// at zoom levels where each is a sensible SAM target.
//   node scripts/scene-targets.mjs   (prints them)
import { fileURLToPath } from 'node:url';
import { SYNTH, glandsNear, insideTissue, nucleiNear, tissueDiscsNear } from './synth-tiles.mjs';

export function pickTargets() {
  const W = SYNTH.width;
  const H = SYNTH.height;
  // A tissue island well inside the image.
  const discs = tissueDiscsNear(0, 0, W, H)
    .filter((d) => d.cx > 25_000 && d.cx < W - 25_000 && d.cy > 20_000 && d.cy < H - 20_000)
    .sort((a, b) => b.r - a.r);
  const island = discs[0];
  // The largest gland near the island's centre.
  const glands = glandsNear(
    island.cx - 8_000,
    island.cy - 8_000,
    island.cx + 8_000,
    island.cy + 8_000,
  ).sort((a, b) => b.r - a.r);
  const gland = glands[0];
  const gland2 = glands[1];
  // A nucleus in tissue, away from the gland.
  const allDiscs = tissueDiscsNear(
    gland.cx - 4_000,
    gland.cy - 4_000,
    gland.cx + 4_000,
    gland.cy + 4_000,
  );
  const nuclei = nucleiNear(
    gland.cx + 2_000,
    gland.cy - 600,
    gland.cx + 2_600,
    gland.cy + 600,
    allDiscs,
  ).filter(
    (n) => n.r > 10 && glands.every((g) => Math.hypot(n.cx - g.cx, n.cy - g.cy) > g.r * 1.2),
  );
  const nucleus = nuclei[0] ?? { cx: gland.cx + 2_300, cy: gland.cy, r: 10 };
  // A point inside the island but outside every gland (tissue stroma).
  let stroma = { x: island.cx, y: island.cy };
  for (let k = 0; k < 50; k++) {
    const a = k * 0.7;
    const p = {
      x: island.cx + Math.cos(a) * island.r * 0.4,
      y: island.cy + Math.sin(a) * island.r * 0.4,
    };
    const inGland = glandsNear(p.x - 1, p.y - 1, p.x + 1, p.y + 1).some(
      (g) => ((p.x - g.cx) / (g.r * g.ax)) ** 2 + ((p.y - g.cy) / (g.r * g.ay)) ** 2 <= 1.1,
    );
    if (!inGland && insideTissue(allDiscs.concat(discs), p.x, p.y)) {
      stroma = p;
      break;
    }
  }
  return {
    image: { width: W, height: H },
    island: { x: island.cx, y: island.cy, r: island.r },
    gland: { x: gland.cx, y: gland.cy, rx: gland.r * gland.ax, ry: gland.r * gland.ay },
    gland2: gland2
      ? { x: gland2.cx, y: gland2.cy, rx: gland2.r * gland2.ax, ry: gland2.r * gland2.ay }
      : null,
    nucleus: { x: nucleus.cx, y: nucleus.cy, r: nucleus.r },
    stroma,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(pickTargets(), null, 2));
}
