// Procedural cyberpunk city on a GRID x GRID tile grid.
// Layout rules: road = 2 tiles (one lane each way), curb = 1 tile,
// building walls = 1 tile thick, dead-end streets terminate in a roundabout.

import { Rng } from "../engine/rng";
import { GRID } from "../engine/util";

export const T_GROUND = 0;   // open ground / alley / plaza
export const T_SIDEWALK = 1; // curb
export const T_ROAD = 2;
export const T_WALL = 3;     // building perimeter (blocks movement, has height)
export const T_BUILDING = 4; // building interior (roof visible, blocks movement)
export const T_ISLAND = 5;   // roundabout center island (blocks cars, not peds)
export const T_PARK = 6;     // small plaza/park (walkable)
export const T_PIT = 7;      // sunken excavation/vent shaft (blocks movement, not bullets)

// building facade styles
export const NSTYLES = 6;
export const S_CONCRETE = 0, S_GLASS = 1, S_INDUSTRIAL = 2, S_COMMERCIAL = 3, S_BALCONY = 4, S_COLUMNS = 5;

// Lane direction bits (grid space): N = -y, E = +x, S = +y, W = -x
export const D_N = 1, D_E = 2, D_S = 4, D_W = 8;
export const DX = [0, 1, 0, -1]; // N,E,S,W indexed 0..3
export const DY = [-1, 0, 1, 0];
export const DBIT = [D_N, D_E, D_S, D_W];

export interface Deco {
  x: number; y: number;      // wall tile carrying the deco
  face: 0 | 1;               // 0 = SW face (south neighbor open), 1 = SE face (east neighbor open)
  kind: "videowall" | "neon" | "door";
  variant: number;           // which ad / sign / door design
  level: number;             // story on the wall (0-based)
}

export interface Skytrain {
  axis: "v" | "h";
  pos: number;               // x (axis v) or y (axis h) of the left/top lane tile
}

export interface City {
  seed: number;
  tiles: Uint8Array;
  height: Uint8Array;        // stories, for WALL/BUILDING tiles
  bstyle: Uint8Array;        // low nibble: facade style, high nibble: hue variant
  laneDir: Uint8Array;       // bitmask of allowed exits for cars
  decos: Deco[];
  lamps: { x: number; y: number }[];
  roundabouts: { x: number; y: number }[]; // centers
  vRoads: number[];          // x of left lane of each vertical avenue
  hRoads: number[];          // y of top lane of each horizontal avenue
  skytrains: Skytrain[];     // elevated rail lines running above avenues
}

export function idx(x: number, y: number): number { return y * GRID + x; }
export function inGrid(x: number, y: number): boolean { return x >= 0 && y >= 0 && x < GRID && y < GRID; }

export function isWalkable(c: City, x: number, y: number): boolean {
  if (!inGrid(x, y)) return false;
  const t = c.tiles[idx(x, y)];
  return t === T_GROUND || t === T_SIDEWALK || t === T_ROAD || t === T_PARK || t === T_ISLAND;
}
export function isRoad(c: City, x: number, y: number): boolean {
  return inGrid(x, y) && c.tiles[idx(x, y)] === T_ROAD;
}

