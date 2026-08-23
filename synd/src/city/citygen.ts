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
export const T_PIT = 7;

// The elevated deck, in storeys. 2.125 is exact in float32, so a height read
// back out of City.structZ compares equal to it - which 64/30 would not.
export const TRAIN_LEVEL = 2.125;
const PLATFORM_HALF = 2;              // platform reaches this far each way      // sunken excavation/vent shaft (blocks movement, not bullets)

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

export interface Prop {
  x: number; y: number;      // tile the prop stands on
  kind: "tree" | "bench" | "stall";
  variant: number;
}

export interface Skytrain {
  axis: "v" | "h";
  pos: number;               // x (axis v) or y (axis h) of the left/top lane tile
  stops: number[];           // distance along the line of each station, in order
}

// A station: a stretch of platform beside the track with a stair down to the
// street. `u` is its distance along the line, matching Skytrain.stops.
export interface Station {
  line: number;              // index into City.skytrains
  u: number;
  x: number; y: number;      // centre of the platform
}

export interface City {
  seed: number;
  tiles: Uint8Array;
  height: Uint8Array;        // stories, for WALL/BUILDING tiles
  bstyle: Uint8Array;        // low nibble: facade style, high nibble: hue variant
  laneDir: Uint8Array;       // bitmask of allowed exits for cars
  decos: Deco[];
  props: Prop[];             // trees, benches, food stalls
  crossing: Uint8Array;      // 0 none, 1 stripes along y, 2 stripes along x
  streetUsed: Uint8Array;    // 1 where a prop or a lamp already stands
  stairTo: Int32Array;       // fire stairs: index of the roof tile this ground tile climbs to, else -1
  structZ: Float32Array;     // height of the walkable surface above a tile (roof/platform), 0 = none
  lamps: { x: number; y: number }[];
  roundabouts: { x: number; y: number }[]; // centers
  vRoads: number[];          // x of left lane of each vertical avenue
  hRoads: number[];          // y of top lane of each horizontal avenue
  skytrains: Skytrain[];     // elevated rail lines running above avenues
  stations: Station[];       // platforms on those lines, every other block
}

export function idx(x: number, y: number): number { return y * GRID + x; }
export function inGrid(x: number, y: number): boolean { return x >= 0 && y >= 0 && x < GRID && y < GRID; }

export function isWalkable(c: City, x: number, y: number): boolean {
  if (!inGrid(x, y)) return false;
  const t = c.tiles[idx(x, y)];
  return t === T_GROUND || t === T_SIDEWALK || t === T_ROAD || t === T_PARK || t === T_ISLAND;
}
// Any pavement tile fronting a carriageway is a legal kerbside berth, so long
// as no street furniture stands on it. The car itself sits a little back from
// the edge so passing traffic clears it.
export interface Kerb { x: number; y: number; px: number; py: number; axis: 0 | 1 }
export function kerbAt(c: City, x: number, y: number): Kerb | null {
  if (!inGrid(x, y)) return null;
  const i = idx(x, y);
  if (c.tiles[i] !== T_SIDEWALK || c.streetUsed[i]) return null;
  const BACK = 0.28;
  const w = isRoad(c, x - 1, y), e = isRoad(c, x + 1, y);
  if (w || e) return { x, y, px: x + 0.5 + (w ? BACK : -BACK), py: y + 0.5, axis: 1 };
  const n = isRoad(c, x, y - 1), s = isRoad(c, x, y + 1);
  if (n || s) return { x, y, px: x + 0.5, py: y + 0.5 + (n ? BACK : -BACK), axis: 0 };
  return null;
}

// A tile carries at most two standing surfaces: the ground, and whatever roof
// or platform is above it. Slot 0 is the street, slot 1 the structure.
export function surfaceZ(c: City, x: number, y: number, slot: number): number {
  if (slot === 0) return 0;
  return inGrid(x, y) ? c.structZ[idx(x, y)] : 0;
}
export function walkableAt(c: City, x: number, y: number, slot: number): boolean {
  if (!inGrid(x, y)) return false;
  if (slot === 0) return isWalkable(c, x, y);
  return c.structZ[idx(x, y)] > 0;
}
// a ground tile with a stair on it reaches the roof of the tile it returns
export function stairRoof(c: City, x: number, y: number): number {
  return inGrid(x, y) ? c.stairTo[idx(x, y)] : -1;
}

