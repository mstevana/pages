// Procedural cyberpunk city on a GRID x GRID tile grid.
// Layout rules: road = 2 tiles (one lane each way), curb = 1 tile,
// building walls = 1 tile thick, dead-end streets terminate in a roundabout.

import { Rng } from "../engine/rng";
import { GRID, clamp } from "../engine/util";

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
  kind: "videowall" | "neon" | "door" | "billboard" | "shopwin";
  variant: number;           // which ad / sign / door design
  level: number;             // story on the wall (0-based)
}

export interface ParkSpot {
  x: number; y: number;   // curb tile the car stands on
  px: number; py: number; // where the car actually stands: backed off the kerb
  axis: 0 | 1;            // 0 = parked along x, 1 = parked along y
}

export interface Prop {
  x: number; y: number;      // tile the prop stands on
  kind: "tree" | "bench" | "stall";
  variant: number;
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
  props: Prop[];             // trees, benches, food stalls
  parking: ParkSpot[];       // curbside bays, one or two per city block
  crossing: Uint8Array;      // 0 none, 1 stripes along y, 2 stripes along x
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
  const crossing = new Uint8Array(GRID * GRID);

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

  // ---- 2. Roundabouts ----
  const roundabouts: { x: number; y: number }[] = [];
  const ringTiles = new Set<number>(); // ring road tiles keep strict one-way circulation
  // Ring is the 1-tile border of the 6x6 rect at (rx0,ry0); interior is the island.
  const areaClear = (x0: number, y0: number, x1: number, y1: number): boolean => {
    if (x0 < 1 || y0 < 1 || x1 >= GRID - 1 || y1 >= GRID - 1) return false;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (tiles[idx(x, y)] !== T_GROUND) return false;
    }
    return true;
  };
  const carveRing = (rx0: number, ry0: number, register: boolean): void => {
    // 4x4 ring: a 1-tile circulating road around a 2x2 island
    const rx1 = rx0 + 3, ry1 = ry0 + 3;
    for (let y = ry0; y <= ry1; y++) for (let x = rx0; x <= rx1; x++) {
      const border = x === rx0 || x === rx1 || y === ry0 || y === ry1;
      tiles[idx(x, y)] = border ? T_ROAD : T_ISLAND;
      laneDir[idx(x, y)] = 0; // wipe whatever the avenues wrote here
      if (border) ringTiles.add(idx(x, y));
    }
    // one-way circulation: top row W, left col S, bottom row E, right col N
    for (let x = rx0; x <= rx1; x++) { laneDir[idx(x, ry0)] |= D_W; laneDir[idx(x, ry1)] |= D_E; }
    for (let y = ry0; y <= ry1; y++) { laneDir[idx(rx0, y)] |= D_S; laneDir[idx(rx1, y)] |= D_N; }
    laneDir[idx(rx0, ry0)] = D_S; laneDir[idx(rx0, ry1)] = D_E;
    laneDir[idx(rx1, ry1)] = D_N; laneDir[idx(rx1, ry0)] = D_W;
    // exits into the four outgoing one-way lanes (harmless when nothing is there)
    laneDir[idx(rx0 + 2, ry0)] |= D_N;
    laneDir[idx(rx0 + 1, ry1)] |= D_S;
    laneDir[idx(rx0, ry0 + 1)] |= D_W;
    laneDir[idx(rx1, ry0 + 2)] |= D_E;
    // surrounding sidewalk
    for (let y = ry0 - 1; y <= ry1 + 1; y++) for (let x = rx0 - 1; x <= rx1 + 1; x++) {
      if (inGrid(x, y) && tiles[idx(x, y)] === T_GROUND) tiles[idx(x, y)] = T_SIDEWALK;
    }
    // zebra crossings on each approach, one tile clear of the ring
    const stripe = (sx: number, sy: number, axis: number) => {
      if (inGrid(sx, sy) && tiles[idx(sx, sy)] === T_ROAD) crossing[idx(sx, sy)] = axis;
    };
    for (const dy of [ry0 - 2, ry1 + 2]) {           // north and south approaches
      for (let x = rx0; x <= rx1; x++) stripe(x, dy, 1);
    }
    for (const dx of [rx0 - 2, rx1 + 2]) {           // west and east approaches
      for (let y = ry0; y <= ry1; y++) stripe(dx, y, 2);
    }
    if (register) roundabouts.push({ x: rx0 + 1, y: ry0 + 1 });
  };

  // A roundabout at EVERY avenue intersection: the ring is the only place
  // where traffic changes lanes/directions - straight lanes stay one-way.
  for (const x of vRoads) for (const y of hRoads) {
    const rx0 = x - 1, ry0 = y - 1;
    if (rx0 < 1 || ry0 < 1 || rx0 + 3 >= GRID - 1 || ry0 + 3 >= GRID - 1) continue;
    carveRing(rx0, ry0, false);
  }

  const placeRoundabout = (rx0: number, ry0: number): void => {
    carveRing(rx0, ry0, true);
  };

  const stubCount = 44; // attempts; many fail the clear-area check in dense grids
  for (let i = 0; i < stubCount; i++) {
    const len = rng.int(5, 13);
    if (rng.chance(0.5) && vRoads.length > 0) {
      // horizontal stub off a vertical avenue; stub rows y, y+1
      const ax = rng.pick(vRoads);
      const y = rng.int(8, GRID - 14);
      if (rng.chance(0.5)) { // heading right (east): ring's left column receives the stub
        const rx0 = ax + 2 + len, ry0 = y - 1;
        if (!areaClear(ax + 2, ry0 - 1, rx0 + 4, ry0 + 4)) continue;
        placeRoundabout(rx0, ry0);
        paveRoadH(y, ax + 2, rx0 - 1);
      } else { // heading left (west): ring's right column receives the stub
        const rx1 = ax - 3 - len, rx0 = rx1 - 3, ry0 = y - 1;
        if (!areaClear(rx0 - 1, ry0 - 1, ax - 2, ry0 + 4)) continue;
        placeRoundabout(rx0, ry0);
        paveRoadH(y, rx1 + 1, ax - 2);
      }
    } else if (hRoads.length > 0) {
      // vertical stub off a horizontal avenue; stub cols x, x+1
      const ay = rng.pick(hRoads);
      const x = rng.int(8, GRID - 14);
      if (rng.chance(0.5)) { // heading down (south): ring's top row receives the stub
        const ry0 = ay + 2 + len, rx0 = x - 1;
        if (!areaClear(rx0 - 1, ay + 2, rx0 + 4, ry0 + 4)) continue;
        placeRoundabout(rx0, ry0);
        paveRoadV(x, ay + 2, ry0 - 1);
      } else { // heading up (north): ring's bottom row receives the stub
        const ry1 = ay - 3 - len, ry0 = ry1 - 3, rx0 = x - 1;
        if (!areaClear(rx0 - 1, ry0 - 1, rx0 + 4, ay - 2)) continue;
        placeRoundabout(rx0, ry0);
        paveRoadV(x, ry1 + 1, ay - 2);
      }
    }
  }

  // Where stub roads tee into an avenue, open up turning exits. A straight
  // 2-wide road tile already has 3 road neighbours (ahead, behind, and its
  // parallel lane partner), so a genuine tee needs 4. Ring tiles keep their
  // strict one-way circulation, and exits are decided against a snapshot of
  // the lane field so this pass can never cascade into itself.
  const laneSnap = laneDir.slice();
  for (let y = 1; y < GRID - 1; y++) for (let x = 1; x < GRID - 1; x++) {
    const i = idx(x, y);
    if (tiles[i] !== T_ROAD || ringTiles.has(i)) continue;
    let roadNbrs = 0;
    for (let d = 0; d < 4; d++) if (tiles[idx(x + DX[d], y + DY[d])] === T_ROAD) roadNbrs++;
    if (roadNbrs >= 4) {
      let bits = 0;
      for (let d = 0; d < 4; d++) {
        const ni = idx(x + DX[d], y + DY[d]);
        if (tiles[ni] !== T_ROAD) continue;
        if (ringTiles.has(ni)) continue;                // enter rings only via their lanes
        if (laneSnap[ni] === DBIT[(d + 2) % 4]) continue; // head-on into a one-way lane
        bits |= DBIT[d];
      }
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
      if (x1 - x0 < MIN_LOT - 1 || y1 - y0 < MIN_LOT - 1) continue;
      fillBlock(tiles, height, bstyle, rng, Math.max(1, x0), Math.max(1, y0), Math.min(GRID - 2, x1), Math.min(GRID - 2, y1));
    }
  }

  // ---- 4. Facade decoration: one upper feature and one ground feature per
  // wall face, so signs, billboards, shops and doors never stack ----
  const decos: Deco[] = [];
  const upperTaken = new Set<number>();
  const groundTaken = new Set<number>();
  const openish = (t: number) => t === T_GROUND || t === T_SIDEWALK || t === T_ROAD || t === T_PARK;
  for (let y = 2; y < GRID - 2; y++) {
    for (let x = 2; x < GRID - 2; x++) {
      const i = idx(x, y);
      if (tiles[i] !== T_WALL) continue;
      const hgt = height[i];
      for (let face = 0 as 0 | 1; face <= 1; face = (face + 1) as 0 | 1) {
        const nx = face === 0 ? x : x + 1;
        const ny = face === 0 ? y + 1 : y;
        if (!openish(tiles[idx(nx, ny)])) continue;
        // does this face look onto a street?
        const onStreet = tiles[idx(nx, ny)] === T_SIDEWALK
          || tiles[idx(face === 0 ? x : x + 2, face === 0 ? y + 2 : y)] === T_ROAD;
        const key = i * 2 + face;

        // upper storeys: a big billboard, a videowall, or a neon sign
        if (onStreet && !upperTaken.has(key)) {
          if (hgt >= 3 && rng.chance(0.035)) {
            decos.push({ x, y, face, kind: "billboard", variant: rng.int(0, 7), level: rng.int(1, hgt - 2) });
            upperTaken.add(key);
          } else if (hgt >= 2 && rng.chance(0.06)) {
            decos.push({ x, y, face, kind: rng.chance(0.45) ? "videowall" : "neon", variant: rng.int(0, 7), level: rng.int(1, Math.max(1, hgt - 1)) });
            upperTaken.add(key);
          }
        }
        // street level: a lit shop window, otherwise an entrance
        if (!groundTaken.has(key)) {
          if (onStreet && rng.chance(0.66)) {
            decos.push({ x, y, face, kind: "shopwin", variant: rng.int(0, 23), level: 0 });
            groundTaken.add(key);
          } else if (((x * 3 + y * 5) % 4 === 0) && rng.chance(0.35)) {
            decos.push({ x, y, face, kind: "door", variant: rng.int(0, 3), level: 0 });
            groundTaken.add(key);
          }
        }
      }
    }
  }

  // ---- 4b. Street furniture: trees and benches in parks, food stalls on
  // busy pavements ----
  const props: Prop[] = [];
  for (let y = 1; y < GRID - 1; y++) {
    for (let x = 1; x < GRID - 1; x++) {
      const t = tiles[idx(x, y)];
      if (t === T_PARK) {
        // leave the rim beside a pit clear so the railing stays readable
        let nearPit = false;
        for (let d = 0; d < 4 && !nearPit; d++) if (tiles[idx(x + DX[d], y + DY[d])] === T_PIT) nearPit = true;
        if (nearPit) continue;
        if (rng.chance(0.2)) props.push({ x, y, kind: "tree", variant: rng.int(0, 11) });
        else if (rng.chance(0.05)) props.push({ x, y, kind: "bench", variant: rng.int(0, 1) });
      } else if (t === T_SIDEWALK && rng.chance(0.012)) {
        // a stall needs a road in front of it and room to stand
        let byRoad = false;
        for (let d = 0; d < 4 && !byRoad; d++) if (tiles[idx(x + DX[d], y + DY[d])] === T_ROAD) byRoad = true;
        if (byRoad) props.push({ x, y, kind: "stall", variant: rng.int(0, 3) });
      }
    }
  }

  // ---- 4c. Curbside parking: one or two bays per city block, on pavement
  // that fronts a carriageway ----
  const parking: ParkSpot[] = [];
  const taken = new Set<number>();
  for (let bi = 0; bi < vEdges.length - 1; bi++) {
    for (let bj = 0; bj < hEdges.length - 1; bj++) {
      const bx0 = Math.max(1, vEdges[bi] + 2), bx1 = Math.min(GRID - 2, vEdges[bi + 1] - 1);
      const by0 = Math.max(1, hEdges[bj] + 2), by1 = Math.min(GRID - 2, hEdges[bj + 1] - 1);
      if (bx1 - bx0 < 2 || by1 - by0 < 2) continue;
      const bays: ParkSpot[] = [];
      for (let y = by0; y <= by1; y++) {
        for (let x = bx0; x <= bx1; x++) {
          if (tiles[idx(x, y)] !== T_SIDEWALK) continue;
          const roadEW = tiles[idx(x - 1, y)] === T_ROAD || tiles[idx(x + 1, y)] === T_ROAD;
          const roadNS = tiles[idx(x, y - 1)] === T_ROAD || tiles[idx(x, y + 1)] === T_ROAD;
          if (!roadEW && !roadNS) continue;
          // keep the bay clear of lamps, stalls and crossings
          if (props.some((p) => p.x === x && p.y === y)) continue;
          // stand the car a little back from the kerb so passing traffic clears it
          const BACK = 0.28;
          let px = x + 0.5, py = y + 0.5;
          if (roadEW) px += tiles[idx(x - 1, y)] === T_ROAD ? BACK : -BACK;
          else py += tiles[idx(x, y - 1)] === T_ROAD ? BACK : -BACK;
          bays.push({ x, y, px, py, axis: roadEW ? 1 : 0 });
        }
      }
      if (bays.length === 0) continue;
      rng.shuffle(bays);
      const want = rng.int(1, 2);
      let placed = 0;
      for (const b of bays) {
        if (placed >= want) break;
        // bays need a little breathing room from one another
        let clash = false;
        for (let dy = -2; dy <= 2 && !clash; dy++) for (let dx = -2; dx <= 2; dx++) {
          if (taken.has(idx(b.x + dx, b.y + dy))) { clash = true; break; }
        }
        if (clash) continue;
        taken.add(idx(b.x, b.y));
        parking.push(b);
        placed++;
      }
    }
  }

  // ---- 5. Street lamps on the sidewalk corners around each roundabout ----
  const lamps: { x: number; y: number }[] = [];
  for (const x of vRoads) for (const y of hRoads) {
    for (const [lx, ly] of [[x - 2, y - 2], [x + 3, y - 2], [x - 2, y + 3], [x + 3, y + 3]] as const) {
      if (inGrid(lx, ly) && tiles[idx(lx, ly)] === T_SIDEWALK && rng.chance(0.8)
          && !props.some((p) => p.x === lx && p.y === ly)) lamps.push({ x: lx, y: ly });
    }
  }

  // lamps are sited last, so drop any bay that ended up under a post
  const lampAt = new Set(lamps.map((l) => idx(l.x, l.y)));
  const bays = parking.filter((b) => !lampAt.has(idx(b.x, b.y)));

  // ---- 6. Elevated skytrain lines above a couple of avenues ----
  const skytrains: Skytrain[] = [];
  if (vRoads.length > 2) skytrains.push({ axis: "v", pos: vRoads[rng.int(1, vRoads.length - 2)] });
  if (hRoads.length > 2 && rng.chance(0.75)) skytrains.push({ axis: "h", pos: hRoads[rng.int(1, hRoads.length - 2)] });

  return { seed, tiles, height, bstyle, laneDir, decos, props, parking: bays, crossing, lamps, roundabouts, vRoads, hRoads, skytrains };
}