export function generateCity(seed: number): City {
  const rng = new Rng(seed);
  const tiles = new Uint8Array(GRID * GRID); // all T_GROUND
  const height = new Uint8Array(GRID * GRID);
  const bstyle = new Uint8Array(GRID * GRID);
  const laneDir = new Uint8Array(GRID * GRID);

  // ---- 1. Avenue grid (full-length roads guarantee connectivity) ----
  const vRoads: number[] = [];
  const hRoads: number[] = [];
  for (let x = rng.int(8, 14); x < GRID - 12; x += rng.int(20, 34)) vRoads.push(x);
  for (let y = rng.int(8, 14); y < GRID - 12; y += rng.int(20, 34)) hRoads.push(y);

  const paveRoadV = (x: number, y0: number, y1: number) => {
    for (let y = y0; y <= y1; y++) {
      if (!inGrid(x, y)) continue;
      tiles[idx(x, y)] = T_ROAD; tiles[idx(x + 1, y)] = T_ROAD;
      laneDir[idx(x, y)] |= D_S; laneDir[idx(x + 1, y)] |= D_N;
      for (const cx of [x - 1, x + 2]) {
        if (inGrid(cx, y) && tiles[idx(cx, y)] === T_GROUND) tiles[idx(cx, y)] = T_SIDEWALK;
      }
    }
  };
  const paveRoadH = (y: number, x0: number, x1: number) => {
    for (let x = x0; x <= x1; x++) {
      if (!inGrid(x, y)) continue;
      tiles[idx(x, y)] = T_ROAD; tiles[idx(x, y + 1)] = T_ROAD;
      laneDir[idx(x, y)] |= D_W; laneDir[idx(x, y + 1)] |= D_E;
      for (const cy of [y - 1, y + 2]) {
        if (inGrid(x, cy) && tiles[idx(x, cy)] === T_GROUND) tiles[idx(x, cy)] = T_SIDEWALK;
      }
    }
  };

  for (const x of vRoads) paveRoadV(x, 0, GRID - 1);
  for (const y of hRoads) paveRoadH(y, 0, GRID - 1);

  // Intersections: open up all four exits on the 2x2 crossing so cars can turn.
  for (const x of vRoads) for (const y of hRoads) {
    for (let ix = x; ix <= x + 1; ix++) for (let iy = y; iy <= y + 1; iy++) {
      if (inGrid(ix, iy)) laneDir[idx(ix, iy)] = D_N | D_E | D_S | D_W;
    }
  }

  // ---- 2. Dead-end stub streets ending in roundabouts ----
  const roundabouts: { x: number; y: number }[] = [];
  // Ring is the 1-tile border of the 6x6 rect at (rx0,ry0); interior is the island.
  const areaClear = (x0: number, y0: number, x1: number, y1: number): boolean => {
    if (x0 < 1 || y0 < 1 || x1 >= GRID - 1 || y1 >= GRID - 1) return false;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (tiles[idx(x, y)] !== T_GROUND) return false;
    }
    return true;
  };
  const placeRoundabout = (rx0: number, ry0: number): void => {
    const rx1 = rx0 + 5, ry1 = ry0 + 5;
    for (let y = ry0; y <= ry1; y++) for (let x = rx0; x <= rx1; x++) {
      const border = x === rx0 || x === rx1 || y === ry0 || y === ry1;
      tiles[idx(x, y)] = border ? T_ROAD : T_ISLAND;
    }
    // one-way circulation: top row W, left col S, bottom row E, right col N
    for (let x = rx0; x <= rx1; x++) { laneDir[idx(x, ry0)] |= D_W; laneDir[idx(x, ry1)] |= D_E; }
    for (let y = ry0; y <= ry1; y++) { laneDir[idx(rx0, y)] |= D_S; laneDir[idx(rx1, y)] |= D_N; }
    laneDir[idx(rx0, ry0)] = D_S; laneDir[idx(rx0, ry1)] = D_E;
    laneDir[idx(rx1, ry1)] = D_N; laneDir[idx(rx1, ry0)] = D_W;
    // surrounding sidewalk
    for (let y = ry0 - 1; y <= ry1 + 1; y++) for (let x = rx0 - 1; x <= rx1 + 1; x++) {
      if (inGrid(x, y) && tiles[idx(x, y)] === T_GROUND) tiles[idx(x, y)] = T_SIDEWALK;
    }
    roundabouts.push({ x: rx0 + 2, y: ry0 + 2 });
  };

  const stubCount = 44; // attempts; many fail the clear-area check in dense grids
  for (let i = 0; i < stubCount; i++) {
    const len = rng.int(5, 13);
    if (rng.chance(0.5) && vRoads.length > 0) {
      // horizontal stub off a vertical avenue; stub rows y, y+1
      const ax = rng.pick(vRoads);
      const y = rng.int(8, GRID - 14);
      if (rng.chance(0.5)) { // heading right (east)
        const rx0 = ax + 2 + len, ry0 = y - 2;
        if (!areaClear(ax + 2, ry0 - 1, rx0 + 6, ry0 + 6)) continue;
        placeRoundabout(rx0, ry0);
        paveRoadH(y, ax + 2, rx0 - 1);
        laneDir[idx(rx0, y)] |= D_W;      // ring exit into westbound stub lane
      } else { // heading left (west)
        const rx1 = ax - 3 - len, rx0 = rx1 - 5, ry0 = y - 2;
        if (!areaClear(rx0 - 1, ry0 - 1, ax - 2, ry0 + 6)) continue;
        placeRoundabout(rx0, ry0);
        paveRoadH(y, rx1 + 1, ax - 2);
        laneDir[idx(rx1, y + 1)] |= D_E;  // ring exit into eastbound stub lane
      }
    } else if (hRoads.length > 0) {
      // vertical stub off a horizontal avenue; stub cols x, x+1
      const ay = rng.pick(hRoads);
      const x = rng.int(8, GRID - 14);
      if (rng.chance(0.5)) { // heading down (south)
        const ry0 = ay + 2 + len, rx0 = x - 2;
        if (!areaClear(rx0 - 1, ay + 2, rx0 + 6, ry0 + 6)) continue;
        placeRoundabout(rx0, ry0);
        paveRoadV(x, ay + 2, ry0 - 1);
        laneDir[idx(x + 1, ry0)] |= D_N;  // ring exit into northbound stub lane
      } else { // heading up (north)
        const ry1 = ay - 3 - len, ry0 = ry1 - 5, rx0 = x - 2;
        if (!areaClear(rx0 - 1, ry0 - 1, rx0 + 6, ay - 2)) continue;
        placeRoundabout(rx0, ry0);
        paveRoadV(x, ry1 + 1, ay - 2);
        laneDir[idx(x, ry1)] |= D_S;      // ring exit into southbound stub lane
      }
    }
  }

  // Where stub roads meet the ring or an avenue, open up turning exits.
  for (let y = 1; y < GRID - 1; y++) for (let x = 1; x < GRID - 1; x++) {
    const i = idx(x, y);
    if (tiles[i] !== T_ROAD) continue;
    let roadNbrs = 0;
    for (let d = 0; d < 4; d++) if (tiles[idx(x + DX[d], y + DY[d])] === T_ROAD) roadNbrs++;
    if (roadNbrs >= 3) {
      // junction tile: allow exiting toward every adjacent road tile
      let bits = 0;
      for (let d = 0; d < 4; d++) if (tiles[idx(x + DX[d], y + DY[d])] === T_ROAD) bits |= DBIT[d];
      laneDir[i] |= bits;
    }
  }

  // ---- 3. Blocks: subdivide into building lots ----
  // find block spans between consecutive avenues
  const vEdges = [-3, ...vRoads, GRID + 1];
  const hEdges = [-3, ...hRoads, GRID + 1];
  for (let bi = 0; bi < vEdges.length - 1; bi++) {
    for (let bj = 0; bj < hEdges.length - 1; bj++) {
      const x0 = vEdges[bi] + 3, x1 = vEdges[bi + 1] - 2;      // inside the sidewalks
      const y0 = hEdges[bj] + 3, y1 = hEdges[bj + 1] - 2;
      if (x1 - x0 < 5 || y1 - y0 < 5) continue;
      fillBlock(tiles, height, bstyle, rng, Math.max(1, x0), Math.max(1, y0), Math.min(GRID - 2, x1), Math.min(GRID - 2, y1));
    }
  }

  // ---- 4. Decorations: videowalls and neon on street-facing walls ----
  const decos: Deco[] = [];
  for (let y = 2; y < GRID - 2; y++) {
    for (let x = 2; x < GRID - 2; x++) {
      const i = idx(x, y);
      if (tiles[i] !== T_WALL || height[i] < 2) continue;
      // SW face visible if the tile south is open; SE face if east is open
      const southOpen = tiles[idx(x, y + 1)] <= T_ROAD || tiles[idx(x, y + 1)] === T_PARK;
      const eastOpen = tiles[idx(x + 1, y)] <= T_ROAD || tiles[idx(x + 1, y)] === T_PARK;
      const nearRoadS = southOpen && (tiles[idx(x, y + 2)] === T_ROAD || tiles[idx(x, y + 1)] === T_SIDEWALK);
      const nearRoadE = eastOpen && (tiles[idx(x + 2, y)] === T_ROAD || tiles[idx(x + 1, y)] === T_SIDEWALK);
      if (nearRoadS && rng.chance(0.06)) {
        decos.push({ x, y, face: 0, kind: rng.chance(0.45) ? "videowall" : "neon", variant: rng.int(0, 7), level: rng.int(1, Math.max(1, height[i] - 1)) });
      } else if (nearRoadE && rng.chance(0.06)) {
        decos.push({ x, y, face: 1, kind: rng.chance(0.45) ? "videowall" : "neon", variant: rng.int(0, 7), level: rng.int(1, Math.max(1, height[i] - 1)) });
      }
    }
  }
  // entrance doors with stoop steps on ground-level street-facing walls
  for (let y = 2; y < GRID - 2; y++) {
    for (let x = 2; x < GRID - 2; x++) {
      const i = idx(x, y);
      if (tiles[i] !== T_WALL) continue;
      const ts = tiles[idx(x, y + 1)], te = tiles[idx(x + 1, y)];
      const openS = ts === T_SIDEWALK || ts === T_GROUND || ts === T_PARK;
      const openE = te === T_SIDEWALK || te === T_GROUND || te === T_PARK;
      // spaced out so doors don't stack on adjacent tiles
      if (openS && (x * 3 + y * 5) % 4 === 0 && rng.chance(0.35)) {
        decos.push({ x, y, face: 0, kind: "door", variant: rng.int(0, 3), level: 0 });
      } else if (openE && (x * 5 + y * 3) % 4 === 0 && rng.chance(0.35)) {
        decos.push({ x, y, face: 1, kind: "door", variant: rng.int(0, 3), level: 0 });
      }
    }
  }

  // ---- 5. Street lamps at intersection corners ----
  const lamps: { x: number; y: number }[] = [];
  for (const x of vRoads) for (const y of hRoads) {
    for (const [lx, ly] of [[x - 1, y - 1], [x + 2, y - 1], [x - 1, y + 2], [x + 2, y + 2]] as const) {
      if (inGrid(lx, ly) && tiles[idx(lx, ly)] === T_SIDEWALK && rng.chance(0.8)) lamps.push({ x: lx, y: ly });
    }
  }

  // ---- 6. Elevated skytrain lines above a couple of avenues ----
  const skytrains: Skytrain[] = [];
  if (vRoads.length > 2) skytrains.push({ axis: "v", pos: vRoads[rng.int(1, vRoads.length - 2)] });
  if (hRoads.length > 2 && rng.chance(0.75)) skytrains.push({ axis: "h", pos: hRoads[rng.int(1, hRoads.length - 2)] });

  return { seed, tiles, height, bstyle, laneDir, decos, lamps, roundabouts, vRoads, hRoads, skytrains };
}