// street furniture already claims some pavement; a stair may not share it
function streetUsedAt(props: Prop[], lamps: { x: number; y: number }[], x: number, y: number): boolean {
  for (const p of props) if (p.x === x && p.y === y) return true;
  for (const l of lamps) if (l.x === x && l.y === y) return true;
  return false;
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

  // ---- 5. Street lamps on the sidewalk corners around each roundabout ----
  const lamps: { x: number; y: number }[] = [];
  for (const x of vRoads) for (const y of hRoads) {
    for (const [lx, ly] of [[x - 2, y - 2], [x + 3, y - 2], [x - 2, y + 3], [x + 3, y + 3]] as const) {
      if (inGrid(lx, ly) && tiles[idx(lx, ly)] === T_SIDEWALK && rng.chance(0.8)
          && !props.some((p) => p.x === lx && p.y === ly)) lamps.push({ x: lx, y: ly });
    }
  }

  // ---- 5b. Fire stairs: a run of external steps up the flank of some
  // buildings, so agents can reach the roof ----
  const stairTo = new Int32Array(GRID * GRID).fill(-1);
  const structZ = new Float32Array(GRID * GRID);
  {
    // every building's roof is a surface; only some get a way up to it
    for (let i = 0; i < GRID * GRID; i++) {
      if (tiles[i] === T_BUILDING || tiles[i] === T_WALL) structZ[i] = height[i];
    }
    const seen = new Uint8Array(GRID * GRID);
    for (let y = 1; y < GRID - 1; y++) {
      for (let x = 1; x < GRID - 1; x++) {
        const i = idx(x, y);
        if (seen[i] || (tiles[i] !== T_WALL && tiles[i] !== T_BUILDING)) continue;
        // flood the building, collecting the wall tiles that front open ground
        const stack = [i];
        seen[i] = 1;
        const faces: { ground: number; wall: number }[] = [];
        let stories = height[i];
        while (stack.length > 0) {
          const j = stack.pop()!;
          const jx = j % GRID, jy = (j / GRID) | 0;
          stories = Math.max(stories, height[j]);
          for (let d = 0; d < 4; d++) {
            const nx = jx + DX[d], ny = jy + DY[d];
            if (!inGrid(nx, ny)) continue;
            const n = idx(nx, ny);
            const t = tiles[n];
            if (t === T_WALL || t === T_BUILDING) {
              if (!seen[n]) { seen[n] = 1; stack.push(n); }
            } else if (tiles[j] === T_WALL && (t === T_GROUND || t === T_SIDEWALK) && !streetUsedAt(props, lamps, nx, ny)) {
              faces.push({ ground: n, wall: j });
            }
          }
        }
        // a stair is worth having only where there is a climb to make
        if (stories < 2 || faces.length === 0 || !rng.chance(0.45)) continue;
        const f = faces[rng.int(0, faces.length - 1)];
        stairTo[f.ground] = f.wall;
      }
    }
  }

  // whatever the street furniture ended up occupying, so nothing else - a
  // parked car, say - tries to stand in the same place
  const streetUsed = new Uint8Array(GRID * GRID);
  for (const p of props) streetUsed[idx(p.x, p.y)] = 1;
  for (const l of lamps) streetUsed[idx(l.x, l.y)] = 1;

  // ---- 6. Elevated skytrain lines above a couple of avenues ----
  const skytrains: Skytrain[] = [];
  if (vRoads.length > 2) skytrains.push({ axis: "v", pos: vRoads[rng.int(1, vRoads.length - 2)], stops: [] });
  if (hRoads.length > 2 && rng.chance(0.75)) skytrains.push({ axis: "h", pos: hRoads[rng.int(1, hRoads.length - 2)], stops: [] });

  // ---- 6b. Stations every other block, with a platform over the avenue and
  // a stair up from the pavement ----
  const stations: Station[] = [];
  for (let li = 0; li < skytrains.length; li++) {
    const line = skytrains[li];
    const cross = line.axis === "v" ? hRoads : vRoads;
    for (let k = 0; k < cross.length; k += 2) {
      const u = cross[k] + 1;                       // centred on the cross avenue
      if (u < PLATFORM_HALF + 2 || u > GRID - PLATFORM_HALF - 3) continue;
      const cx = line.axis === "v" ? line.pos + 1 : u;
      const cy = line.axis === "v" ? u : line.pos + 1;
      // the platform itself: a run of deck alongside the track
      for (let d = -PLATFORM_HALF; d <= PLATFORM_HALF; d++) {
        const px2 = line.axis === "v" ? cx : cx + d;
        const py2 = line.axis === "v" ? cy + d : cy;
        if (!inGrid(px2, py2)) continue;
        structZ[idx(px2, py2)] = TRAIN_LEVEL;
      }
      // and a stair up to it from the nearest clear pavement
      let stair = -1;
      for (let r = 2; r <= 4 && stair < 0; r++) {
        for (let d = -PLATFORM_HALF; d <= PLATFORM_HALF && stair < 0; d++) {
          for (const sgn of [-1, 1]) {
            const gx = line.axis === "v" ? cx + sgn * r : cx + d;
            const gy = line.axis === "v" ? cy + d : cy + sgn * r;
            if (!inGrid(gx, gy)) continue;
            const gi = idx(gx, gy);
            const t = tiles[gi];
            if ((t !== T_GROUND && t !== T_SIDEWALK) || streetUsed[gi] || stairTo[gi] >= 0) continue;
            // climb to the nearest platform tile
            const tx = line.axis === "v" ? cx : gx;
            const ty = line.axis === "v" ? gy : cy;
            if (!inGrid(tx, ty) || structZ[idx(tx, ty)] !== TRAIN_LEVEL) continue;
            stairTo[gi] = idx(tx, ty);
            stair = gi;
            break;
          }
        }
      }
      line.stops.push(u);
      stations.push({ line: li, u, x: cx + 0.5, y: cy + 0.5 });
    }
  }

  return { seed, tiles, height, bstyle, laneDir, decos, props, crossing, streetUsed, stairTo, structZ, lamps, roundabouts, vRoads, hRoads, skytrains, stations };
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