// Recursively split a block into lots separated by 4-tile alleys, then raise
// buildings with a facade style, or lay out parks and sunken pits.
// Invariant: two buildings are never closer than 4 tiles (alleys are 4 wide,
// and street corridors are curb+road+road+curb = 4 tiles wall to wall).
const MIN_LOT = 3;   // smallest building footprint, walls included
const MAX_LOT = 13;  // a lot larger than this is always subdivided
const ALLEY = 4;     // gap between lots - this is what enforces the invariant

function fillBlock(tiles: Uint8Array, height: Uint8Array, bstyle: Uint8Array, rng: Rng, x0: number, y0: number, x1: number, y1: number): void {
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  if (w < MIN_LOT || h < MIN_LOT) return;

  // Oversized lots are subdivided; anything else is built as-is and simply
  // carved around whatever already occupies part of it (a roundabout corner,
  // a stub road). Carving only ever removes tiles, so buildings can never end
  // up closer together than the 4-tile alleys already guarantee.
  const span = MIN_LOT * 2 + ALLEY;
  const canX = w >= span, canY = h >= span;
  if ((w > MAX_LOT || h > MAX_LOT) && (canX || canY)) {
    // cut near the middle: lopsided cuts leave skinny lots whose 4-tile
    // alleys would swallow most of the block
    const halve = (len: number): number => {
      const mid = Math.floor((len - ALLEY) / 2);
      const jit = Math.floor((len - ALLEY) * 0.18);
      const off = jit > 0 ? rng.int(-jit, jit) : 0;
      return clamp(mid + off, MIN_LOT, len - MIN_LOT - ALLEY);
    };
    if (canX && (w >= h || !canY)) {
      const cut = x0 + halve(w);
      fillBlock(tiles, height, bstyle, rng, x0, y0, cut - 1, y1);
      fillBlock(tiles, height, bstyle, rng, cut + ALLEY, y0, x1, y1);
    } else {
      const cut = y0 + halve(h);
      fillBlock(tiles, height, bstyle, rng, x0, y0, x1, cut - 1);
      fillBlock(tiles, height, bstyle, rng, x0, cut + ALLEY, x1, y1);
    }
    return;
  }

  // how much of the lot survives the carve?
  let free = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (tiles[idx(x, y)] === T_GROUND) free++;
  }
  if (free < 6) return; // barely anything left - leave it as open ground

  // lot: park / sunken pit / building
  if (rng.chance(0.18) && w >= 5 && h >= 5) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (tiles[idx(x, y)] === T_GROUND) tiles[idx(x, y)] = T_PARK;
    }
    // some plazas hold a sunken pit (vent shaft / excavation) with a walkable rim
    if (rng.chance(0.35) && w >= 7 && h >= 7) {
      for (let y = y0 + 2; y <= y1 - 2; y++) for (let x = x0 + 2; x <= x1 - 2; x++) {
        if (tiles[idx(x, y)] === T_PARK) tiles[idx(x, y)] = T_PIT;
      }
    }
    return;
  }

  // facade style: small footprints stay low-rise, big ones can tower
  const small = w <= 5 || h <= 5;
  const stories = small
    ? rng.int(1, 3)
    : (rng.chance(0.1) ? rng.int(5, 7) : rng.int(1, 4));
  let style: number;
  if (stories >= 5) style = rng.chance(0.6) ? S_GLASS : rng.pick([S_CONCRETE, S_COLUMNS, S_COMMERCIAL]);
  else if (stories === 1) style = rng.pick([S_INDUSTRIAL, S_COMMERCIAL, S_CONCRETE]);
  else style = rng.pick([S_CONCRETE, S_INDUSTRIAL, S_COMMERCIAL, S_BALCONY, S_BALCONY, S_COLUMNS]);
  const hue = rng.int(0, 2);
  const packed = (hue << 4) | style;

  // raise the shell on every free tile...
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (tiles[idx(x, y)] !== T_GROUND) continue;
      tiles[idx(x, y)] = T_BUILDING;
      height[idx(x, y)] = stories;
      bstyle[idx(x, y)] = packed;
    }
  }
  // ...then turn anything facing the outside world - including the carved
  // edge - into a perimeter wall
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = idx(x, y);
      if (tiles[i] !== T_BUILDING) continue;
      for (let d = 0; d < 4; d++) {
        const t = tiles[idx(x + DX[d], y + DY[d])];
        if (t !== T_BUILDING && t !== T_WALL) { tiles[i] = T_WALL; break; }
      }
    }
  }
}
