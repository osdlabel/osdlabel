// Experiment: how much does polygon keyframe interpolation depend on vertex
// correspondence? Ground truth: a circle of radius 100 translating from x=0 to
// x=200; the true midpoint shape is a circle at x=100 (area = pi*100^2).
const circle = (cx, cy, r, n, startAngle = 0, dir = 1) =>
  Array.from({ length: n }, (_, i) => {
    const a = startAngle + (dir * (2 * Math.PI * i)) / n;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
const area = (p) =>
  Math.abs(
    p.reduce((s, a, i) => {
      const b = p[(i + 1) % p.length];
      return s + a.x * b.y - b.x * a.y;
    }, 0) / 2,
  );
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
// Index-wise (Label Studio VideoVector-like when ids line up; CVAT requires same start/dir)
const indexWise = (A, B, t) => A.map((a, i) => (B[i] ? lerp(a, B[i], t) : a));
// Arc-length resampling to N points from vertex 0, then index-wise
const resample = (P, N) => {
  const segs = P.map((a, i) => {
    const b = P[(i + 1) % P.length];
    return Math.hypot(b.x - a.x, b.y - a.y);
  });
  const L = segs.reduce((s, v) => s + v, 0);
  const out = [];
  let si = 0,
    acc = 0;
  for (let k = 0; k < N; k++) {
    const target = (k * L) / N;
    while (acc + segs[si] < target) {
      acc += segs[si];
      si++;
    }
    const a = P[si],
      b = P[(si + 1) % P.length];
    out.push(lerp(a, b, (target - acc) / segs[si]));
  }
  return out;
};
// Best cyclic alignment of B to A (min sum of squared distances), both resampled to N
const align = (A, B) => {
  let best = 0,
    bestCost = Infinity;
  for (let s = 0; s < B.length; s++) {
    let c = 0;
    for (let i = 0; i < A.length; i++) {
      const b = B[(i + s) % B.length];
      c += (A[i].x - b.x) ** 2 + (A[i].y - b.y) ** 2;
    }
    if (c < bestCost) {
      bestCost = c;
      best = s;
    }
  }
  return A.map((_, i) => B[(i + best) % B.length]);
};
const truth = Math.PI * 100 * 100;
const report = (name, P) =>
  console.log(
    `${name.padEnd(58)} area err ${(((area(P) - truth) / truth) * 100).toFixed(1).padStart(6)}%`,
  );
const N = 64;
const A = circle(0, 0, 100, 32, 0);
const cases = [
  ['B same n, same start', circle(200, 0, 100, 32, 0)],
  ['B same n, start shifted 1/4 turn', circle(200, 0, 100, 32, Math.PI / 2)],
  ['B same n, start shifted 1/2 turn', circle(200, 0, 100, 32, Math.PI)],
  ['B same n, reversed direction', circle(200, 0, 100, 32, 0, -1)],
  ['B different n (48), same start', circle(200, 0, 100, 48, 0)],
];
for (const [name, B] of cases) {
  report(`index-wise   | ${name}`, indexWise(A, B, 0.5));
  const Ar = resample(A, N),
    Br = resample(B, N);
  report(`resample     | ${name}`, indexWise(Ar, Br, 0.5));
  report(`resample+align| ${name}`, indexWise(Ar, align(Ar, Br), 0.5));
}
const signed = (p) =>
  p.reduce((s, a, i) => {
    const b = p[(i + 1) % p.length];
    return s + a.x * b.y - b.x * a.y;
  }, 0);
const orient = (p) => (signed(p) < 0 ? [...p].reverse() : p);
for (const [name, B] of cases) {
  const Ar = resample(orient(A), N),
    Br = resample(orient(B), N);
  report(`orient+resample+align | ${name}`, indexWise(Ar, align(Ar, Br), 0.5));
}
// Cost: how long does orient+resample+align take for 1000 vertices, N=256?
const big = circle(0, 0, 100, 1000),
  big2 = circle(200, 0, 100, 1200, 1.0);
const t0 = performance.now();
for (let r = 0; r < 100; r++) {
  const Ar = resample(orient(big), 256),
    Br = resample(orient(big2), 256);
  indexWise(Ar, align(Ar, Br), 0.5);
}
console.log(
  `orient+resample(256)+align, 1000 vs 1200 vertices: ${((performance.now() - t0) / 100).toFixed(2)} ms/interp (node ${process.version})`,
);
