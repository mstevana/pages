// Shared constants and small helpers.

export const GRID = 256;          // city is GRID x GRID tiles
export const TILE_W = 32;         // on-screen tile width at zoom 1
export const TILE_H = 16;         // on-screen tile height at zoom 1
export const STORY_H = 30;        // pixel height of one building story at zoom 1 (~an agent's height)
export const PANEL_FRAC = 0.2;    // control panel takes the left 1/5 of the screen

export type Weather = "day" | "night" | "rainday" | "rainnight";
export const WEATHERS: readonly Weather[] = ["day", "night", "rainday", "rainnight"];
export function isNight(w: Weather): boolean { return w === "night" || w === "rainnight"; }
export function isRain(w: Weather): boolean { return w === "rainday" || w === "rainnight"; }

// Isometric projection: world tile coords (fractional) -> screen px (pre-camera).
export function isoX(tx: number, ty: number): number { return (tx - ty) * (TILE_W / 2); }
export function isoY(tx: number, ty: number): number { return (tx + ty) * (TILE_H / 2); }
// Inverse: screen px (pre-camera) -> world tile coords.
export function unisoTX(px: number, py: number): number { return px / TILE_W + py / TILE_H; }
export function unisoTY(px: number, py: number): number { return py / TILE_H - px / TILE_W; }

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
export function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}
export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  return dx * dx + dy * dy;
}
export function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

// 8 facing directions, index 0..7: S, SW, W, NW, N, NE, E, SE (screen-space).
// World velocity (dx,dy in tile space) maps to a screen direction via iso transform.
export function dirFromVel(dx: number, dy: number): number {
  const sx = isoX(dx, dy), sy = isoY(dx, dy);
  const a = Math.atan2(sy, sx); // screen angle
  // screen: +x right, +y down. S = straight down = PI/2.
  let idx = Math.round((a - Math.PI / 2) / (Math.PI / 4));
  idx = ((-idx % 8) + 8) % 8;
  return idx;
}

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}
export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const g = c.getContext("2d");
  if (!g) throw new Error("no 2d context");
  g.imageSmoothingEnabled = false;
  return g;
}