// Recursively split a block into lots separated by 4-tile alleys, then raise
// buildings with a facade style, or lay out parks and sunken pits.
// Invariant: two buildings are never closer than 4 tiles (alleys are 4 wide,
// and street corridors are curb+road+road+curb = 4 tiles wall to wall).
function fillBlock(tiles: Uint8Array, height: Uint8Array, bstyle: Uint8Array, rng: Rng, x0: number, y0: number, x1: number, y1: number): void {
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  if (w < 4 || h < 4) return;
  if (w > 13 && (w >= h || h <= 13)) {
    const cut = x0 + rng.int(5, w - 9); // 4-tile alley keeps both halves >= 5 wide
    fillBlock(tiles, height, bstyle, rng, x0, y0, cut - 1, y1);
    fillBlock(tiles, height, bstyle, rng, cut + 4, y0, x1, y1);
    return;
  }
  if (h > 13) {
    const cut = y0 + rng.int(5, h - 9);
    fillBlock(tiles, height, bstyle, rng, x0, y0, x1, cut - 1);
    fillBlock(tiles, height, bstyle, rng, x0, cut + 4, x1, y1);
    return;
  }
  // lot: park / sunken pit / building
  if (rng.chance(0.22)) {
    // parks only claim untouched ground, so stub roads survive
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (tiles[idx(x, y)] === T_GROUND) tiles[idx(x, y)] = T_PARK;
    }
    // some plazas hold a sunken pit (vent shaft / excavation) with a walkable rim
    if (rng.chance(0.35) && w >= 6 && h >= 6) {
      for (let y = y0 + 2; y <= y1 - 2; y++) for (let x = x0 + 2; x <= x1 - 2; x++) {
        if (tiles[idx(x, y)] === T_PARK) tiles[idx(x, y)] = T_PIT;
      }
    }
    return;
  }
  // a building lot must sit on clear ground - never pave over a stub road
  // or roundabout that was carved through this block earlier
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (tiles[idx(x, y)] !== T_GROUND) return;
  }
  // facade style: pick by lot, tall lots lean toward glass towers
  const stories = rng.chance(0.08) ? rng.int(5, 7) : rng.int(1, 4);
  let style: number;
  if (stories >= 5) style = rng.chance(0.6) ? S_GLASS : rng.pick([S_CONCRETE, S_COLUMNS, S_COMMERCIAL]);
  else if (stories === 1) style = rng.pick([S_INDUSTRIAL, S_COMMERCIAL, S_CONCRETE]);
  else style = rng.pick([S_CONCRETE, S_INDUSTRIAL, S_COMMERCIAL, S_BALCONY, S_BALCONY, S_COLUMNS]);
  const hue = rng.int(0, 2);
  const packed = (hue << 4) | style;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const edge = x === x0 || x === x1 || y === y0 || y === y1;
      tiles[idx(x, y)] = edge ? T_WALL : T_BUILDING;
      height[idx(x, y)] = stories;
      bstyle[idx(x, y)] = packed;
    }
  }
}
