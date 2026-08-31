// Procedural fire.
//
// There is no GPU shader here to write - the whole game draws through a 2D
// canvas - so the flame is the shader, evaluated per pixel on the CPU and
// baked once into a seamless flipbook at load. The runtime then blits frames,
// which costs no more than the sprite it replaces while every pixel of it
// came out of the same maths a fragment shader would run.
//
// The technique is the one real-time fire shaders use:
//
//   fBm value noise      several octaves of smoothed lattice noise summed at
//                        halving amplitude, which gives cloud-like structure
//                        at every scale rather than one blobby frequency.
//   domain warping       the noise is sampled at coordinates displaced by
//                        another noise field (Quilez's warping): this is what
//                        turns smooth blobs into licking, curling tongues, and
//                        it is the single biggest step toward looking real.
//   a body mask          fire only exists inside a plume that narrows with
//                        height; the noise then eats into that silhouette so
//                        the edge is ragged and wisps detach at the top.
//   blackbody colour     heat is mapped through the colours a radiating body
//                        actually passes through - deep red, orange, amber,
//                        straw, white - instead of a hand-picked gradient. A
//                        touch of blue sits at the root, where combustion is
//                        complete, exactly as it does on a real fire.
//
// The loop is seamless because the noise lattice wraps on a fixed period in
// the vertical axis and one cycle scrolls it by exactly that period.

import { ctx2d, makeCanvas } from "../engine/util";

export const FLAME_FRAMES = 24;      // one loop
export const FLAME_W = 48;
export const FLAME_H = 80;

const PERIOD = 8;                    // lattice rows the noise repeats over

function hash2(ix: number, iy: number): number {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// value noise that repeats every `per` units of y, so a scroll of exactly one
// period returns the field to where it started
function vnoise(x: number, y: number, per: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const wy0 = ((y0 % per) + per) % per, wy1 = ((y0 + 1) % per + per) % per;
  const a = hash2(x0, wy0), b = hash2(x0 + 1, wy0);
  const c = hash2(x0, wy1), d = hash2(x0 + 1, wy1);
  const top = a + (b - a) * sx, bot = c + (d - c) * sx;
  return top + (bot - top) * sy;
}

function fbm(x: number, y: number, per: number, oct: number): number {
  let sum = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(x * f, y * f, per * f);
    norm += amp;
    amp *= 0.5; f *= 2;
  }
  return sum / norm;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (e0: number, e1: number, v: number): number => {
  const t = clamp01((v - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// The colours a radiating body passes through as it heats, sampled coarsely
// and interpolated. Soot red at the fringe through to white at the core.
const BODY: [number, number, number, number][] = [
  [0.00, 0, 0, 0],
  [0.10, 78, 8, 2],
  [0.26, 176, 34, 5],
  [0.44, 240, 92, 14],
  [0.60, 255, 148, 38],
  [0.75, 255, 196, 88],
  [0.88, 255, 232, 160],
  [1.00, 255, 250, 232],
];
function blackbody(h: number): [number, number, number] {
  const t = clamp01(h);
  for (let i = 1; i < BODY.length; i++) {
    if (t <= BODY[i][0]) {
      const a = BODY[i - 1], b = BODY[i];
      const f = (t - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
    }
  }
  return [255, 250, 232];
}

// One frame of the loop, at phase t in [0,1)
function renderFrame(t: number): HTMLCanvasElement {
  const c = makeCanvas(FLAME_W, FLAME_H);
  const g = ctx2d(c);
  const img = g.createImageData(FLAME_W, FLAME_H);
  const d = img.data;
  const scroll = t * PERIOD;              // exactly one lattice period per loop

  for (let py = 0; py < FLAME_H; py++) {
    // v: 0 at the base of the flame, 1 at the tip
    const v = 1 - py / (FLAME_H - 1);
    for (let px = 0; px < FLAME_W; px++) {
      const u = (px / (FLAME_W - 1)) * 2 - 1;

      // ---- domain warp: displace the sampling point by another noise field,
      // which is what makes the tongues curl instead of merely wobbling ----
      const q1 = fbm(u * 2.3, v * 3.2 - scroll, PERIOD, 3) - 0.5;
      const q2 = fbm(u * 2.3 + 4.7, v * 3.2 - scroll + 2.1, PERIOD, 3) - 0.5;
      const wu = u + q1 * 0.85 * (0.2 + v);       // curls harder toward the tip
      const wv = v + q2 * 0.30 * v;

      // ---- the plume: fire only lives inside a body that narrows with height
      const halfW = Math.pow(1 - v, 0.5) * 0.92;
      let mask = 1 - Math.abs(wu) / (halfW > 0.02 ? halfW : 0.02);
      mask = clamp01(mask);
      mask = mask * mask * (3 - 2 * mask);
      mask *= smoothstep(0, 0.05, v);             // no hard cut at the ground

      // ---- heat: turbulence eating into the plume, cooling as it rises ----
      const n = fbm(wu * 3.1, wv * 4.4 - scroll, PERIOD, 4);
      let heat = (0.35 + n * 1.5) * mask - v * 0.62;
      heat = clamp01(heat);
      heat = Math.pow(heat, 0.8);

      const i = (py * FLAME_W + px) * 4;
      if (heat <= 0.004) { d[i + 3] = 0; continue; }

      let [r, gg, b] = blackbody(heat);
      // the blue root of a clean flame, only where it is hot and low down
      const blue = smoothstep(0.22, 0.0, v) * smoothstep(0.35, 0.7, heat);
      if (blue > 0) {
        r += (110 - r) * blue * 0.55;
        gg += (170 - gg) * blue * 0.35;
        b += (255 - b) * blue * 0.8;
      }
      // Drawn additively, so alpha is how much light this pixel throws. The
      // curve keeps the fringe thin and the core solid.
      const a = clamp01(Math.pow(heat, 1.35) * 1.25);
      d[i] = r | 0; d[i + 1] = gg | 0; d[i + 2] = b | 0;
      d[i + 3] = (a * 255) | 0;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

let cached: HTMLCanvasElement[] | null = null;
export function flameFrames(): HTMLCanvasElement[] {
  if (!cached) {
    cached = [];
    for (let i = 0; i < FLAME_FRAMES; i++) cached.push(renderFrame(i / FLAME_FRAMES));
  }
  return cached;
}
