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
// Underground levels are negative storeys. Like TRAIN_LEVEL these are chosen
// to be exact in float32 so a height read back out of the model compares equal.
export const GARAGE_LEVEL = -1;    // parking under the buildings
export const SUBWAY_LEVEL = -2;    // the underground railway and its stations
// The second line has to pass under the first where they cross, so it is bored
// a storey deeper. Two tunnels at one depth would have the trains driving
// through each other at the interchange.
export const SUBWAY_DEEP = -3;
const HALL_LONG = 10;              // a concourse reaches this far along the line
const HALL_WIDE = 5;               // ...and this far either side of the track
// The track sits in a trench below the platforms, which is what stops a
// concourse reading as one flat slab with a train parked on it.
export const TRACK_DROP = 0.375;   // storeys, and exact in a Float32Array
// A ramp gains a storey for every two tiles it runs.
const RAMP_PER_STOREY = 2;
// A skytrain platform: ten tiles along the track and two across it, so a
// waiting squad has somewhere to stand that isn't the track itself.
export const PLATFORM_LONG = 10;
export const PLATFORM_WIDE = 2;
const PLATFORM_HALF = PLATFORM_LONG >> 1;

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
  kind: "videowall" | "neon" | "door" | "billboard" | "shopwin" | "megawall";
  variant: number;           // which ad / sign / door design
  level: number;             // story on the wall (0-based)
}

// A fixture in an underground concourse: the things that make a station read
// as a place rather than a corridor.
// A pedestrian ramp between the street and a metro concourse. `steps` are the
// tiles it descends through, nose to tail, starting at street level.
export interface MetroRamp {
  steps: { x: number; y: number; z: number }[];
  station: number;           // index into City.stations
}

// The way down into a basement garage: the carriageway tile it opens off,
// then the tiles it steps down through to the garage floor. Kept so the
// renderer can cut the trench and hang a portal on the wall it goes under -
// a ramp that works but is not drawn just looks like a car sinking into the
// pavement.
export interface GarageRamp {
  lat: { x: number; y: number };   // unit offset from column A to column B: the ramp is two tiles wide

  steps: { x: number; y: number; z: number }[];   // the mouth first, at z 0
}

export interface Fitting {
  x: number; y: number;
  z: number;
  kind: "ticket" | "shop" | "food" | "bench" | "map" | "column";
  variant: number;
  facing: number;            // 0..3, which way it turns
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
  level: number;             // height the line runs at: elevated, or under the street
}

// A station: a stretch of platform beside the track with a stair down to the
// street. `u` is its distance along the line, matching Skytrain.stops.
export interface Station {
  line: number;              // index into City.skytrains
  u: number;
  x: number; y: number;      // centre of the platform
  level: number;             // the height its platform sits at
}

// One flight of steps joining two surfaces, with the ground it has to work
// with. `run` is how many tiles of footprint it gets along the wall and
// `side` which way the second tile lies; two tiles is what lets a flight
// climb at a walkable pitch instead of nearly vertically.
export interface StairRun {
  x: number; y: number;      // the tile it starts from
  rx: number; ry: number;    // the tile it arrives at
  dx: number; dy: number;    // unit step from the start toward it
  h: number; base: number;
  run: number;
  side: number;              // -1 or +1: where the second tile sits
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
  levels: Levels;            // every standing surface in the sector, and the ways between them
  lamps: { x: number; y: number }[];
  roundabouts: { x: number; y: number }[]; // centers
  ringIslands: { x: number; y: number }[]; // world-space centre of every 4x4 ring's island
  vRoads: number[];          // x of left lane of each vertical avenue
  hRoads: number[];          // y of top lane of each horizontal avenue
  skytrains: Skytrain[];     // elevated rail lines running above avenues
  stations: Station[];       // platforms on those lines, every other block
  fittings: Fitting[];       // what furnishes the underground concourses
  garages: { x: number; y: number; w: number; h: number }[]; // parking floors under buildings
  stairRuns: StairRun[];     // the footprint each flight of steps was given
  ring: Uint16Array;         // 0 off, else the id of the roundabout whose
                             // circulating lane the tile belongs to
  ramps: MetroRamp[];        // the ways down into the metro
  garageRamps: GarageRamp[]; // ...and the ways down into the garages
}

// ---------------------------------------------------------------------------
// Levels: every standing surface in the sector, at any height above or below
// the street, and the ways between them.
//
// A tile no longer has "the ground, and maybe one thing over it". It has a
// list of surfaces - a pavement at 0, a basement at -1, a metro platform at
// -3, a roof at 5 - and links join them where a stair, ladder or shaft
// actually connects two. Heights are in storeys and may be negative.
//
// The storage is flat so the search can run over it without allocating: the
// surfaces of tile i live at [start[i], start[i+1]), and the links leaving
// surface s live at [linkStart[s], linkStart[s+1]).
// ---------------------------------------------------------------------------

export const SURF_GROUND = 0;    // the street itself
export const SURF_ROOF = 1;      // a building's roof
export const SURF_PLATFORM = 2;  // elevated rail platform
export const SURF_TUNNEL = 3;    // metro or sewer floor
export const SURF_BASEMENT = 4;  // under a building

export const LINK_STAIR = 0;     // fire escape, station stair
export const LINK_LADDER = 1;    // manhole, shaft
export const LINK_ESCALATOR = 2;
export const LINK_RAMP = 3;      // a slope a car can take, not just a person

export interface Levels {
  start: Int32Array;        // GRID*GRID + 1 offsets into z/kind/tile
  z: Float32Array;          // surface height in storeys
  kind: Uint8Array;
  tile: Int32Array;         // which tile each surface belongs to
  linkStart: Int32Array;    // surfaceCount + 1 offsets into linkTo
  linkTo: Int32Array;
  linkKind: Uint8Array;
  linkCost: Float32Array;
  count: number;            // total surfaces
}

// Collects surfaces and links while the city is being generated, then packs
// them down into the flat arrays above.
export class LevelBuilder {
  private surf: { tile: number; z: number; kind: number }[] = [];
  private links: { a: number; b: number; kind: number; cost: number }[] = [];

  // add a standing surface, returning the index the links will refer to
  add(tile: number, z: number, kind: number): number {
    this.surf.push({ tile, z, kind });
    return this.surf.length - 1;
  }

