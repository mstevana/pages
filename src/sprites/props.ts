// Street furniture: 12 tree designs, benches and food stalls. Everything is
// drawn bottom-anchored so it can be planted on a tile centre.

import { Rng } from "../engine/rng";
import { ctx2d, makeCanvas } from "../engine/util";

export const TREE_W = 28, TREE_H = 46;
export const BENCH_W = 26, BENCH_H = 20;
export const STALL_W = 34, STALL_H = 40;
export const N_TREES = 12;

// Props are bitmaps that get scaled up by the camera zoom (to 3.4x) at draw
// time. Baked at their nominal pixel size they turn to blocks the moment you
// zoom in, so they are drawn at PROP_SS times that size and handed to the
// renderer to scale back down - which keeps the leaves smooth at every zoom.
// The whole part is drawn in logical coordinates onto a context pre-scaled by
// SS, so nothing inside the drawing routines has to know about it.
export const PROP_SS = 4;
function makeProp(w: number, h: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = makeCanvas(w * PROP_SS, h * PROP_SS);
  const g = ctx2d(c);
  g.scale(PROP_SS, PROP_SS);
  return { c, g };
}

function tint(hex: string, mult: number, blue: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 255) * mult);
  const g = Math.min(255, ((n >> 8) & 255) * mult);
  const b = Math.min(255, (n & 255) * (mult + blue));
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function blob(g: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, col: string): void {
  g.fillStyle = col;
  g.beginPath();
  g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  g.fill();
}

function trunk(g: CanvasRenderingContext2D, cx: number, top: number, w: number, col: string, dark: string): void {
  g.fillStyle = col;
  g.fillRect(cx - w / 2, top, w, TREE_H - 2 - top);
  g.fillStyle = dark;
  g.fillRect(cx - w / 2, top, Math.max(1, w / 3), TREE_H - 2 - top);
}

// v: 0..11 - one design per variation
function drawTree(g: CanvasRenderingContext2D, v: number, r: Rng, ambient: number, blue: number, night: boolean): void {
  const cx = TREE_W / 2, base = TREE_H - 2;
  const GREENS = ["#2f6b32", "#27562a", "#3a7a3c", "#1f4a24", "#43804a"];
  const bark = tint("#4a3728", ambient, blue);
  const barkD = tint("#33251b", ambient, blue);
  const leaf = tint(GREENS[v % GREENS.length], ambient, blue);
  const leafD = tint(GREENS[(v + 2) % GREENS.length], ambient * 0.72, blue);
  const leafL = tint(GREENS[(v + 1) % GREENS.length], ambient * 1.25, blue);

  switch (v) {
    case 0: // round broadleaf
      trunk(g, cx, 24, 4, bark, barkD);
      blob(g, cx, 20, 11, 10, leafD);
      blob(g, cx - 2, 18, 9, 8, leaf);
      blob(g, cx - 3, 15, 5, 4, leafL);
      break;
    case 1: // conifer
      trunk(g, cx, 34, 4, bark, barkD);
      for (let i = 0; i < 4; i++) {
        const yy = 34 - i * 8, w = 12 - i * 2.2;
        g.fillStyle = i % 2 ? leafD : leaf;
        g.beginPath();
        g.moveTo(cx, yy - 12); g.lineTo(cx + w, yy); g.lineTo(cx - w, yy);
        g.closePath(); g.fill();
      }
      break;
    case 2: { // palm
      g.fillStyle = bark;
      for (let i = 0; i < 18; i++) g.fillRect(cx - 2 + Math.sin(i * 0.28) * 3, base - i * 1.6, 4, 2);
      const top = base - 28;
      for (let a = 0; a < 7; a++) {
        const ang = (a / 7) * Math.PI * 2;
        g.strokeStyle = a % 2 ? leaf : leafD;
        g.lineWidth = 2.4;
        g.beginPath();
        g.moveTo(cx + 1, top);
        g.quadraticCurveTo(cx + 1 + Math.cos(ang) * 8, top + Math.sin(ang) * 4 - 3, cx + 1 + Math.cos(ang) * 12, top + Math.sin(ang) * 7 + 3);
        g.stroke();
      }
      break;
    }
    case 3: // willow
      trunk(g, cx, 26, 4, bark, barkD);
      blob(g, cx, 19, 11, 7, leafD);
      g.strokeStyle = leaf;
      g.lineWidth = 1.4;
      for (let i = -9; i <= 9; i += 3) {
        g.beginPath();
        g.moveTo(cx + i, 21);
        g.quadraticCurveTo(cx + i * 1.15, 27, cx + i * 1.05, 31 + (i % 2 ? 3 : 0));
        g.stroke();
      }
      break;
    case 4: // bare / dead
      trunk(g, cx, 20, 4, bark, barkD);
      g.strokeStyle = bark;
      g.lineWidth = 2;
      for (const [dx, dy] of [[-8, -8], [8, -9], [-6, -14], [6, -13], [0, -17]] as const) {
        g.beginPath(); g.moveTo(cx, 24); g.lineTo(cx + dx, 24 + dy); g.stroke();
      }
      break;
    case 5: // columnar cypress
      trunk(g, cx, 38, 3, bark, barkD);
      blob(g, cx, 22, 5.5, 17, leafD);
      blob(g, cx - 1, 21, 3.5, 14, leaf);
      break;
    case 6: // broad shade tree
      trunk(g, cx, 28, 5, bark, barkD);
      blob(g, cx, 24, 13, 7, leafD);
      blob(g, cx - 3, 21, 8, 5, leaf);
      blob(g, cx + 4, 22, 6, 4, leafL);
      break;
    case 7: // low bush
      blob(g, cx, base - 5, 9, 6, leafD);
      blob(g, cx - 3, base - 8, 5, 4, leaf);
      blob(g, cx + 4, base - 7, 4, 3, leafL);
      break;
    case 8: // twin trunk
      trunk(g, cx - 4, 26, 3, bark, barkD);
      trunk(g, cx + 4, 24, 3, bark, barkD);
      blob(g, cx - 5, 21, 7, 6, leafD);
      blob(g, cx + 5, 19, 8, 7, leaf);
      break;
    case 9: { // neon-augmented street tree
      trunk(g, cx, 26, 4, tint("#3a3f47", ambient, blue), tint("#23272d", ambient, blue));
      blob(g, cx, 19, 10, 8, tint("#1d3a2e", ambient, blue));
      const glow = ["#25e0ff", "#ff2fa0", "#7dff3f"][v % 3];
      g.strokeStyle = glow;
      g.globalAlpha = night ? 0.95 : 0.55;
      g.lineWidth = 1.2;
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        g.beginPath();
        g.moveTo(cx, 24);
        g.lineTo(cx + Math.cos(a) * 8, 19 + Math.sin(a) * 6);
        g.stroke();
      }
      g.globalAlpha = 1;
      break;
    }
    case 10: { // bio-engineered cap
      trunk(g, cx, 28, 5, tint("#6a6152", ambient, blue), tint("#4a4438", ambient, blue));
      const cap = tint("#7a3a5e", ambient, blue);
      g.fillStyle = cap;
      g.beginPath();
      g.ellipse(cx, 26, 12, 9, 0, Math.PI, 0);
      g.fill();
      g.fillStyle = tint("#a85a82", ambient, blue);
      for (const [sx, sy] of [[-6, 21], [1, 19], [6, 22], [-2, 24]] as const) {
        g.beginPath(); g.ellipse(cx + sx, sy, 2, 1.5, 0, 0, Math.PI * 2); g.fill();
      }
      break;
    }
    default: { // blossom
      trunk(g, cx, 26, 4, bark, barkD);
      const pink = tint("#c05a8a", ambient, blue);
      const pinkL = tint("#e08ab0", ambient, blue);
      blob(g, cx, 20, 11, 9, pink);
      blob(g, cx - 3, 17, 6, 5, pinkL);
      blob(g, cx + 5, 21, 4, 3, pinkL);
      break;
    }
  }
  void r;
}

export function buildTreeArt(seed: number, ambient: number, blue: number, night: boolean): HTMLCanvasElement[] {
  const out: HTMLCanvasElement[] = [];
  for (let v = 0; v < N_TREES; v++) {
    const { c, g } = makeProp(TREE_W, TREE_H);
    // soft ground shadow
    g.fillStyle = "rgba(0,0,0,0.28)";
    g.beginPath();
    g.ellipse(TREE_W / 2, TREE_H - 3, 8, 3, 0, 0, Math.PI * 2);
    g.fill();
    drawTree(g, v, new Rng(seed + v * 977), ambient, blue, night);
    out.push(c);
  }
  return out;
}