  // join two surfaces both ways: anything you can climb up you can climb down
  link(a: number, b: number, kind: number, cost: number): void {
    this.links.push({ a, b, kind, cost });
    this.links.push({ a: b, b: a, kind, cost });
  }

  freeze(cells: number): Levels {
    const n = this.surf.length;
    // sort surfaces by tile so each tile's are contiguous, keeping the old
    // index alive long enough to remap the links onto the new order
    const order = this.surf.map((_, i) => i).sort((p, q) => {
      const d = this.surf[p].tile - this.surf[q].tile;
      return d !== 0 ? d : this.surf[p].z - this.surf[q].z;
    });
    const remap = new Int32Array(n);
    for (let k = 0; k < n; k++) remap[order[k]] = k;

    const start = new Int32Array(cells + 1);
    const z = new Float32Array(n);
    const kind = new Uint8Array(n);
    const tile = new Int32Array(n);
    for (let k = 0; k < n; k++) {
      const s = this.surf[order[k]];
      z[k] = s.z; kind[k] = s.kind; tile[k] = s.tile;
      start[s.tile + 1]++;
    }
    for (let i = 0; i < cells; i++) start[i + 1] += start[i];

    const linkStart = new Int32Array(n + 1);
    for (const l of this.links) linkStart[remap[l.a] + 1]++;
    for (let i = 0; i < n; i++) linkStart[i + 1] += linkStart[i];
    const cursor = linkStart.slice(0, n);
    const linkTo = new Int32Array(this.links.length);
    const linkKind = new Uint8Array(this.links.length);
    const linkCost = new Float32Array(this.links.length);
    for (const l of this.links) {
      const a = remap[l.a];
      const at = cursor[a]++;
      linkTo[at] = remap[l.b];
      linkKind[at] = l.kind;
      linkCost[at] = l.cost;
    }
    return { start, z, kind, tile, linkStart, linkTo, linkKind, linkCost, count: n };
  }
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

// ---- reading the level model -------------------------------------------
// Surfaces are addressed by a single index into City.levels, which is what the
// pathfinder searches over. These helpers are the only way anything else needs
// to look at it.

// the range of surfaces standing on a tile
// Where a line's track runs, measured across the avenue it follows. A skytrain
// viaduct sits over the first lane with its platform on the lane beside it; a
// subway tunnel is bored under the middle of the avenue. Everything that has
// to agree on where a train actually is reads this.
// The walking line up a flight of steps: along one flight to its head, across
// the landing there, back along the next. It has to match what drawFireStair
// paints, or agents walk through the air beside their own staircase.
export function stairWalk(fs: StairRun): { x: number; y: number; z: number }[] {
  const ax = fs.dx, ay = fs.dy;                     // toward the wall it serves
  const ux = -ay, uy = ax;                          // along the wall face
  const cx = fs.x + 0.5, cy = fs.y + 0.5;
  const RUN = fs.run;
  const INSET = 0.05 / RUN, LAND = 0.34 / RUN;
  const uStart = fs.side < 0 ? 0.5 - RUN : -0.5;
  const at = (t: number, v: number, h: number) => ({
    x: cx + ax * (0.5 - v) + ux * (uStart + t * RUN),
    y: cy + ay * (0.5 - v) + uy * (uStart + t * RUN),
    z: fs.base + h,
  });
  const out: { x: number; y: number; z: number }[] = [];
  for (let lvl = 0; lvl < fs.h; lvl++) {
    const top = Math.min(fs.h, lvl + 1);
    const even = lvl % 2 === 0;
    const vMid = even ? 0.275 : 0.725;              // the middle of this flight
    const tFoot = even ? INSET : 1 - INSET;
    const tHead = even ? 1 - INSET - LAND : INSET + LAND;
    const tEnd = tFoot + (tHead - tFoot) * Math.min(1, top - lvl);
    out.push(at(tFoot, vMid, lvl));
    out.push(at(tEnd, vMid, top));
    if (top >= lvl + 1 - 1e-6) {                    // a full flight has a landing
      out.push(at(even ? 1 - INSET - LAND / 2 : INSET + LAND / 2, 0.5, lvl + 1));
    }
  }
  return out;
}

export function trackCentre(line: Skytrain): number {
  return line.level < 0 ? line.pos + 1.5 : line.pos + 0.5;
}

export function tileSurfaces(c: City, x: number, y: number): { from: number; to: number } {
  if (!inGrid(x, y)) return { from: 0, to: 0 };
  const i = idx(x, y);
  return { from: c.levels.start[i], to: c.levels.start[i + 1] };
}

// the surface on this tile nearest a given height, or -1 if the tile has none
export function surfaceNear(c: City, x: number, y: number, z: number, tol = 0.35): number {
  const { from, to } = tileSurfaces(c, x, y);
  let best = -1, bd = tol;
  for (let s = from; s < to; s++) {
    const d = Math.abs(c.levels.z[s] - z);
    if (d <= bd) { bd = d; best = s; }
  }
  return best;
}

// the highest surface on a tile at or below a ceiling - what a tap picks
export function surfaceUnder(c: City, x: number, y: number, ceiling: number): number {
  const { from, to } = tileSurfaces(c, x, y);
  let best = -1;
  for (let s = from; s < to; s++) {
    if (c.levels.z[s] <= ceiling + 0.01 && (best < 0 || c.levels.z[s] > c.levels.z[best])) best = s;
  }
  return best;
}

// is the sector hollowed out at this depth, on this tile? Only surfaces that
// are themselves underground count - the street overhead is not a void.
export function hollowAt(c: City, x: number, y: number, z: number, tol = 0.9): boolean {
  const { from, to } = tileSurfaces(c, x, y);
  for (let s = from; s < to; s++) {
    if (c.levels.z[s] < -0.1 && Math.abs(c.levels.z[s] - z) <= tol) return true;
  }
  return false;
}

export function surfaceZOf(c: City, s: number): number { return c.levels.z[s]; }
export function surfaceKindOf(c: City, s: number): number { return c.levels.kind[s]; }
export function surfaceTileOf(c: City, s: number): number { return c.levels.tile[s]; }
export function surfaceX(c: City, s: number): number { return c.levels.tile[s] % GRID; }
export function surfaceY(c: City, s: number): number { return (c.levels.tile[s] / GRID) | 0; }

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
  const ringIslands: { x: number; y: number }[] = [];
  const ringTiles = new Map<number, number>(); // tile -> roundabout id; ring tiles keep strict one-way circulation
  let nextRingId = 0;
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
    const ringId = ++nextRingId;
    ringIslands.push({ x: rx0 + 2, y: ry0 + 2 });
    const rx1 = rx0 + 3, ry1 = ry0 + 3;
    for (let y = ry0; y <= ry1; y++) for (let x = rx0; x <= rx1; x++) {
      const border = x === rx0 || x === rx1 || y === ry0 || y === ry1;
      tiles[idx(x, y)] = border ? T_ROAD : T_ISLAND;
      laneDir[idx(x, y)] = 0; // wipe whatever the avenues wrote here
      if (border) ringTiles.set(idx(x, y), ringId);
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

  // ---- 2b. Edge turnarounds. An avenue runs clear to the map border, where a
  // car in the outgoing lane would drive off the edge and wreck. Cap each end
  // with a mini-roundabout: a point island (no tile of its own) with road all
  // around it, two by two, that folds the arriving lane back into the departing
  // one so traffic returns toward the centre. The four tiles circulate the same
  // way any roundabout does; the tile that meets the departing avenue lane also
  // carries that lane's direction - the exit a car takes going straight out of
  // the loop. All four tiles are already paved road, so this only rewires who
  // may leave each one.
  const edgeTurn = (x0: number, y0: number, exitX: number, exitY: number, exitDir: number): void => {
    const cells: [number, number, number][] = [
      [x0, y0, D_S], [x0 + 1, y0, D_W], [x0, y0 + 1, D_E], [x0 + 1, y0 + 1, D_N],
    ];
    for (const [cx, cy] of cells) if (!inGrid(cx, cy) || tiles[idx(cx, cy)] !== T_ROAD) return;
    const ringId = ++nextRingId;
    for (const [cx, cy, d] of cells) { laneDir[idx(cx, cy)] = d; ringTiles.set(idx(cx, cy), ringId); }
    laneDir[idx(exitX, exitY)] |= exitDir;
  };
  for (const x of vRoads) {
    edgeTurn(x, 0, x, 1, D_S);                       // top: peel off down the southbound lane
    edgeTurn(x, GRID - 2, x + 1, GRID - 2, D_N);     // bottom: peel off up the northbound lane
  }
  for (const y of hRoads) {
    edgeTurn(0, y, 1, y + 1, D_E);                   // left: peel off east along the eastbound lane
    edgeTurn(GRID - 2, y, GRID - 2, y, D_W);         // right: peel off west along the westbound lane
  }

  const placeRoundabout = (rx0: number, ry0: number): void => {
    carveRing(rx0, ry0, true);
  };

  // Zebra across the mouth of a stub where it meets an avenue, so the tee
  // reads as a junction rather than a road that happens to touch another.
  const markMouth = (sx: number, sy: number, axis: number): void => {
    for (const [ox, oy] of axis === 1 ? [[0, 0], [1, 0]] : [[0, 0], [0, 1]]) {
      const i = idx(sx + ox, sy + oy);
      if (inGrid(sx + ox, sy + oy) && tiles[i] === T_ROAD) crossing[i] = axis;
    }
  };

  // A stub runs from an avenue out to a roundabout of its own. It has to reach
  // the avenue's carriageway to be any use: stopping on the kerb leaves the
  // stub and its roundabout an island, unreachable by any car in the sector.
  // The clear-area test therefore starts beyond the kerb the stub will pave
  // over, rather than on it - which it could never pass.
  const stubCount = 44; // attempts; many fail the clear-area check in dense grids
  for (let i = 0; i < stubCount; i++) {
    const len = rng.int(5, 13);
    if (rng.chance(0.5) && vRoads.length > 0) {
      // horizontal stub off a vertical avenue; stub rows y, y+1
      const ax = rng.pick(vRoads);
      const y = rng.int(8, GRID - 14);
      if (rng.chance(0.5)) { // heading right (east): ring's left column receives the stub
        const rx0 = ax + 2 + len, ry0 = y - 1;
        if (!areaClear(ax + 3, ry0 - 1, rx0 + 4, ry0 + 4)) continue;
        placeRoundabout(rx0, ry0);
        paveRoadH(y, ax + 2, rx0 - 1);      // ax+2 is the avenue's east kerb
        markMouth(ax + 3, y, 2);
      } else { // heading left (west): ring's right column receives the stub
        const rx1 = ax - 3 - len, rx0 = rx1 - 3, ry0 = y - 1;
        if (!areaClear(rx0 - 1, ry0 - 1, ax - 2, ry0 + 4)) continue;
        placeRoundabout(rx0, ry0);
        paveRoadH(y, rx1 + 1, ax - 1);      // ax-1 is the avenue's west kerb
        markMouth(ax - 2, y, 2);
      }
    } else if (hRoads.length > 0) {
      // vertical stub off a horizontal avenue; stub cols x, x+1
      const ay = rng.pick(hRoads);
      const x = rng.int(8, GRID - 14);
      if (rng.chance(0.5)) { // heading down (south): ring's top row receives the stub
        const ry0 = ay + 2 + len, rx0 = x - 1;
        if (!areaClear(rx0 - 1, ay + 3, rx0 + 4, ry0 + 4)) continue;
        placeRoundabout(rx0, ry0);
        paveRoadV(x, ay + 2, ry0 - 1);
        markMouth(x, ay + 3, 1);
      } else { // heading up (north): ring's bottom row receives the stub
        const ry1 = ay - 3 - len, ry0 = ry1 - 3, rx0 = x - 1;
        if (!areaClear(rx0 - 1, ry0 - 1, rx0 + 4, ay - 2)) continue;
        placeRoundabout(rx0, ry0);
        paveRoadV(x, ry1 + 1, ay - 1);
        markMouth(x, ay - 2, 1);
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
          if (hgt >= 5 && rng.chance(0.012)) {
            // an advertisement wall wants three clear storeys and is rare
            // enough that meeting one is an event
            decos.push({ x, y, face, kind: "megawall", variant: rng.int(0, 5), level: rng.int(1, hgt - 3) });
            upperTaken.add(key);
          } else if (hgt >= 3 && rng.chance(0.035)) {
            decos.push({ x, y, face, kind: "billboard", variant: rng.int(0, 31), level: rng.int(1, hgt - 2) });
            upperTaken.add(key);
          } else if (hgt >= 2 && rng.chance(0.06)) {
            decos.push({ x, y, face, kind: rng.chance(0.45) ? "videowall" : "neon", variant: rng.int(0, 31), level: rng.int(1, Math.max(1, hgt - 1)) });
            upperTaken.add(key);
          }
        }
        // street level: a lit shop window, otherwise an entrance
        if (!groundTaken.has(key)) {
          if (onStreet && rng.chance(0.66)) {
            decos.push({ x, y, face, kind: "shopwin", variant: rng.int(0, 95), level: 0 });
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
  if (vRoads.length > 2) skytrains.push({ axis: "v", pos: vRoads[rng.int(1, vRoads.length - 2)], stops: [], level: TRAIN_LEVEL });
  if (hRoads.length > 2 && rng.chance(0.75)) skytrains.push({ axis: "h", pos: hRoads[rng.int(1, hRoads.length - 2)], stops: [], level: TRAIN_LEVEL });
  // the subway runs under an avenue the elevated line does not already have
  {
    const takenV = new Set(skytrains.filter((l) => l.axis === "v").map((l) => l.pos));
    const freeV = vRoads.filter((x) => !takenV.has(x) && x > 8 && x < GRID - 9);
    if (freeV.length > 0) skytrains.push({ axis: "v", pos: rng.pick(freeV), stops: [], level: SUBWAY_LEVEL });
    // The metro always runs two lines that cross: one of anything is a shuttle,
    // not a network. Where every horizontal avenue already carries a skytrain
    // the subway shares one - the viaduct is above the street and the tunnel
    // well under it, so they never meet.
    const takenH = new Set(skytrains.filter((l) => l.axis === "h").map((l) => l.pos));
    const inBounds = hRoads.filter((y) => y > 8 && y < GRID - 9);
    const freeH = inBounds.filter((y) => !takenH.has(y));
    const pickH = freeH.length > 0 ? freeH : inBounds;
    if (pickH.length > 0) skytrains.push({ axis: "h", pos: rng.pick(pickH), stops: [], level: SUBWAY_DEEP });
  }

  // ---- 6b. Stations every other block, with a platform over the avenue and
  // a stair up from the pavement ----
  const stations: Station[] = [];
  for (let li = 0; li < skytrains.length; li++) {
    const line = skytrains[li];
    if (line.level < 0) continue;              // the subway lays its own out below
    const cross = line.axis === "v" ? hRoads : vRoads;
    for (let k = 0; k < cross.length; k += 2) {
      const u = cross[k] + 1;                       // centred on the cross avenue
      if (u < PLATFORM_HALF + 2 || u > GRID - PLATFORM_HALF - 3) continue;
      const cx = line.axis === "v" ? line.pos + 1 : u;
      const cy = line.axis === "v" ? u : line.pos + 1;
      // the platform itself: a slab of deck alongside the track, never over it
      for (let d = -PLATFORM_HALF; d < PLATFORM_HALF; d++) {
        for (let e = 0; e < PLATFORM_WIDE; e++) {
          const px2 = line.axis === "v" ? cx + e : cx + d;
          const py2 = line.axis === "v" ? cy + d : cy + e;
          if (!inGrid(px2, py2)) continue;
          const pt = tiles[idx(px2, py2)];
          if (pt === T_BUILDING || pt === T_WALL) continue;   // never re-roof a block
          structZ[idx(px2, py2)] = TRAIN_LEVEL;
        }
      }
      // and a stair up to it from the nearest clear pavement
      // Which way is "across the track" depends on the line's axis, so work in
      // along/across and only convert to x/y at the end.
      const acrossBase = line.axis === "v" ? cx : cy;
      const alongBase = line.axis === "v" ? cy : cx;
      let stair = -1;
      for (let r = 1; r <= 6 && stair < 0; r++) {
        for (let d = -PLATFORM_HALF; d < PLATFORM_HALF && stair < 0; d++) {
          for (const sgn of [1, -1]) {
            // step off the platform's own edge, not off its centre
            const edge = sgn > 0 ? acrossBase + PLATFORM_WIDE - 1 : acrossBase;
            const gAcross = edge + sgn * r, gAlong = alongBase + d;
            const gx = line.axis === "v" ? gAcross : gAlong;
            const gy = line.axis === "v" ? gAlong : gAcross;
            if (!inGrid(gx, gy)) continue;
            const gi = idx(gx, gy);
            const t = tiles[gi];
            if ((t !== T_GROUND && t !== T_SIDEWALK) || streetUsed[gi] || stairTo[gi] >= 0) continue;
            // climb to whichever platform tile is on the same side
            const tx = line.axis === "v" ? edge : gAlong;
            const ty = line.axis === "v" ? gAlong : edge;
            if (!inGrid(tx, ty) || structZ[idx(tx, ty)] !== TRAIN_LEVEL) continue;
            stairTo[gi] = idx(tx, ty);
            stair = gi;
            break;
          }
        }
      }
      line.stops.push(u);
      const acx = line.axis === "v" ? cx + PLATFORM_WIDE / 2 : cx;
      const acy = line.axis === "v" ? cy : cy + PLATFORM_WIDE / 2;
      stations.push({ line: li, u, x: acx, y: acy, level: line.level });
    }
  }

  // ---- 7. Pack every standing surface, and the ways between them, into the
  // level model the pathfinder and the renderer both read ----
  const lb = new LevelBuilder();
  const groundSurf = new Int32Array(GRID * GRID).fill(-1);
  const aboveSurf = new Int32Array(GRID * GRID).fill(-1);
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const i = idx(x, y);
      const t = tiles[i];
      if (t === T_GROUND || t === T_SIDEWALK || t === T_ROAD || t === T_PARK || t === T_ISLAND) {
        groundSurf[i] = lb.add(i, 0, SURF_GROUND);
      }
      if (structZ[i] > 0) {
        const roof = t === T_BUILDING || t === T_WALL;
        aboveSurf[i] = lb.add(i, structZ[i], roof ? SURF_ROOF : SURF_PLATFORM);
      }
    }
  }
  // stairs and station steps become links between the two surfaces they join
  for (let i = 0; i < GRID * GRID; i++) {
    const to = stairTo[i];
    if (to < 0) continue;
    const a = groundSurf[i], b = aboveSurf[to];
    if (a < 0 || b < 0) continue;
    lb.link(a, b, LINK_STAIR, 1 + structZ[to] * 1.5);
  }
  // ---- 7b. Parking under the buildings, at one storey down. A garage fills
  // the footprint of the building over it and meets the street through a ramp
  // cut down from the carriageway. ----
  const fittings: Fitting[] = [];
  const ramps: MetroRamp[] = [];
  const garageRamps: GarageRamp[] = [];
  const garages: { x: number; y: number; w: number; h: number }[] = [];
  // Underground floors stack: a garage at -1, the first line's tunnel at -2 and
  // the second's at -3 can all pass through the same tile. Key the lookup by
  // the storey the floor sits on, not by the tile alone, or the deeper line
  // finds the tile taken and leaves a hole in its tunnel.
  const underSurf = new Map<number, number>();          // tile+storey -> surface
  const uk = (tile: number, z: number) => tile * 8 + Math.round(-z);
  {
    const seen = new Uint8Array(GRID * GRID);
    for (let y = 2; y < GRID - 2; y++) {
      for (let x = 2; x < GRID - 2; x++) {
        const i = idx(x, y);
        if (seen[i] || tiles[i] !== T_BUILDING) continue;
        // take the whole lot
        const lot: number[] = [i];
        seen[i] = 1;
        let x0 = x, x1 = x, y0 = y, y1 = y;
        for (let k = 0; k < lot.length; k++) {
          const j = lot[k];
          const jx = j % GRID, jy = (j / GRID) | 0;
          x0 = Math.min(x0, jx); x1 = Math.max(x1, jx);
          y0 = Math.min(y0, jy); y1 = Math.max(y1, jy);
          for (let d = 0; d < 4; d++) {
            const nx = jx + DX[d], ny = jy + DY[d];
            if (!inGrid(nx, ny)) continue;
            const n = idx(nx, ny);
            if (!seen[n] && (tiles[n] === T_BUILDING || tiles[n] === T_WALL)) { seen[n] = 1; if (tiles[n] === T_BUILDING) lot.push(n); }
          }
        }
        // only worth digging under a lot with room for cars in it
        const w = x1 - x0 + 1, h = y1 - y0 + 1;
        if (lot.length < 12 || w < 3 || h < 3 || !rng.chance(0.4)) continue;

        // The ramp leaves the carriageway at right angles to it and runs
        // straight into the block. A slip road cutting across the traffic on
        // the diagonal is not how a garage entrance is built, and the dog-leg
        // it used to take put a kink in the middle of the trench.
        const lotSet = new Set(lot);
        const rampable = (t: number) =>
          tiles[t] === T_SIDEWALK || tiles[t] === T_GROUND
          || tiles[t] === T_PARK || tiles[t] === T_WALL || lotSet.has(t);
        let mouth = -1, run: number[] | null = null, lat: [number, number] | null = null, best = 1e9;
        for (let ry = y0 - 5; ry <= y1 + 5 && best > 0; ry++) {
          for (let rx2 = x0 - 5; rx2 <= x1 + 5 && best > 0; rx2++) {
            if (!inGrid(rx2, ry) || tiles[idx(rx2, ry)] !== T_ROAD) continue;
            // which way the carriageway runs here; at a corner it runs both,
            // and the ramp may leave on either of the two perpendiculars
            const roadX = (inGrid(rx2 - 1, ry) && tiles[idx(rx2 - 1, ry)] === T_ROAD)
                       || (inGrid(rx2 + 1, ry) && tiles[idx(rx2 + 1, ry)] === T_ROAD);
            const roadY = (inGrid(rx2, ry - 1) && tiles[idx(rx2, ry - 1)] === T_ROAD)
                       || (inGrid(rx2, ry + 1) && tiles[idx(rx2, ry + 1)] === T_ROAD);
            const dirs: [number, number][] = [];
            if (roadX) dirs.push([0, 1], [0, -1]);
            if (roadY) dirs.push([1, 0], [-1, 0]);
            for (const [dx, dy] of dirs) {
              const steps: number[] = [];
              let cx = rx2, cy = ry, reached = false, clear = true;
              for (let k = 0; k < 5; k++) {
                cx += dx; cy += dy;
                if (!inGrid(cx, cy)) break;
                const t = idx(cx, cy);
                if (!rampable(t)) break;
                steps.push(t);
                if (streetUsed[t]) clear = false;
                if (lotSet.has(t)) { reached = true; break; }
              }
              // three tiles is the shortest run that keeps every step under
              // half a storey, which is the difference between a ramp and a drop
              if (!reached || steps.length < 3) continue;
              // A garage ramp is two tiles wide, so a candidate only stands if
              // a parallel column works beside it: its own road mouth, every
              // step rampable, and the last one on the garage floor too.
              const zebraAt = (mx2: number, my2: number): boolean => {
                const bx2 = -dy, by2 = dx;          // along the carriageway
                return crossing[idx(mx2, my2)] !== 0
                  || (inGrid(mx2 + bx2, my2 + by2) && crossing[idx(mx2 + bx2, my2 + by2)] !== 0)
                  || (inGrid(mx2 - bx2, my2 - by2) && crossing[idx(mx2 - bx2, my2 - by2)] !== 0);
              };
              let latPick: [number, number] | null = null;
              for (const [lx, ly] of [[-dy, dx], [dy, -dx]] as [number, number][]) {
                const mbx = rx2 + lx, mby = ry + ly;
                if (!inGrid(mbx, mby) || tiles[idx(mbx, mby)] !== T_ROAD) continue;
                if (groundSurf[idx(mbx, mby)] < 0 || zebraAt(mbx, mby)) continue;
                let ok = true;
                for (let k = 0; k < steps.length; k++) {
                  const bx3 = steps[k] % GRID + lx, by3 = ((steps[k] / GRID) | 0) + ly;
                  if (!inGrid(bx3, by3) || !rampable(idx(bx3, by3))) { ok = false; break; }
                  if (streetUsed[idx(bx3, by3)]) clear = false;
                  if (k === steps.length - 1 && !lotSet.has(idx(bx3, by3))) ok = false;
                }
                if (ok) { latPick = [lx, ly]; break; }
              }
              if (!latPick) continue;
              // Never open a garage onto a pedestrian crossing. The zebra runs
              // across the carriageway, so a mouth on one - or on the tile
              // either side of it along the road - would have cars turning off
              // the ramp straight through people on foot.
              if (zebraAt(rx2, ry)) continue;
              // The portal ends up on the face the run enters the building
              // through, and only two of the four ever face the camera, so it
              // is worth walking along the block to find one that does.
              const facing = dx < 0 || dy < 0;
              const score = (facing ? 0 : 16) + (steps.length > 4 ? 2 : 0) + (clear ? 0 : 1);
              if (score < best) { best = score; mouth = idx(rx2, ry); run = steps; lat = latPick; }
            }
          }
        }
        if (mouth < 0 || run === null || lat === null || groundSurf[mouth] < 0) continue;

        for (const j of lot) underSurf.set(uk(j, GARAGE_LEVEL), lb.add(j, GARAGE_LEVEL, SURF_BASEMENT));
        garages.push({ x: x0, y: y0, w, h });

        // The ramp proper: a run of tiles stepping down from the carriageway to
        // the garage floor, one surface each, joined end to end. A single link
        // straight from the road to the basement is something a person can take
        // and a car cannot - there is nothing under the car on the way down.
        const mx = mouth % GRID, my = (mouth / GRID) | 0;
        const [lx, ly] = lat;
        // both columns of the two-tile-wide ramp, chained down in step; the
        // columns also sit side by side at every depth, so the level-aware
        // searches connect them by adjacency and a car may use either lane
        let prevA = groundSurf[mouth];
        let prevB = groundSurf[idx(mx + lx, my + ly)];
        const steps = [{ x: mx, y: my, z: 0 }];
        for (let k = 0; k < run.length; k++) {
          const last = k === run.length - 1;
          // eighths of a storey keep every height exact in a Float32Array
          const z = last ? GARAGE_LEVEL : -Math.round((8 * (k + 1)) / run.length) / 8;
          const bTile = idx(run[k] % GRID + lx, ((run[k] / GRID) | 0) + ly);
          const hereA = last ? underSurf.get(uk(run[k], GARAGE_LEVEL))! : lb.add(run[k], z, SURF_BASEMENT);
          const hereB = last ? underSurf.get(uk(bTile, GARAGE_LEVEL))! : lb.add(bTile, z, SURF_BASEMENT);
          lb.link(prevA, hereA, LINK_RAMP, 1.4);
          lb.link(prevB, hereB, LINK_RAMP, 1.4);
          prevA = hereA; prevB = hereB;
          steps.push({ x: run[k] % GRID, y: (run[k] / GRID) | 0, z });
          streetUsed[run[k]] = 1;                  // nothing else stands in the trench
          streetUsed[bTile] = 1;
        }
        garageRamps.push({ steps, lat: { x: lx, y: ly } });
      }
    }
  }

  // ---- 7c. The subway, two storeys down: running tunnel the length of the
  // line, opening every few blocks into a concourse with a ticket hall, shops
  // and places to eat, and stairs up to the pavement. ----
  for (let li = 0; li < skytrains.length; li++) {
    const line = skytrains[li];
    if (line.level >= 0) continue;
    const along = line.axis === "v" ? { x: 0, y: 1 } : { x: 1, y: 0 };
    const across = line.axis === "v" ? { x: 1, y: 0 } : { x: 0, y: 1 };
    const trackU = line.pos + 1;                    // the tunnel follows the avenue
    const at = (u: number, v: number) => {
      const x = line.axis === "v" ? trackU + v : u;
      const y = line.axis === "v" ? u : trackU + v;
      return inGrid(x, y) ? idx(x, y) : -1;
    };
    // the running tunnel, in its trench
    const FLOOR_Z = line.level;
    const TRACK_Z = FLOOR_Z - TRACK_DROP;
    for (let u = 5; u < GRID - 5; u++) {
      const t = at(u, 0);
      if (t >= 0 && !underSurf.has(uk(t, TRACK_Z))) underSurf.set(uk(t, TRACK_Z), lb.add(t, TRACK_Z, SURF_TUNNEL));
    }
    // concourses on every other cross avenue
    const cross = line.axis === "v" ? hRoads : vRoads;
    for (let k = 0; k < cross.length; k += 2) {
      const u = cross[k] + 1;
      if (u < HALL_LONG + 6 || u > GRID - HALL_LONG - 7) continue;
      // the concourse floor stands a third of a storey above the track it
      // serves, so the trench reads as a trench
      for (let du = -HALL_LONG; du <= HALL_LONG; du++) {
        for (let dv = -HALL_WIDE; dv <= HALL_WIDE; dv++) {
          const t = at(u + du, dv);
          if (t < 0 || underSurf.has(uk(t, FLOOR_Z))) continue;
          const fz = dv === 0 ? TRACK_Z : FLOOR_Z;
          underSurf.set(uk(t, fz), lb.add(t, fz, SURF_TUNNEL));
        }
      }
      // fit it out: ticket hall at one end, a parade of shops and food along
      // the far wall, benches and a map where passengers wait
      const hx = line.axis === "v" ? trackU : u;
      const hy = line.axis === "v" ? u : trackU;
      const put = (du: number, dv: number, kind: Fitting["kind"], variant: number) => {
        const fx = hx + along.x * du + across.x * dv;
        const fy = hy + along.y * du + across.y * dv;
        if (inGrid(fx, fy) && underSurf.has(uk(idx(fx, fy), FLOOR_Z))) {
          fittings.push({ x: fx, y: fy, z: FLOOR_Z, kind, variant, facing: dv < 0 ? 0 : 2 });
        }
      };
      // A hall this size needs furnishing along its whole length, or it reads
      // as a car park with a train in it: ticket halls at one end, parades of
      // shops down both far walls, and columns marching the length of it.
      for (const dv of [-HALL_WIDE, HALL_WIDE]) {
        put(-HALL_LONG + 1, dv, "ticket", rng.int(0, 1));
        put(-HALL_LONG + 2, dv, "ticket", rng.int(0, 1));
        for (let du = -HALL_LONG + 4; du <= HALL_LONG - 1; du += 2) {
          put(du, dv, rng.chance(0.5) ? "shop" : "food", rng.int(0, 3));
        }
      }
      for (let du = -HALL_LONG + 2; du <= HALL_LONG - 2; du += 4) {
        put(du, HALL_WIDE - 1, "bench", 0);
        put(du + 2, -HALL_WIDE + 1, "bench", 0);
      }
      put(HALL_LONG - 1, HALL_WIDE - 1, "map", 0);
      put(-HALL_LONG + 1, -HALL_WIDE + 1, "map", 0);
      for (let du = -HALL_LONG + 2; du <= HALL_LONG - 2; du += 3) {
        put(du, -HALL_WIDE + 2, "column", 0);
        put(du, HALL_WIDE - 2, "column", 0);
      }
      line.stops.push(u);
      const stationIdx = stations.length;
      stations.push({ line: li, u, x: hx + 0.5, y: hy + 0.5, level: FLOOR_Z });

      // Ramps down from the pavement, one at each end of the concourse. A ramp
      // gains a storey every two tiles, so reaching a platform two storeys down
      // takes four - laid straight along the kerb where there is room for it,
      // folded into an L or a U where there is not.
      const RUN = RAMP_PER_STOREY * Math.round(-FLOOR_Z);
      const tileAt = (du: number, dv: number) => {
        const x = line.axis === "v" ? trackU + dv : u + du;
        const y = line.axis === "v" ? u + du : trackU + dv;
        return inGrid(x, y) ? { x, y, i: idx(x, y) } : null;
      };
      const openStreet = (t: { i: number } | null) =>
        t !== null && (tiles[t.i] === T_SIDEWALK || tiles[t.i] === T_GROUND)
        && !streetUsed[t.i] && stairTo[t.i] < 0 && groundSurf[t.i] >= 0;
      // Shapes, as offsets from the mouth going inward, all RUN tiles long:
      // straight, then the two L bends, then a U that doubles back. The deeper
      // line needs a longer run for the extra storey, so they are laid out from
      // RUN rather than written out.
      const shapes = (sgn: number, side: number): [number, number][][] => {
        const a = sgn, b = side, half = Math.ceil(RUN / 2);
        const straight: [number, number][] = [];
        const bendLate: [number, number][] = [];
        const bendEarly: [number, number][] = [];
        const u_turn: [number, number][] = [];
        for (let k = 1; k <= RUN; k++) straight.push([a * k, 0]);
        for (let k = 1; k <= half; k++) bendLate.push([a * k, 0]);
        for (let k = 1; k <= RUN - half; k++) bendLate.push([a * half, -b * k]);
        bendEarly.push([a, 0], [a, -b]);
        for (let k = 2; k <= RUN - 1; k++) bendEarly.push([a * k, -b]);
        u_turn.push([a, 0]);
        for (let k = 1; k <= RUN - 2; k++) u_turn.push([a, -b * k]);
        u_turn.push([0, -b * (RUN - 2)]);
        return [straight, bendLate, bendEarly, u_turn];
      };
      // The track splits the concourse in two, and the only way across it is
      // along the rails. So the platforms are served one side at a time: a
      // ramp for the left-hand kerb and a ramp for the right-hand one, each
      // taking whichever end of the hall it can get. A platform whose only
      // exit is on the far side of the line is not an exit.
      for (const side of [-2, 1]) {                      // the two kerbs
        const away = side > 0 ? -1 : 1;                  // bends turn away from the track
        let done = false;
        for (const sgn of [1, -1]) {                     // try each far end in turn
          if (done) break;
          for (const reach of [HALL_LONG + 2, HALL_LONG + 1, HALL_LONG + 3]) {
            const mouthDu = sgn * reach;
            const mouth = tileAt(mouthDu, side);
            if (!openStreet(mouth)) continue;
            let chosen: { x: number; y: number; z: number }[] | null = null;
            for (const shape of shapes(-sgn, away)) {
              const steps: { x: number; y: number; z: number }[] = [{ x: mouth!.x, y: mouth!.y, z: 0 }];
              let ok = true;
              for (let k = 0; k < shape.length; k++) {
                const dv = side + shape[k][1];
                // never step onto the track, nor cross to the other platform
                if (dv === 0 || (dv < 0) !== (side < 0)) { ok = false; break; }
                const t = tileAt(mouthDu + shape[k][0], dv);
                if (t === null) { ok = false; break; }
                const last = k === shape.length - 1;
                // eighths of a storey, so every height is exact in float32
                const z = last ? FLOOR_Z
                  : -Math.round((8 * (k + 1) * -FLOOR_Z) / RUN) / 8;
                if (last && !underSurf.has(uk(t.i, FLOOR_Z))) { ok = false; break; }  // must land on the concourse
                steps.push({ x: t.x, y: t.y, z });
              }
              if (ok) { chosen = steps; break; }
            }
            if (!chosen) continue;
            let prev = groundSurf[mouth!.i];
            for (let k = 1; k < chosen.length; k++) {
              const t = idx(chosen[k].x, chosen[k].y);
              const last = k === chosen.length - 1;
              const here = last ? underSurf.get(uk(t, FLOOR_Z))! : lb.add(t, chosen[k].z, SURF_TUNNEL);
              lb.link(prev, here, LINK_ESCALATOR, 1.6);
              prev = here;
            }
            streetUsed[mouth!.i] = 1;
            ramps.push({ steps: chosen, station: stationIdx });
            done = true;
            break;                                        // one per side is enough
          }
        }
      }
    }
  }

  const ring = new Uint16Array(GRID * GRID);
  for (const [i, id] of ringTiles) ring[i] = id;

  const levels = lb.freeze(GRID * GRID);

  // ---- 7d. Give every flight of steps a two-tile footprint along the wall.
  // A flight squeezed into one tile has to climb a whole storey in about two
  // thirds of a tile, which draws as a ladder rather than a stair. Where a
  // lamp post or a street tree stands in the way it is moved aside: the stair
  // has to be there, the tree only wants to be. ----
  const stairRuns = layOutStairs(levels, tiles, props, lamps, streetUsed);

  return { seed, tiles, height, bstyle, laneDir, decos, props, crossing, streetUsed, levels, fittings, garages, lamps, roundabouts, ringIslands, vRoads, hRoads, skytrains, stations, stairRuns, ring, ramps, garageRamps };
}

// Every stair in the level model gets two tiles of footprint along the wall it
// is bolted to, so its flights can climb at a walkable pitch. The second tile
// comes from whichever side of the foot is standable; where street furniture
// stands there, the furniture moves.
function layOutStairs(
  levels: Levels, tiles: Uint8Array, props: Prop[],
  lamps: { x: number; y: number }[], streetUsed: Uint8Array
): StairRun[] {
  const runs: StairRun[] = [];
  // what a lamp or a tree is standing on, so it can be found and moved
  const furniture = new Map<number, { move: (x: number, y: number) => void }>();
  for (const pr of props) furniture.set(idx(pr.x, pr.y), { move: (x, y) => { pr.x = x; pr.y = y; } });
  for (const l of lamps) furniture.set(idx(l.x, l.y), { move: (x, y) => { l.x = x; l.y = y; } });
  // reserve every stair's own foot before anything moves, so a lamp shifted
  // out of one flight's way cannot land under another's
  const claimed = new Set<number>();
  for (let a = 0; a < levels.count; a++) {
    for (let e = levels.linkStart[a]; e < levels.linkStart[a + 1]; e++) {
      if (levels.linkKind[e] !== LINK_STAIR) continue;
      if (levels.z[levels.linkTo[e]] > levels.z[a]) claimed.add(levels.tile[a]);
    }
  }

  const standable = (x: number, y: number, base: number): boolean => {
    if (!inGrid(x, y)) return false;
    if (base < -0.1) return hollowFrom(levels, x, y, base);
    const t = tiles[idx(x, y)];
    return t === T_GROUND || t === T_SIDEWALK;
  };

  for (let a = 0; a < levels.count; a++) {
    for (let e = levels.linkStart[a]; e < levels.linkStart[a + 1]; e++) {
      if (levels.linkKind[e] !== LINK_STAIR) continue;  // ramps are not staircases
      const b = levels.linkTo[e];
      if (levels.z[b] <= levels.z[a]) continue;        // take each pair once, going up
      const x = levels.tile[a] % GRID, y = (levels.tile[a] / GRID) | 0;
      const rx = levels.tile[b] % GRID, ry = (levels.tile[b] / GRID) | 0;
      // a garage ramp may reach several tiles for its road mouth, so take a
      // single step toward the far end rather than the whole offset
      const ox = rx - x, oy = ry - y;
      let dx = Math.abs(ox) >= Math.abs(oy) ? Math.sign(ox) : 0;
      let dy = dx === 0 ? Math.sign(oy) : 0;
      const base = levels.z[a];
      if (dx === 0 && dy === 0) {
        // a subway entrance can sit directly over its own landing, leaving no
        // direction to read off the two ends. Face it into the concourse: the
        // first way that has both a tile ahead and a tile beside it to build on
        for (let d = 0; d < 4; d++) {
          const fx = DX[d], fy = DY[d];
          if (!standable(x + fx, y + fy, base)) continue;
          if (!standable(x - fy, y + fx, base) && !standable(x + fy, y - fx, base)) continue;
          dx = fx; dy = fy; break;
        }
      }
      const ux = -dy, uy = dx;                          // along the wall face

      // score each side: free ground beats ground with a lamp on it, and a
      // tile another stair already claimed is no use at all
      let best = 0, bestScore = -1;
      for (const side of [1, -1]) {
        const sx = x + ux * side, sy = y + uy * side;
        if (!standable(sx, sy, base)) continue;
        const i = idx(sx, sy);
        if (claimed.has(i)) continue;
        const score = furniture.has(i) ? 1 : 2;
        // break ties by tile so the choice is stable but not always the same way
        if (score > bestScore || (score === bestScore && (x * 7 + y * 13) % 2 === 0 && side === 1)) {
          bestScore = score; best = side;
        }
      }
      if (best === 0) continue;                         // hemmed in on both sides

      const ex = x + ux * best, ey = y + uy * best, ei = idx(ex, ey);
      claimed.add(ei);
      const sitting = furniture.get(ei);
      if (sitting !== undefined) {
        // shift the lamp or tree to the nearest tile of its own kind of ground
        let moved = false;
        for (let r = 1; r <= 3 && !moved; r++) {
          for (let oy2 = -r; oy2 <= r && !moved; oy2++) {
            for (let ox2 = -r; ox2 <= r && !moved; ox2++) {
              if (Math.max(Math.abs(ox2), Math.abs(oy2)) !== r) continue;
              const nx = ex + ox2, ny = ey + oy2;
              if (!inGrid(nx, ny)) continue;
              const ni = idx(nx, ny);
              const t = tiles[ni];
              if (t !== T_GROUND && t !== T_SIDEWALK) continue;
              if (streetUsed[ni] || claimed.has(ni) || furniture.has(ni)) continue;
              sitting.move(nx, ny);
              furniture.delete(ei);
              furniture.set(ni, sitting);
              streetUsed[ni] = 1;
              streetUsed[ei] = 0;
              moved = true;
            }
          }
        }
        if (!moved) {
          // nowhere within reach: the stair wins, the decoration goes
          const pi = props.findIndex((pr) => idx(pr.x, pr.y) === ei);
          if (pi >= 0) props.splice(pi, 1);
          const li = lamps.findIndex((l) => idx(l.x, l.y) === ei);
          if (li >= 0) lamps.splice(li, 1);
          furniture.delete(ei);
          streetUsed[ei] = 0;
        }
      }

      runs.push({ x, y, rx, ry, dx, dy, h: levels.z[b] - base, base, run: 2, side: best });
    }
  }
  return runs;
}

// hollowAt works off a City; during generation only the level model exists yet
function hollowFrom(levels: Levels, x: number, y: number, z: number): boolean {
  const i = idx(x, y);
  for (let s = levels.start[i]; s < levels.start[i + 1]; s++) {
    if (levels.z[s] < -0.1 && Math.abs(levels.z[s] - z) <= 0.9) return true;
  }
  return false;
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