export function buildBenchArt(ambient: number, blue: number): HTMLCanvasElement[] {
  const out: HTMLCanvasElement[] = [];
  for (let o = 0; o < 2; o++) {
    const { c, g } = makeProp(BENCH_W, BENCH_H);
    const wood = tint("#6b4e2e", ambient, blue);
    const woodD = tint("#4a3520", ambient, blue);
    const metal = tint("#3a3f47", ambient, blue);
    const dx = o === 0 ? 1 : -1; // faces down-left or down-right
    g.fillStyle = "rgba(0,0,0,0.3)";
    g.beginPath(); g.ellipse(BENCH_W / 2, BENCH_H - 3, 10, 3, 0, 0, Math.PI * 2); g.fill();
    // legs
    g.fillStyle = metal;
    g.fillRect(BENCH_W / 2 - 8 * dx, BENCH_H - 8, 2, 6);
    g.fillRect(BENCH_W / 2 + 6 * dx, BENCH_H - 6, 2, 4);
    // seat slab, sheared along the iso axis
    g.save();
    g.transform(1, dx * 0.5, 0, 1, BENCH_W / 2 - 9, BENCH_H - 12);
    g.fillStyle = wood; g.fillRect(0, 0, 18, 4);
    g.fillStyle = woodD; g.fillRect(0, 3, 18, 1);
    // backrest
    g.fillStyle = wood; g.fillRect(0, -6, 18, 3);
    g.fillStyle = metal; g.fillRect(1, -6, 1, 8); g.fillRect(15, -6, 1, 8);
    g.restore();
    out.push(c);
  }
  return out;
}

export function buildStallArt(ambient: number, blue: number, night: boolean): HTMLCanvasElement[] {
  const out: HTMLCanvasElement[] = [];
  const schemes = [
    { awn: "#c0392b", sign: "#ff2fa0", txt: "NOODLE" },
    { awn: "#1f6f8b", sign: "#25e0ff", txt: "SUSHI" },
    { awn: "#c8891f", sign: "#ffe32f", txt: "KEBAB" },
    { awn: "#2f7a4a", sign: "#7dff3f", txt: "SOY" },
  ];
  for (const s of schemes) {
    const { c, g } = makeProp(STALL_W, STALL_H);
    const cx = STALL_W / 2, base = STALL_H - 2;
    g.fillStyle = "rgba(0,0,0,0.32)";
    g.beginPath(); g.ellipse(cx, base, 13, 4, 0, 0, Math.PI * 2); g.fill();
    // counter body
    const body = tint("#3c414a", ambient, blue), bodyD = tint("#282c33", ambient, blue);
    g.fillStyle = bodyD; g.fillRect(cx - 11, base - 14, 22, 13);
    g.fillStyle = body; g.fillRect(cx - 11, base - 14, 22, 4);
    // hot plate glow
    g.fillStyle = night ? "rgba(255,140,40,0.85)" : "rgba(255,140,40,0.45)";
    g.fillRect(cx - 7, base - 13, 8, 2);
    // awning stripes
    for (let i = 0; i < 6; i++) {
      g.fillStyle = i % 2 ? tint(s.awn, ambient, blue) : tint("#e8e2d8", ambient, blue);
      g.fillRect(cx - 15 + i * 5, base - 22, 5, 6);
    }
    g.fillStyle = tint("#2a2e35", ambient, blue);
    g.fillRect(cx - 15, base - 23, 30, 2);
    // posts
    g.fillRect(cx - 14, base - 21, 2, 8);
    g.fillRect(cx + 12, base - 21, 2, 8);
    // neon sign over the awning
    g.shadowColor = s.sign;
    g.shadowBlur = night ? 5 : 1;
    g.strokeStyle = s.sign;
    g.lineWidth = 1;
    g.strokeRect(cx - 12.5, base - 32.5, 25, 8);
    g.fillStyle = s.sign;
    g.font = "bold 6px monospace";
    g.textAlign = "center";
    g.fillText(s.txt, cx, base - 26.5);
    g.textAlign = "left";
    g.shadowBlur = 0;
    out.push(c);
  }
  return out;
}
