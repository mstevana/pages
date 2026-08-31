// Isometric world renderer: diagonal-row painter's algorithm so tall building
// blocks correctly occlude people and cars behind them. Also draws the static
// street furniture (fences, doors, pit rails) and the elevated skytrain.

import { City, D_S, D_W, Deco, Fitting, GARAGE_LEVEL, idx, inGrid, isRoad, MetroRamp, PLATFORM_LONG, PLATFORM_WIDE, Prop, StairRun, surfaceUnder, T_BUILDING, T_GROUND, T_ISLAND, T_PARK, T_PIT, T_ROAD, T_SIDEWALK, T_WALL, TRACK_DROP, trackCentre, TRAIN_LEVEL } from "../city/citygen";
import { GRID, STORY_H, TILE_H, TILE_W, ctx2d, isNight, isRain, isoX, isoY, makeCanvas } from "../engine/util";
import { PeopleAtlas, FW, FH } from "../sprites/people";
import { BENCH_H, BENCH_W, STALL_H, STALL_W, TREE_H, TREE_W } from "../sprites/props";
import { CAR_MODELS } from "../sprites/cars";
import { TileArt } from "../sprites/tiles";
import { BOARD_FLASH, Car, Ped, TRAIN_CARS, TRAIN_HALF, TRAIN_SEG, World } from "../game/world";
import { ITEMS } from "../game/items";
import { ICON_SIZE, itemIcons } from "../sprites/icons";

export interface Camera {
  x: number; y: number; // tile coords at viewport center
  zoom: number;
}

const TRAIN_ELEV = TRAIN_LEVEL * STORY_H;   // px above ground at zoom 1
const SECTION_LIP = 5;   // px of wall left standing above a sectioned floor
const PED_SCALE = 1.2;   // people vs the 30px story: roughly one story tall

// One tile of station platform. Split per tile because a ten-tile slab drawn
// as a single entity lands in one depth bucket, and then a train alongside it
// sorts in front of the whole thing or behind the whole thing.
interface PlatTile {
  x: number; y: number;
  axis: "v" | "h";
  du: number;      // 0..PLATFORM_LONG-1 along the track
  dv: number;      // 0 track side, PLATFORM_WIDE-1 outer edge
  level: number;
}

interface Entity {
  s: number;    // depth key = tx + ty
  pri: number;  // within-bucket order: 0 elevated structure, 1 ground, 2 trains
  kind: "ped" | "car" | "drop" | "lamp" | "fence" | "pylon" | "deck" | "train" | "prop" | "stair" | "platform" | "fitting" | "metro" | "gramp" | "holo";
  gramp?: RampPart;
  fitting?: Fitting;
  stair?: StairRun;
  plat?: PlatTile;
  ramp?: MetroRamp;
  ped?: Ped;
  car?: Car;
  drop?: { x: number; y: number; item: { type: string } };
  fence?: FenceEdge;
  train?: TrainSeg;
  prop?: Prop;
  deckAxis?: "v" | "h";
  x: number; y: number;
}

// One tile of a garage ramp. A tile out in the open is cut open as a trench;
// the tile where the ramp goes under the building instead gets a portal
// painted on the face it enters through.
interface RampPart {
  x: number; y: number;
  dx: number; dy: number;      // the way down
  zNear: number; zFar: number; // storeys, at the near and far edge of the tile
  portal: boolean;             // the tile the run goes under the building at
  inside: boolean;             // past that, and only ever seen from below
  vMid: number;                // ramps are two tiles wide: the pair's centre, in
                               // v units off this column (+-0.5 to the second)
}

interface FenceEdge {
  x: number; y: number;
  edge: 0 | 1 | 2 | 3;   // 0 NW, 1 NE, 2 SE, 3 SW (tile edge)
  hazard: boolean;       // yellow pit railing vs park fence
}

interface TrainSeg { wx: number; wy: number; angle: number; head: boolean; lift: number; flash: number; flashOk: boolean; }

interface DeckTile { x: number; y: number; axis: "v" | "h"; pylon: boolean; }

export class Renderer {
  private decoIndex = new Map<number, Deco[]>();
  private fences: FenceEdge[] = [];
  private decks: DeckTile[] = [];
  // how many whole buildings the last frame sliced open to keep the squad in
  // view - zero whenever nothing is actually hidden behind one
  cutawayCount = 0;
  readonly carModels = CAR_MODELS;   // exposed so tests can measure the chassis
  private buildingId: Int32Array; // connected-component label per WALL/BUILDING tile
  readonly maxStories: number;    // ceiling of the tallest building in the sector
  readonly minLevel: number;      // floor of the deepest surface under the street
  private stairs: StairRun[] = [];
  private platforms: PlatTile[] = [];
  // Smoke puffs are the most numerous particle on screen and a burning wreck
  // makes a column of them. Building a radial gradient per puff per frame is
  // what makes a row of wrecks crawl, so the ramp is baked once into a sprite
  // and blitted; two tones cover fresh soot and dispersing grey.
  private puffs: HTMLCanvasElement[] | null = null;
  private puffSprite(i: number): HTMLCanvasElement {
    if (!this.puffs) {
      this.puffs = [[14, 14, 18], [44, 44, 50]].map(([r, gg, b]) => {
        const c = makeCanvas(64, 64);
        const q = ctx2d(c);
        const gr = q.createRadialGradient(32, 32, 0, 32, 32, 32);
        gr.addColorStop(0, `rgba(${r},${gg},${b},1)`);
        gr.addColorStop(0.55, `rgba(${r},${gg},${b},0.55)`);
        gr.addColorStop(1, `rgba(${r},${gg},${b},0)`);
        q.fillStyle = gr;
        q.fillRect(0, 0, 64, 64);
        return c;
      });
    }
    return this.puffs[i];
  }

  rampParts: RampPart[] = [];      // exposed so tests can find the trenches
  private trench = new Set<number>();   // ramp tiles that are open to the sky
  private rampBelow = false;            // the plane is under the street this frame
  // the cut plane in force this frame, for pieces drawn away from the block pass
  private secOn = false;
  private secAt = 0;
  // emissive sources gathered while drawing, blended additively later
  private lampGlows: { x: number; y: number; gy: number; phase: number }[] = [];
  private emissives: { x: number; y: number; r: number; col: [number, number, number]; i: number }[] = [];
  private frameTime = 0;
  rainDrops: { x: number; y: number; v: number }[] = [];

  constructor(private city: City) {
    // label each building so the cutaway can hide a whole structure at once
    const bid = new Int32Array(GRID * GRID).fill(-1);
    const t = city.tiles;
    const stack: number[] = [];
    let nextId = 0;
    for (let i = 0; i < GRID * GRID; i++) {
      if (bid[i] !== -1 || (t[i] !== T_WALL && t[i] !== T_BUILDING)) continue;
      bid[i] = nextId;
      stack.push(i);
      while (stack.length > 0) {
        const j = stack.pop()!;
        const jx = j % GRID, jy = (j / GRID) | 0;
        for (const [nx, ny] of [[jx - 1, jy], [jx + 1, jy], [jx, jy - 1], [jx, jy + 1]]) {
          if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
          const n = ny * GRID + nx;
          if (bid[n] === -1 && (t[n] === T_WALL || t[n] === T_BUILDING)) {
            bid[n] = nextId;
            stack.push(n);
          }
        }
      }
      nextId++;
    }
    this.buildingId = bid;
    // the section slider runs from the ground plane to this
    let top = 1;
    for (let i = 0; i < city.height.length; i++) {
      if ((t[i] === T_WALL || t[i] === T_BUILDING) && city.height[i] > top) top = city.height[i];
    }
    this.maxStories = top;
    // however deep the sector goes, the section slider must be able to reach it
    let low = 0;
    for (let s2 = 0; s2 < city.levels.count; s2++) if (city.levels.z[s2] < low) low = city.levels.z[s2];
    this.minLevel = Math.floor(low);
    this.buildStairs();

    for (const d of city.decos) {
      const k = idx(d.x, d.y);
      let arr = this.decoIndex.get(k);
      if (!arr) { arr = []; this.decoIndex.set(k, arr); }
      arr.push(d);
    }
    this.buildFences();
    this.buildDecks();
    this.buildPlatforms();
    this.buildGarageRamps();
  }

  private buildFences(): void {
    const t = this.city.tiles;
    const walkOpen = (x: number, y: number) => {
      if (!inGrid(x, y)) return false;
      const v = t[idx(x, y)];
      return v === T_SIDEWALK || v === T_GROUND || v === T_ROAD;
    };
    for (let y = 1; y < GRID - 1; y++) {
      for (let x = 1; x < GRID - 1; x++) {
        const v = t[idx(x, y)];
        if (v === T_PIT) {
          // hazard railing wherever the pit borders walkable ground
          const nbr: [number, number, 0 | 1 | 2 | 3][] = [[x - 1, y, 0], [x, y - 1, 1], [x + 1, y, 2], [x, y + 1, 3]];
          for (const [nx, ny, edge] of nbr) {
            if (t[idx(nx, ny)] !== T_PIT) this.fences.push({ x, y, edge, hazard: true });
          }
        } else if (v === T_PARK) {
          // some parks get street-side fences, with gaps for gates
          if (((x * 13 + y * 29) & 7) === 0) continue; // gate gap
          if (((x >> 3) * 31 + (y >> 3) * 17) % 3 === 0) continue; // unfenced lot-ish region
          if (walkOpen(x, y + 1) && t[idx(x, y + 1)] === T_SIDEWALK) this.fences.push({ x, y, edge: 3, hazard: false });
          if (walkOpen(x + 1, y) && t[idx(x + 1, y)] === T_SIDEWALK) this.fences.push({ x, y, edge: 2, hazard: false });
        }
      }
    }
  }

  // A garage ramp out in the open is a hole in the street, not a room under
  // it: whatever is part-way down one is still in plain sight, and hiding it
  // with the rest of the basement is what made a car look like it sank
  // through the pavement.
  private inTrench(x: number, y: number, z: number, sectioned: boolean, section: number): boolean {
    if (z <= -1 || z >= -0.01) return false;
    if (sectioned && section < 0) return false;
    return this.trench.has(idx(Math.floor(x), Math.floor(y)));
  }

  private buildStairs(): void {
    this.stairs = this.city.stairRuns;
  }

  // A ramp is trenched tile by tile until it reaches the building it serves;
  // that tile gets the portal and the rest of the run is inside, out of sight.
  private buildGarageRamps(): void {
    for (const r of this.city.garageRamps) {
      let under = false;
      for (let k = 1; k < r.steps.length; k++) {
        const a = r.steps[k - 1], b = r.steps[k];
        const t = this.city.tiles[idx(b.x, b.y)];
        const solid = t === T_WALL || t === T_BUILDING;
        const dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y);
        // the second column sits at v = +-1 in this column's frame; drawing is
        // centred between the pair so one part paints the whole wide trench
        const vB = -r.lat.x * dy + r.lat.y * dx;
        // The run carries on under the building after the portal. Those tiles
        // are behind a wall from the street, but at the plane that shows the
        // garage they are the part that reaches the floor, and leaving them
        // out stopped the ramp a tile short of it.
        this.rampParts.push({
          x: b.x, y: b.y, dx, dy,
          zNear: a.z, zFar: b.z, portal: solid && !under, inside: under,
          vMid: vB / 2,
        });
        if (!solid) { this.trench.add(idx(b.x, b.y)); this.trench.add(idx(b.x + r.lat.x, b.y + r.lat.y)); }
        if (solid) under = true;
      }
    }
  }

  private buildPlatforms(): void {
    for (const st of this.city.stations) {
      if (st.level < 0) continue;                 // concourses draw with the sublevel
      const line = this.city.skytrains[st.line];
      const acrossBase = line.pos + 1;            // the track itself is at line.pos
      for (let du = 0; du < PLATFORM_LONG; du++) {
        for (let dv = 0; dv < PLATFORM_WIDE; dv++) {
          const a = st.u - (PLATFORM_LONG >> 1) + du;
          const x = line.axis === "v" ? acrossBase + dv : a;
          const y = line.axis === "v" ? a : acrossBase + dv;
          if (!inGrid(x, y)) continue;
          this.platforms.push({ x, y, axis: line.axis, du, dv, level: st.level });
        }
      }
    }
  }

  private buildDecks(): void {
    for (const line of this.city.skytrains) {
      if (line.level < 0) continue;               // a subway needs no viaduct
      if (line.axis === "v") {
        for (let y = 1; y < GRID - 1; y++) {
          this.decks.push({ x: line.pos, y, axis: "v", pylon: y % 5 === 2 });
        }
      } else {
        for (let x = 1; x < GRID - 1; x++) {
          this.decks.push({ x, y: line.pos, axis: "h", pylon: x % 5 === 2 });
        }
      }
    }
  }

  // Light a vehicle up to acknowledge an order to board it. Every panel a
  // vehicle draws goes through its own `quad`, so collecting those paths gives
  // the exact silhouette to brighten - no second body model to keep in step.
  private flashOver(g: CanvasRenderingContext2D, path: Path2D | null, flash: number, ok: boolean): void {
    if (!path || flash <= 0) return;
    // full brightness the instant it is tapped, easing off from there: a
    // pulsing envelope reads as a flicker over so short a life
    const f = Math.min(1, flash / BOARD_FLASH);
    g.save();
    g.globalCompositeOperation = "lighter";
    g.globalAlpha = Math.pow(f, 0.75) * 0.6;
    g.fillStyle = ok ? "#7fc8ff" : "#ff6a55";
    g.fill(path);
    g.restore();
  }

  private glow(x: number, y: number, r: number, hex: string, intensity: number): void {
    if (intensity <= 0.01 || this.emissives.length > 160) return;
    const n = parseInt(hex.slice(1), 16);
    this.emissives.push({ x, y, r, col: [(n >> 16) & 255, (n >> 8) & 255, n & 255], i: intensity });
  }

  draw(
    g: CanvasRenderingContext2D,
    world: World,
    art: TileArt,
    people: PeopleAtlas,
    cam: Camera,
    vx: number, vy: number, vw: number, vh: number,
    time: number,
    section: number = Infinity
  ): void {
    const z = cam.zoom;
    const cx = vx + vw / 2, cy = vy + vh / 2;
    const camPX = isoX(cam.x, cam.y), camPY = isoY(cam.x, cam.y);
    const SX = (tx: number, ty: number) => cx + (isoX(tx, ty) - camPX) * z;
    const SY = (tx: number, ty: number) => cy + (isoY(tx, ty) - camPY) * z;

    this.lampGlows.length = 0;
    this.emissives.length = 0;
    this.frameTime = time;
    g.save();
    g.beginPath();
    g.rect(vx, vy, vw, vh);
    g.clip();
    g.fillStyle = isNight(art.weather) ? "#040508" : "#101216";
    g.fillRect(vx, vy, vw, vh);
    g.imageSmoothingEnabled = false;

    // A section plane below the tallest roof slices the city open; at or above
    // it the city stands whole and nothing is cut.
    const sectioned = section < this.maxStories;
    this.secOn = sectioned; this.secAt = section;

    // visible tile bounds (margin for tall buildings + elevated track)
    const maxRise = 8 * STORY_H * z;
    const corners = [
      [vx, vy], [vx + vw, vy], [vx, vy + vh + maxRise], [vx + vw, vy + vh + maxRise],
    ];
    let txMin = 1e9, txMax = -1e9, tyMin = 1e9, tyMax = -1e9;
    for (const [px, py] of corners) {
      const wx = (px - cx) / z + camPX, wy = (py - cy) / z + camPY;
      const tx = wx / TILE_W + wy / TILE_H, ty = wy / TILE_H - wx / TILE_W;
      txMin = Math.min(txMin, tx); txMax = Math.max(txMax, tx);
      tyMin = Math.min(tyMin, ty); tyMax = Math.max(tyMax, ty);
    }
    const x0 = Math.max(0, Math.floor(txMin) - 3), x1 = Math.min(GRID - 1, Math.ceil(txMax) + 3);
    const y0 = Math.max(0, Math.floor(tyMin) - 12), y1 = Math.min(GRID - 1, Math.ceil(tyMax) + 3);

    const tiles = this.city.tiles, hArr = this.city.height, lane = this.city.laneDir, styleArr = this.city.bstyle;
    const tw = TILE_W * z, th = TILE_H * z;

    // ---- pass 1: flat ground + pits ----
    // With the plane under the street the ground itself is gone: what is left
    // is the cut through the earth, and the floor of anything hollowed out of
    // it that the plane has reached.
    if (sectioned && section < 0) {
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const sx = SX(tx, ty) - tw / 2;
          const floor = surfaceUnder(this.city, tx, ty, section);
          const fz = floor >= 0 ? this.city.levels.z[floor] : section;
          const sy = SY(tx, ty) - fz * STORY_H * z;
          if (sx > vx + vw || sx + tw < vx || sy > vy + vh || sy + th < vy) continue;
          g.fillStyle = floor >= 0 ? art.cutFloor : "#000";   // hollow, or solid earth
          g.beginPath();
          g.moveTo(sx + tw / 2, sy);
          g.lineTo(sx + tw, sy + th / 2);
          g.lineTo(sx + tw / 2, sy + th);
          g.lineTo(sx, sy + th / 2);
          g.closePath();
          g.fill();
          if (floor < 0) continue;
          // Where a hollow meets the earth, stand a wall up from the floor, so
          // a garage or a concourse reads as a room instead of a stain.
          const fzz = this.city.levels.z[floor];
          for (const [dx2, dy2, near] of [[-1, 0, false], [0, -1, false], [1, 0, true], [0, 1, true]] as const) {
            const nb = surfaceUnder(this.city, tx + dx2, ty + dy2, section);
            const nbz = nb >= 0 ? this.city.levels.z[nb] : -99;
            if (nb >= 0 && Math.abs(nbz - fzz) < 0.01) continue;
            if (nb >= 0 && nbz > fzz) continue;         // the neighbour walls its own side
            // against earth a wall stands a fixed height; against a lower floor
            // it stands exactly as tall as the step down to it, which is what
            // makes a track trench read as a trench
            const wallH = nb >= 0 ? (fzz - nbz) * STORY_H * z : 9 * z;
            // The four edges of the diamond, each shared with the neighbour it
            // faces: -x is the upper left one, not the lower left. Putting the
            // wall on the wrong edge shifts every panel one corner round, and
            // a straight boundary comes out as a sawtooth.
            const top: [number, number] = [sx + tw / 2, sy];
            const right: [number, number] = [sx + tw, sy + th / 2];
            const bottom: [number, number] = [sx + tw / 2, sy + th];
            const left: [number, number] = [sx, sy + th / 2];
            const a1 = dx2 === -1 ? left : dy2 === -1 ? top : dx2 === 1 ? right : bottom;
            const a2 = dx2 === -1 ? top : dy2 === -1 ? right : dx2 === 1 ? bottom : left;
            g.fillStyle = near ? "#20242c" : "#161a20";
            g.beginPath();
            g.moveTo(a1[0], a1[1]);
            g.lineTo(a2[0], a2[1]);
            g.lineTo(a2[0], a2[1] - wallH);
            g.lineTo(a1[0], a1[1] - wallH);
            g.closePath();
            g.fill();
          }
        }
      }
    }
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (sectioned && section < 0) break;      // the street is above the plane
        const t = tiles[idx(tx, ty)];
        if (t === T_WALL || t === T_BUILDING) continue;
        const sx = SX(tx, ty) - tw / 2, sy = SY(tx, ty);
        if (sx > vx + vw || sx + tw < vx || sy > vy + vh || sy + th + 12 * z < vy) continue;
        if (t === T_PIT) {
          const ph = th + 10 * z;
          g.drawImage(art.pitFloor, sx, sy, tw, ph);
          if (tiles[idx(tx - 1, ty)] !== T_PIT) g.drawImage(art.pitWallNW, sx, sy, tw, ph);
          if (tiles[idx(tx, ty - 1)] !== T_PIT) g.drawImage(art.pitWallNE, sx, sy, tw, ph);
          continue;
        }
        let img: HTMLCanvasElement;
        switch (t) {
          case T_ROAD: {
            const cross = this.city.crossing[idx(tx, ty)];
            const bits = lane[idx(tx, ty)];
            if (cross === 1) img = art.crossV;
            else if (cross === 2) img = art.crossH;
            else if (isRain(art.weather) && ((tx * 7 + ty * 13) % 11 === 0)) img = art.roadPuddle;
            // a roundabout's circulating lane is a junction, not a carriageway:
            // no centre-line dashes, or the ring reads as a straight avenue
            else if (this.city.ring[idx(tx, ty)] !== 0) img = art.road;
            else if (bits === D_S) img = art.roadDashV;
            else if (bits === D_W) img = art.roadDashH;
            else img = art.road;
            break;
          }
          case T_SIDEWALK: img = art.sidewalk; break;
          case T_PARK: img = art.park; break;
          // the island is painted as a round disc after the tile pass; its
          // tiles carry the circulating lane's own surface underneath
          case T_ISLAND: img = art.road; break;
          default: img = art.ground;
        }
        g.drawImage(img, sx, sy, tw, th);
      }
    }

    // ---- round islands: a circle in world space is an axis-aligned ellipse
    // on screen (rx:ry = TILE_W:TILE_H), so each 2x2 island is repainted as a
    // kerbed disc, with a circular lane guide around it - which is what makes
    // the whole junction read as round even though the tiles are square.
    if (!(sectioned && section < 0)) {
      const ex = (r: number) => r * Math.SQRT2 * (TILE_W / 2) * z;
      const ey = (r: number) => r * Math.SQRT2 * (TILE_H / 2) * z;
      for (const ri of this.city.ringIslands) {
        if (ri.x < x0 - 2 || ri.x > x1 + 2 || ri.y < y0 - 2 || ri.y > y1 + 2) continue;
        const sx = SX(ri.x, ri.y), sy = SY(ri.x, ri.y);
        // circular lane guide through the middle of the circulating lane
        g.strokeStyle = art.night ? "rgba(200,190,140,0.28)" : "rgba(230,220,160,0.4)";
        g.lineWidth = Math.max(1, 0.9 * z);
        g.setLineDash([5 * z, 4 * z]);
        g.beginPath(); g.ellipse(sx, sy, ex(1.5), ey(1.5), 0, 0, Math.PI * 2); g.stroke();
        g.setLineDash([]);
        // the island: kerb ring, paved disc, and an inner ring of trim
        g.fillStyle = art.night ? "#3a3f47" : "#565c66";
        g.beginPath(); g.ellipse(sx, sy, ex(1.0), ey(1.0), 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = art.night ? "#23262d" : "#3b3f47";
        g.beginPath(); g.ellipse(sx, sy, ex(0.88), ey(0.88), 0, 0, Math.PI * 2); g.fill();
        g.strokeStyle = art.night ? "#4c525c" : "#6e747e";
        g.lineWidth = Math.max(1, 0.6 * z);
        g.beginPath(); g.ellipse(sx, sy, ex(0.55), ey(0.55), 0, 0, Math.PI * 2); g.stroke();
      }
    }

    // ---- road apron: past the border each avenue fades off the map, so the
    // grid does not read as a hard rectangular cut and the turnaround loops sit
    // on a road that looks like it carries on out of the sector. Purely
    // cosmetic - no tile, no lane - and only at street level.
    if (!(sectioned && section < 0)) {
      const APRON = 5;
      const strip = (bx: number, by: number, dx: number, dy: number, img: HTMLCanvasElement) => {
        for (let k = 1; k <= APRON; k++) {
          const sx = SX(bx + dx * k, by + dy * k) - tw / 2, sy = SY(bx + dx * k, by + dy * k);
          if (sx > vx + vw || sx + tw < vx || sy > vy + vh || sy + th < vy) continue;
          g.globalAlpha = 0.75 * (1 - (k - 0.5) / APRON);
          g.drawImage(img, sx, sy, tw, th);
        }
        g.globalAlpha = 1;
      };
      for (const rx of this.city.vRoads) {
        strip(rx, 0, 0, -1, art.roadDashV);       strip(rx + 1, 0, 0, -1, art.road);        // over the top
        strip(rx, GRID - 1, 0, 1, art.roadDashV); strip(rx + 1, GRID - 1, 0, 1, art.road);   // under the bottom
      }
      for (const ry of this.city.hRoads) {
        strip(0, ry, -1, 0, art.roadDashH);        strip(0, ry + 1, -1, 0, art.road);        // past the left
        strip(GRID - 1, ry, 1, 0, art.roadDashH);  strip(GRID - 1, ry + 1, 1, 0, art.road);  // past the right
      }
    }

    // ---- collect entities bucketed by depth ----
    const buckets = new Map<number, Entity[]>();
    const push = (e: Entity) => {
      let b = buckets.get(e.s);
      if (!b) { b = []; buckets.set(e.s, b); }
      b.push(e);
    };
    // Anything standing above the section plane has been cut away with the
    // storey it stood on. A living agent is the exception: the squad stays
    // drawn whatever the plane, so it can never be lost behind the view.
    // Anything under the street is only drawn once the plane has cut down to
    // it; on the surface view the ground hides it, as ground does.
    // What the cut plane leaves visible. Above ground a level shows once the
    // plane is at or over it. Below ground a level also has a floor over its
    // head - the street's slab, or the level above it - and stays hidden
    // until the plane has cut that away, which is why a section taken at the
    // street shows the street and not the garages beneath it.
    const shown = (ez: number) => ez < -0.01
      ? sectioned && ez <= section + 0.01 && section < ez + 1
      : !sectioned || ez <= section + 0.01;
    for (const p of world.peds) {
      if (p.carId !== null || p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
      // Height needs no depth trickery: entities flush after the columns of
      // their own bucket, so a ped on a roof already lands on top of the
      // building it stands on, and nearer columns still occlude it.
      // Everyone obeys the cut plane, the squad included. An agent the plane
      // has taken away is not drawn solid here - the ghost pass further down
      // still shows them through whatever is in the way, which is what makes
      // a squad two levels below the one you are looking at read as present
      // but out of sight rather than standing on the pavement.
      if (!shown(p.z) && !this.inTrench(p.x, p.y, p.z, sectioned, section)) continue;
      push({ s: Math.floor(p.x) + Math.floor(p.y), pri: 1, kind: "ped", ped: p, x: p.x, y: p.y });
    }
    for (const c of world.cars) {
      if (c.x < x0 || c.x > x1 || c.y < y0 || c.y > y1) continue;
      if (!shown(c.z) && !this.inTrench(c.x, c.y, c.z, sectioned, section)) continue;
      push({ s: Math.floor(c.x) + Math.floor(c.y), pri: 1, kind: "car", car: c, x: c.x, y: c.y });
    }
    for (const pt of this.platforms) {
      if (sectioned && pt.level >= section) continue;
      if (pt.x < x0 - 1 || pt.x > x1 + 1 || pt.y < y0 - 1 || pt.y > y1 + 1) continue;
      push({ s: pt.x + pt.y, pri: 0, kind: "platform", x: pt.x + 0.5, y: pt.y + 0.5, plat: pt });
    }
    for (const ft of this.city.fittings) {
      if (ft.x < x0 - 2 || ft.x > x1 + 2 || ft.y < y0 - 2 || ft.y > y1 + 2) continue;
      if (!shown(ft.z)) continue;
      push({ s: ft.x + ft.y, pri: 1, kind: "fitting", x: ft.x + 0.5, y: ft.y + 0.5, fitting: ft });
    }
    for (const fs of this.stairs) {
      if (fs.x < x0 || fs.x > x1 || fs.y < y0 || fs.y > y1) continue;
      if (!shown(fs.base)) continue;
      const ex = fs.x - fs.dy * fs.side, ey = fs.y + fs.dx * fs.side;
      push({ s: Math.max(fs.x + fs.y, fs.rx + fs.ry, ex + ey), pri: 1, kind: "stair",
             x: fs.x + 0.5, y: fs.y + 0.5, stair: fs });
    }
    for (const r of this.city.ramps) {
      const m0 = r.steps[0];
      if (m0.x < x0 - 2 || m0.x > x1 + 2 || m0.y < y0 - 2 || m0.y > y1 + 2) continue;
      if (!shown(0)) continue;
      push({ s: m0.x + m0.y, pri: 1, kind: "metro", x: m0.x + 0.5, y: m0.y + 0.5, ramp: r });
    }
    // Each tile of a garage ramp sits in its own bucket, so a car part-way down
    // the trench is drawn between the segment it is on and the one in front of
    // it. Drawing the whole ramp at one depth would paint over the car.
    const rampBelow = sectioned && section < -0.01;
    this.rampBelow = rampBelow;
    for (const rp of this.rampParts) {
      if (rp.x < x0 - 1 || rp.x > x1 + 1 || rp.y < y0 - 1 || rp.y > y1 + 1) continue;
      // A ramp belongs to the garage as much as to the street. At the plane
      // that shows the garage floor it is the only thing saying how a car got
      // in, so it is drawn there too - and drawn whole, since there is no
      // pavement left in front of it to hide behind.
      if (!shown(0) && !(rampBelow && section >= GARAGE_LEVEL - 0.01)) continue;
      if (rp.inside && !rampBelow) continue;             // behind the wall from up here
      // A portal belongs to the wall it is cut into. Once the plane has sliced
      // that wall down to a kerb there is no wall left to hang it on; below the
      // street there is no wall at all and the whole run draws as trench.
      if (rp.portal && sectioned && section >= 0 && section < 1) continue;
      push({ s: rp.x + rp.y, pri: rp.portal && !rampBelow ? 1 : 0, kind: "gramp",
             x: rp.x + 0.5, y: rp.y + 0.5, gramp: rp });
    }
    for (const l of this.city.lamps) {
      if (l.x < x0 || l.x > x1 || l.y < y0 || l.y > y1) continue;
      if (!shown(0)) continue;
      push({ s: l.x + l.y, pri: 1, kind: "lamp", x: l.x + 0.5, y: l.y + 0.5 });
    }
    for (const ri of this.city.ringIslands) {
      if (ri.x < x0 || ri.x > x1 || ri.y < y0 || ri.y > y1) continue;
      if (!shown(0)) continue;
      push({ s: Math.floor(ri.x) + Math.floor(ri.y), pri: 0, kind: "holo", x: ri.x, y: ri.y });
    }
    for (const p of this.city.props) {
      if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
      if (!shown(0)) continue;
      push({ s: p.x + p.y, pri: 1, kind: "prop", prop: p, x: p.x + 0.5, y: p.y + 0.5 });
    }
    for (const f of this.fences) {
      if (f.x < x0 || f.x > x1 || f.y < y0 || f.y > y1) continue;
      if (!shown(0)) continue;
      push({ s: f.x + f.y, pri: 1, kind: "fence", fence: f, x: f.x + 0.5, y: f.y + 0.5 });
    }
    for (const d of this.decks) {
      if (sectioned && TRAIN_LEVEL >= section) break;   // the line is above the plane
      if (d.x < x0 - 1 || d.x > x1 || d.y < y0 - 1 || d.y > y1) continue;
      if (d.pylon) push({ s: d.x + d.y, pri: 0, kind: "pylon", x: d.x + 1, y: d.y + 1, deckAxis: d.axis });
      push({ s: d.x + d.y, pri: 0, kind: "deck", x: d.x + 1, y: d.y + (d.axis === "v" ? 0.5 : 1), deckAxis: d.axis });
    }
    // trains: real ones now, running the timetable the world keeps for them
    {
      const segLen = TRAIN_SEG, nSeg = TRAIN_CARS;
      for (const t of world.trains) {
        const line = this.city.skytrains[t.line];
        if (!shown(line.level)) continue;               // underground unless cut open
        if (sectioned && line.level >= section + 0.01) continue;
        for (let k = 0; k < nSeg; k++) {
          // cars sit either side of the train's middle, so reversing the line
          // swaps which end leads without moving a single car
          const u = t.u + TRAIN_HALF - k * segLen;
          if (u < -2 || u > GRID + 2) continue;
          const across = trackCentre(line);
          const wx = line.axis === "v" ? across : u + 0.5;
          const wy = line.axis === "v" ? u + 0.5 : across;
          if (wx < x0 || wx > x1 || wy < y0 || wy > y1) continue;
          const angle = line.axis === "v" ? Math.atan2(t.dir, 0) : Math.atan2(0, t.dir);
          // a subway rides the floor of its trench, a storey-third below the
          // platform everything else gates on
          const railZ = line.level < 0 ? line.level - TRACK_DROP : line.level;
          push({ s: Math.floor(wx) + Math.floor(wy), pri: 2, kind: "train", x: wx, y: wy,
                 train: { wx, wy, angle, head: t.dir === 1 ? k === 0 : k === nSeg - 1, lift: railZ * STORY_H,
                          flash: t.flash ?? 0, flashOk: t.flashOk ?? true } });
        }
      }
    }

    // ---- cutaway targets: living agents (and their car) the camera must
    // be able to see - occluding buildings render floors above the first
    // at low alpha ----
    // The subject's height matters as much as its position: an agent up on a
    // roof is above most of what used to stand in front of it.
    const cutTargets: { px: number; py: number; pz: number }[] = [];
    for (const a of world.agents) {
      if (a.hp <= 0 || a.carId !== null) continue;
      cutTargets.push({ px: a.x, py: a.y, pz: a.z });
    }
    for (const c of world.cars) {
      if (c.state === "player" && c.occupants.length > 0) {
        cutTargets.push({ px: c.x, py: c.y, pz: c.z });
      }
    }

    // Which whole buildings actually stand between the camera and an agent?
    // In this projection the view ray out of a point moves one tile nearer the
    // camera for every TILE_H it climbs, so a column hides the agent only if
    // it out-tops that ray where the ray crosses its footprint. Working in
    // world space rather than screen space keeps the test honest at the tile
    // boundaries - and means the block an agent has climbed drops below the
    // ray and stops being sliced open the moment the agent reaches its roof.
    const cutIds = new Set<number>();
    if (cutTargets.length > 0 && !sectioned) {
      const RISE = TILE_H / STORY_H;          // storeys gained per tile travelled
      const CHEST = 0.5;                       // aim the ray at the body, not the feet
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const i = idx(tx, ty);
          const t = tiles[i];
          if (t !== T_WALL && t !== T_BUILDING) continue;
          const stories = hArr[i] || 1;
          if (stories <= 1) continue;
          const id = this.buildingId[i];
          if (id < 0 || cutIds.has(id)) continue;
          for (const ct of cutTargets) {
            const uLo = Math.max(tx - ct.px, ty - ct.py, 0);
            const uHi = Math.min(tx + 1 - ct.px, ty + 1 - ct.py);
            if (uLo >= uHi) continue;          // the ray misses this column
            if (stories > ct.pz + CHEST + uLo * RISE) { cutIds.add(id); break; }
          }
        }
      }
    }

    this.cutawayCount = cutIds.size;

    // ---- pass 2: blocks + entities in depth order ----
    const adFrame = Math.floor(time * 2.2);
    for (let s = x0 + y0; s <= x1 + y1; s++) {
      for (let tx = Math.max(x0, s - y1); tx <= Math.min(x1, s - y0); tx++) {
        const ty = s - tx;
        const i = idx(tx, ty);
        const t = tiles[i];
        if (t !== T_WALL && t !== T_BUILDING) continue;
        const stories = hArr[i] || 1;
        const packed = styleArr[i];
        const block = art.block(stories, packed & 15, packed >> 4, (tx * 31 + ty * 17) % 3);
        const sx = SX(tx, ty) - tw / 2;
        const syTop = SY(tx, ty) - stories * STORY_H * z;
        if (sx > vx + vw || sx + tw < vx || syTop > vy + vh || syTop + th + stories * STORY_H * z < vy) continue;
        // A building occluding an agent is sliced open above its ground floor.
        // Cropping the tall sprite used to cut straight across its sloped wall
        // faces, leaving a staircase silhouette; instead the column is redrawn
        // as a genuine one-storey block and capped with a flat section slab.
        const cut = stories > 1 && cutIds.has(this.buildingId[i]);
        const gy = SY(tx, ty);
        const diamond = (dy: number) => {
          g.beginPath();
          g.moveTo(sx + tw / 2, dy);
          g.lineTo(sx + tw, dy + th / 2);
          g.lineTo(sx + tw / 2, dy + th);
          g.lineTo(sx, dy + th / 2);
          g.closePath();
        };
        if (sectioned && section < 0) continue;
        if (sectioned && stories > section) {
          // Horizontal cross-section: keep the storeys under the plane, take
          // everything above it away. The plane sits a hair above the floor it
          // exposes, so the floor slab reads and the walls stand as a low kerb
          // around it - and every surface the cut passes through is black.
          const floorY = gy - section * STORY_H * z;
          if (section > 0) {
            const below = art.block(section, packed & 15, packed >> 4, (tx * 31 + ty * 17) % 3);
            g.drawImage(below, sx, floorY, tw, th + section * STORY_H * z);
          }
          if (t === T_WALL) {
            const capY = floorY - SECTION_LIP * z;
            g.fillStyle = "#000";                     // the sliced wall itself
            diamond(capY);
            g.fill();
            g.fillStyle = "#0a0a0c";                  // its short exposed flank
            g.beginPath();
            g.moveTo(sx, capY + th / 2);
            g.lineTo(sx + tw / 2, capY + th);
            g.lineTo(sx + tw, capY + th / 2);
            g.lineTo(sx + tw, capY + th / 2 + SECTION_LIP * z);
            g.lineTo(sx + tw / 2, capY + th + SECTION_LIP * z);
            g.lineTo(sx, capY + th / 2 + SECTION_LIP * z);
            g.closePath();
            g.fill();
          } else {
            g.fillStyle = art.cutFloor;               // the room's own floor
            diamond(floorY);
            g.fill();
          }
          continue;
        }
        if (cut) {
          // every column of the building - walls and interior alike - becomes a
          // solid one-storey mass, so the slice exposes fill rather than a void
          const one = art.block(1, packed & 15, packed >> 4, (tx * 31 + ty * 17) % 3);
          const syOne = gy - STORY_H * z;
          g.drawImage(one, sx, syOne, tw, th + STORY_H * z);
          // flat slab where the storeys above were cut away
          g.fillStyle = art.cutCap;
          diamond(syOne);
          g.fill();
          g.strokeStyle = "rgba(0,0,0,0.35)";
          g.lineWidth = 1;
          g.stroke();
        } else {
          g.drawImage(block, sx, syTop, tw, th + stories * STORY_H * z);
        }
        // sparse roof furniture (interior roof tiles only, so it never tiles)
        if (t === T_BUILDING && !cut && !(sectioned && stories > section)) {
          const h = (((tx * 73856093) ^ (ty * 19349663)) >>> 0) % 89;
          const rcx = sx + tw / 2, rcy = syTop + th / 2;
          if (h < 3) { // antenna mast + aircraft light
            g.fillStyle = art.night ? "#6a6a76" : "#9a9aa2";
            g.fillRect(rcx, rcy - 11 * z, z, 11 * z);
            g.fillStyle = `rgba(255,48,72,${0.5 + 0.5 * Math.sin(time * 4 + tx)})`;
            g.fillRect(rcx - z, rcy - 13 * z, 2.5 * z, 2.5 * z);
          } else if (h < 7) { // water tank
            g.fillStyle = art.night ? "#4a4a54" : "#707078";
            g.fillRect(rcx - 4 * z, rcy - 8 * z, 8 * z, 7 * z);
            g.fillStyle = art.night ? "#5e5e6a" : "#8a8a92";
            g.fillRect(rcx - 4 * z, rcy - 8 * z, 8 * z, 2 * z);
          } else if (h < 11) { // vent boxes
            g.fillStyle = art.night ? "#3c3c46" : "#5c5c66";
            g.fillRect(rcx - 5 * z, rcy - 3 * z, 6 * z, 4 * z);
            g.fillRect(rcx + 2 * z, rcy - 1 * z, 4 * z, 3 * z);
          } else if (h === 20 && stories >= 5) { // helipad
            const hc = art.night ? "#8a8a30" : "#c8c840";
            g.strokeStyle = hc;
            g.lineWidth = Math.max(1, z * 0.8);
            g.beginPath(); g.ellipse(rcx, rcy, 10 * z, 5 * z, 0, 0, Math.PI * 2); g.stroke();
            g.fillStyle = hc;
            g.fillRect(rcx - z, rcy - 2.5 * z, 2 * z, 5 * z);
          }
        }
        const decs = this.decoIndex.get(i);
        if (decs) {
          const groundY = SY(tx, ty);
          for (const d of decs) {
            if (d.kind === "door") {
              this.drawDoor(g, d, sx, groundY, tw, z, art);
              continue;
            }
            if (cut && d.level > 0) continue; // that storey was cut away
            if (sectioned && d.level >= section) continue; // above the plane
            const level = Math.min(d.level, stories - 1);
            const img = d.kind === "videowall"
              ? art.ads[d.variant % art.ads.length][(adFrame + d.variant) % 4]
              : d.kind === "megawall"
              ? art.megawalls[d.variant % art.megawalls.length][(adFrame + d.variant) % 6]
              : d.kind === "billboard" ? art.billboards[d.variant % art.billboards.length]
              : d.kind === "shopwin" ? art.shops[d.variant % art.shops.length]
              : art.neons[d.variant % art.neons.length];
            const sxAd = d.kind === "videowall" || d.kind === "megawall" ? 1.2 : d.kind === "neon" ? 1.1 : 1.0;
            const syAd = d.kind === "videowall" || d.kind === "megawall" ? 1.7 : d.kind === "neon" ? 1.5
              : d.kind === "billboard" ? 2.0 : 1.2;
            const inset = 2;
            g.save();
            if (d.face === 0) {
              const ax = sx + inset * z;
              const ay = groundY + (TILE_H / 2) * z - (level + 1) * STORY_H * z + (inset * 0.5 + 3) * z;
              g.transform(z * sxAd, 0.5 * z * sxAd, 0, z * syAd, ax, ay);
            } else {
              const ax = sx + tw / 2 + inset * z;
              const ay = groundY + TILE_H * z - (level + 1) * STORY_H * z + (3 - inset * 0.5) * z;
              g.transform(z * sxAd, -0.5 * z * sxAd, 0, z * syAd, ax, ay);
            }
            g.drawImage(img, 0, 0);
            g.restore();
            g.globalAlpha = 1;
            if (!cut) {
              // feed the shared emissive pass
              const anchX = d.face === 0 ? sx + 2 * z : sx + tw / 2 + 2 * z;
              const anchY = d.face === 0
                ? groundY + (TILE_H / 2) * z - (level + 1) * STORY_H * z + 4 * z
                : groundY + TILE_H * z - (level + 1) * STORY_H * z + 2 * z;
              const cxAd = anchX + (img.width / 2) * sxAd * z;
              const cyAd = anchY + (img.width / 2) * (d.face === 0 ? 0.5 : -0.5) * sxAd * z + (img.height / 2) * syAd * z;
              if (d.kind === "megawall") {
                this.glow(cxAd, cyAd, img.width * sxAd * z * 1.05, art.adColors[(d.variant * 3) % art.adColors.length], art.night ? 0.3 : 0.1);
              } else if (d.kind === "videowall") {
                this.glow(cxAd, cyAd, img.width * sxAd * z * 1.15, art.adColors[d.variant % art.adColors.length], art.night ? 0.2 : 0.07);
              } else if (d.kind === "billboard") {
                this.glow(cxAd, cyAd, img.width * sxAd * z * 1.1, art.adColors[d.variant % art.adColors.length], art.night ? 0.14 : 0.05);
              } else if (d.kind === "shopwin") {
                this.glow(cxAd, cyAd, 22 * z, art.adColors[(d.variant + 5) % art.adColors.length], art.night ? 0.3 : 0.08);
              } else {
                // neon signs buzz: a few of them flicker hard
                const phase = d.x * 2.7 + d.y * 5.3;
                const buzzy = ((d.x * 31 + d.y * 17) & 7) === 0;
                const fl = buzzy ? (Math.sin(this.frameTime * 12 + phase) > -0.4 ? 1 : 0.15)
                  : 0.9 + 0.1 * Math.sin(this.frameTime * 5 + phase);
                this.glow(cxAd, cyAd, 20 * z, art.adColors[(d.variant + 3) % art.adColors.length], (art.night ? 0.3 : 0.1) * fl);
              }
            }
          }
        }
      }
      const b = buckets.get(s);
      if (b) {
        b.sort((a, bb) => (a.pri - bb.pri) || ((a.x + a.y) - (bb.x + bb.y)));
        for (const e of b) this.drawEntity(g, e, world, art, people, SX, SY, z, time);
      }
    }

    // ---- ghost pass: keep agents & vip readable when a building hides them ----
    g.globalAlpha = 0.3;
    for (const p of world.peds) {
      if (p.state === "dead" || p.carId !== null) continue;
      if (p.team === "player" || p.vip) this.drawPed(g, p, world, people, SX, SY, z, time);
    }
    // and the car they are riding in, which is the only thing on screen once a
    // squad drives down into a garage
    for (const c of world.cars) {
      if (c.state !== "player" || c.occupants.length === 0) continue;
      if (shown(c.z) || this.inTrench(c.x, c.y, c.z, sectioned, section)) continue;   // already drawn solid
      this.drawCar(g, c, art, SX, SY, z, time);
    }
    g.globalAlpha = 1;

    // ---- loot beacons: drawn over everything so drops behind buildings
    // stay visible (and taps hit-test by world distance, so they stay usable)
    const icons = itemIcons();
    for (const d of world.drops) {
      if (d.x < x0 || d.x > x1 || d.y < y0 || d.y > y1) continue;
      const sx = SX(d.x, d.y), sy = SY(d.x, d.y);
      const def = ITEMS[d.item.type];
      const bob = Math.sin(time * 3 + d.x) * 1.5 * z;
      const pulse = 0.55 + 0.45 * Math.sin(time * 4 + d.y);
      const icon = icons[d.item.type];
      const isz = ICON_SIZE * 0.95 * z;
      const iconTop = sy - isz - 1.5 * z + bob;
      // halo behind the icon so it separates from the ground
      g.globalCompositeOperation = "lighter";
      let gr = g.createRadialGradient(sx, iconTop + isz / 2, 0, sx, iconTop + isz / 2, isz * 0.7);
      gr.addColorStop(0, def.color);
      gr.addColorStop(1, "rgba(0,0,0,0)");
      g.globalAlpha = 0.28 * pulse;
      g.fillStyle = gr;
      g.fillRect(sx - isz, iconTop - isz * 0.2, isz * 2, isz * 1.4);
      // light pillar, rising from the top of the icon so it never covers it
      const beamH = 16 * z;
      const beamBase = iconTop - 1 * z;
      const grad = g.createLinearGradient(sx, beamBase, sx, beamBase - beamH);
      grad.addColorStop(0, def.color);
      grad.addColorStop(1, "rgba(0,0,0,0)");
      g.globalAlpha = 0.55 * pulse;
      g.fillStyle = grad;
      g.fillRect(sx - 1.6 * z, beamBase - beamH, 3.2 * z, beamH);
      g.globalAlpha = 1;
      g.globalCompositeOperation = "source-over";
      // ground shadow, then the item's own icon hovering just above it
      g.fillStyle = "rgba(0,0,0,0.4)";
      g.beginPath(); g.ellipse(sx, sy, 5 * z, 2 * z, 0, 0, Math.PI * 2); g.fill();
      g.drawImage(icon, sx - isz / 2, iconTop, isz, isz);
      // bouncing chevron above the beam
      const chy = beamBase - beamH - 1 * z;
      g.fillStyle = "#fff";
      g.beginPath();
      g.moveTo(sx, chy + 4 * z);
      g.lineTo(sx - 3.2 * z, chy);
      g.lineTo(sx - 1.4 * z, chy);
      g.lineTo(sx, chy + 1.8 * z);
      g.lineTo(sx + 1.4 * z, chy);
      g.lineTo(sx + 3.2 * z, chy);
      g.closePath();
      g.fill();
    }

    // ---- planted devices ----
    for (const b of world.bombs) {
      if (b.x < x0 || b.x > x1 || b.y < y0 || b.y > y1) continue;
      const sx = SX(b.x, b.y), sy = SY(b.x, b.y);
      g.fillStyle = "#2a2a30";
      g.fillRect(sx - 3 * z, sy - 3.5 * z, 6 * z, 4 * z);
      // the light blinks faster as the fuse runs down
      const blink = Math.floor(time * (b.fuse < 1.5 ? 12 : 4)) % 2 === 0;
      g.fillStyle = blink ? "#ff3030" : "#5a1010";
      g.fillRect(sx - 1 * z, sy - 3 * z, 2 * z, 1.6 * z);
      if (blink) this.glow(sx, sy - 2 * z, 6 * z, "#ff3030", 0.4);
    }
    for (const gc of world.gasClouds) {
      if (gc.x < x0 - 4 || gc.x > x1 + 4 || gc.y < y0 - 4 || gc.y > y1 + 4) continue;
      const sx = SX(gc.x, gc.y), sy = SY(gc.x, gc.y);
      const fade = Math.min(1, gc.t / (gc.maxT * 0.35));   // thins out as it dies
      const rr = gc.r * TILE_W * 0.9 * z;
      const cloud = g.createRadialGradient(sx, sy - 4 * z, 0, sx, sy - 4 * z, rr);
      cloud.addColorStop(0, `rgba(143,220,90,${0.34 * fade})`);
      cloud.addColorStop(0.7, `rgba(110,190,70,${0.18 * fade})`);
      cloud.addColorStop(1, "rgba(110,190,70,0)");
      g.fillStyle = cloud;
      g.beginPath();
      g.ellipse(sx, sy - 4 * z, rr, rr * 0.55, 0, 0, Math.PI * 2);
      g.fill();
      // a few drifting wisps sell the volume
      for (let k = 0; k < 5; k++) {
        const a = time * 0.7 + k * 1.26;
        const wx = sx + Math.cos(a) * rr * 0.5, wy = sy - 4 * z + Math.sin(a * 1.3) * rr * 0.28;
        g.fillStyle = `rgba(160,230,110,${0.10 * fade})`;
        g.beginPath(); g.ellipse(wx, wy, rr * 0.3, rr * 0.17, 0, 0, Math.PI * 2); g.fill();
      }
    }

    // ---- effects ----
    for (const pr of world.projectiles) {
      const sx = SX(pr.x, pr.y), sy = SY(pr.x, pr.y) - (6 + pr.z * STORY_H) * z;
      g.fillStyle = ITEMS[pr.type]?.color ?? "#ffe";
      g.fillRect(sx - z, sy - z, 2 * z, 2 * z);
    }
    // beams and weapon trails
    g.globalCompositeOperation = "lighter";
    for (const b of world.beams) {
      g.strokeStyle = b.color;
      g.globalAlpha = Math.min(1, b.life / b.maxLife);
      g.lineWidth = b.w * z;
      g.lineCap = "round";
      g.beginPath();
      g.moveTo(SX(b.x0, b.y0), SY(b.x0, b.y0) - (6 + b.z0 * STORY_H) * z);
      g.lineTo(SX(b.x1, b.y1), SY(b.x1, b.y1) - (6 + b.z1 * STORY_H) * z);
      g.stroke();
      g.globalAlpha = 1;
    }
    g.lineCap = "butt";
    // muzzle flashes and explosion light
    for (const f of world.flashes) {
      const t = Math.max(0, f.life / f.maxLife);
      const sx = SX(f.x, f.y), sy = SY(f.x, f.y) - 6 * z;
      if (f.ring) {
        const rr = f.r * z * (1 - t) * 1.1;
        g.strokeStyle = `rgba(255,190,110,${t * 0.55})`;
        g.lineWidth = Math.max(1, 3 * z * t);
        g.beginPath();
        g.ellipse(sx, sy, rr, rr * 0.5, 0, 0, Math.PI * 2);
        g.stroke();
      } else {
        const r = f.r * z * (0.35 + 0.65 * t);
        const gr = g.createRadialGradient(sx, sy, 0, sx, sy, r);
        gr.addColorStop(0, `rgba(255,245,210,${0.85 * t})`);
        gr.addColorStop(0.45, `rgba(255,170,60,${0.5 * t})`);
        gr.addColorStop(1, "rgba(255,120,20,0)");
        g.fillStyle = gr;
        g.fillRect(sx - r, sy - r, r * 2, r * 2);
      }
    }
    g.globalCompositeOperation = "source-over";

    // Smoke sits behind the flames, so draw it first and unlit. Each puff is
    // three overlapping lobes rather than one disc, which is what makes a
    // column billow instead of reading as a row of grey dots; it darkens and
    // thins as it climbs, so the top of a plume is soot rather than fog.
    for (const pt of world.particles) {
      if (pt.kind !== "smoke") continue;
      const t = Math.max(0, pt.life / pt.maxLife);
      const age = 1 - t;
      const sx = SX(pt.x, pt.y), sy = SY(pt.x, pt.y) - 4 * z - pt.lift * z;
      const r = pt.size * z;
      // fresh smoke off a fire is near black; it greys only as it disperses
      const sprite = this.puffSprite(age > 0.55 ? 1 : 0);   // soot, then dispersing grey
      const alpha = 0.5 * Math.min(1, t * 2.6);       // fade in fast, out slowly
      g.globalAlpha = alpha;
      for (let k = 0; k < 2; k++) {
        const a = pt.seed * Math.PI * 2 + k * 2.4 + age * 1.4;
        const off = k === 0 ? 0 : r * 0.45;
        const lx = sx + Math.cos(a) * off, ly = sy + Math.sin(a) * off * 0.6;
        const lr = r * (k === 0 ? 1 : 0.8);
        g.drawImage(sprite, lx - lr, ly - lr, lr * 2, lr * 2);
      }
      g.globalAlpha = 1;
    }
    // solid bits: blood and debris
    for (const pt of world.particles) {
      if (pt.kind !== "blood" && pt.kind !== "debris") continue;
      g.globalAlpha = Math.max(0, pt.life / pt.maxLife);
      g.fillStyle = pt.color;
      const sx = SX(pt.x, pt.y), sy = SY(pt.x, pt.y) - 4 * z - pt.lift * z;
      g.fillRect(sx, sy, pt.size * z, pt.size * z);
    }
    g.globalAlpha = 1;
    // fire and sparks burn additively, cooling white -> yellow -> orange -> red
    g.globalCompositeOperation = "lighter";
    for (const pt of world.particles) {
      if (pt.kind !== "fire" && pt.kind !== "spark") continue;
      const t = Math.max(0, pt.life / pt.maxLife);
      const sx = SX(pt.x, pt.y), sy = SY(pt.x, pt.y) - 4 * z - pt.lift * z;
      const c = t > 0.8 ? "255,250,225" : t > 0.55 ? "255,222,120" : t > 0.3 ? "255,140,45" : "205,55,20";
      if (pt.kind === "spark") {
        g.fillStyle = `rgba(${c},${t})`;
        g.fillRect(sx - z * 0.5, sy - z * 0.5, pt.size * z, pt.size * z);
        continue;
      }
      // A flame is a tongue, not a dot of light: it tapers as it rises, necks
      // and bulges along its length, and leans as it licks upward. Drawn as a
      // filled outline with a hotter core inside, so overlapping tongues pile
      // up additively into one convoluted mass of fire.
      const w = Math.max(1, pt.size * z * 0.85);
      const h = w * (2.5 + 1.6 * t);
      const ph = pt.seed * Math.PI * 2;
      const tongue = (ww: number, hh: number, alpha: number, col: string, ramp: boolean) => {
        const N = 7;
        g.beginPath();
        for (let side = 0; side < 2; side++) {
          for (let i = 0; i <= N; i++) {
            const k = side === 0 ? i : N - i;
            const f = k / N;                                  // 0 root .. 1 tip
            // lean and wobble, growing toward the tip
            const cx = Math.sin(time * 7.5 + ph + f * 3.4) * ww * 0.85 * f * f;
            // neck and bulge along the length, so the edge is never a clean arc
            const hw = ww * Math.pow(1 - f, 0.62) * (0.78 + 0.42 * Math.sin(ph * 9 + f * 6.2 + time * 5));
            const px2 = sx + cx + (side === 0 ? -hw : hw);
            const py2 = sy - f * hh;
            if (side === 0 && i === 0) g.moveTo(px2, py2); else g.lineTo(px2, py2);
          }
        }
        g.closePath();
        if (ramp) {
          // hot and dense at the root, thinning to nothing at the tip: a flat
          // fill is what makes a flame read as a paper cutout
          const lg = g.createLinearGradient(sx, sy, sx, sy - hh);
          lg.addColorStop(0, `rgba(${col},${alpha.toFixed(3)})`);
          lg.addColorStop(0.45, `rgba(${col},${(alpha * 0.55).toFixed(3)})`);
          lg.addColorStop(1, `rgba(${col},0)`);
          g.fillStyle = lg;
        } else {
          g.fillStyle = `rgba(${col},${alpha.toFixed(3)})`;
        }
        g.fill();
      };
      tongue(w, h, 0.34 * t, c, true);                        // the body of the flame
      tongue(w * 0.52, h * 0.62, 0.4 * t, t > 0.45 ? "255,240,190" : c, false);   // hotter core
    }
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;

    // ---- emissive pass: shared additive bloom for every light source ----
    if (this.emissives.length > 0) {
      g.globalCompositeOperation = "lighter";
      for (const e of this.emissives) {
        const [cr, cg, cb] = e.col;
        // hot core
        let gr = g.createRadialGradient(e.x, e.y, 0, e.x, e.y, e.r * 0.45);
        gr.addColorStop(0, `rgba(${cr},${cg},${cb},${Math.min(1, e.i * 1.6)})`);
        gr.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
        g.fillStyle = gr;
        g.fillRect(e.x - e.r * 0.45, e.y - e.r * 0.45, e.r * 0.9, e.r * 0.9);
        // soft halo
        gr = g.createRadialGradient(e.x, e.y, 0, e.x, e.y, e.r);
        gr.addColorStop(0, `rgba(${cr},${cg},${cb},${e.i * 0.45})`);
        gr.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
        g.fillStyle = gr;
        g.fillRect(e.x - e.r, e.y - e.r, e.r * 2, e.r * 2);
      }
      g.globalCompositeOperation = "source-over";
    }
    if (this.lampGlows.length > 0) {
      g.globalCompositeOperation = "lighter";
      for (const lm of this.lampGlows) {
        // most lamps breathe gently; a few are faulty and strobe
        const faulty = ((lm.phase * 13.7) | 0) % 11 === 0;
        const flicker = faulty
          ? (Math.sin(time * 13 + lm.phase) > 0.1 ? 1 : 0.12)
          : 0.9 + 0.1 * Math.sin(time * 6 + lm.phase) * Math.sin(time * 2.3 + lm.phase * 1.7);
        // hot core on the lens
        let gr = g.createRadialGradient(lm.x, lm.y, 0, lm.x, lm.y, 8 * z);
        gr.addColorStop(0, `rgba(255,236,180,${0.6 * flicker})`);
        gr.addColorStop(1, "rgba(255,236,180,0)");
        g.fillStyle = gr;
        g.fillRect(lm.x - 8 * z, lm.y - 8 * z, 16 * z, 16 * z);
        // wide soft halo
        gr = g.createRadialGradient(lm.x, lm.y, 0, lm.x, lm.y, 24 * z);
        gr.addColorStop(0, `rgba(255,214,130,${0.12 * flicker})`);
        gr.addColorStop(1, "rgba(255,214,130,0)");
        g.fillStyle = gr;
        g.fillRect(lm.x - 24 * z, lm.y - 24 * z, 48 * z, 48 * z);
        // pool of light on the pavement (flattened to the iso ground plane)
        g.save();
        g.translate(lm.x, lm.gy);
        g.scale(1, 0.45);
        gr = g.createRadialGradient(0, 0, 0, 0, 0, 14 * z);
        gr.addColorStop(0, `rgba(255,224,150,${0.24 * flicker})`);
        gr.addColorStop(1, "rgba(255,224,150,0)");
        g.fillStyle = gr;
        g.fillRect(-14 * z, -14 * z, 28 * z, 28 * z);
        g.restore();
      }
      g.globalCompositeOperation = "source-over";
    }

    // ---- tap-destination markers ----
    for (const pg of world.pings) {
      if (!shown(pg.z)) continue;
      const fade = pg.fade;
      const mx = SX(pg.x, pg.y), my = SY(pg.x, pg.y) - pg.z * STORY_H * z;
      const col = pg.ok ? "79,220,106" : "224,64,64";
      const rx = (TILE_W / 2) * z, ry = (TILE_H / 2) * z;
      // The shockwave repeats on its own clock for as long as the marker is
      // held, so a destination somebody is still walking to keeps reading as
      // live instead of freezing into a decal.
      const t = (pg.age % 1.1) / 1.1;          // 0 fresh -> 1 gone
      const grow = 0.35 + t * 1.5;
      g.strokeStyle = `rgba(${col},${0.8 * fade * (1 - t)})`;
      g.lineWidth = 2.5;
      g.beginPath();
      g.ellipse(mx, my, rx * grow, ry * grow, 0, 0, Math.PI * 2);
      g.stroke();
      // steady inner ring with tick marks
      g.strokeStyle = `rgba(${col},${0.9 * fade})`;
      g.lineWidth = 1.5;
      g.beginPath();
      g.ellipse(mx, my, rx * 0.62, ry * 0.62, 0, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        g.moveTo(mx + dx * rx * 0.75, my + dy * ry * 0.75);
        g.lineTo(mx + dx * rx * 1.1, my + dy * ry * 1.1);
      }
      g.stroke();
      // bright pip at the exact spot
      g.fillStyle = `rgba(${col},${fade})`;
      g.fillRect(mx - 1.5 * z, my - 1 * z, 3 * z, 2 * z);
    }

    // roundabout holo-beacons
    for (const rb of this.city.roundabouts) {
      if (rb.x + 0.5 < x0 || rb.x > x1 || rb.y + 0.5 < y0 || rb.y > y1) continue;
      const bx = SX(rb.x + 0.5, rb.y + 0.5), by = SY(rb.x + 0.5, rb.y + 0.5);
      const pulse = 0.6 + 0.4 * Math.sin(time * 2.5 + rb.x);
      g.globalCompositeOperation = "lighter";
      const beamH = 60 * z;
      const grad = g.createLinearGradient(bx, by, bx, by - beamH);
      grad.addColorStop(0, `rgba(60,220,255,${0.5 * pulse})`);
      grad.addColorStop(1, "rgba(60,220,255,0)");
      g.fillStyle = grad;
      g.fillRect(bx - 2.5 * z, by - beamH, 5 * z, beamH);
      g.strokeStyle = `rgba(60,220,255,${0.4 * pulse})`;
      g.lineWidth = 1.5;
      g.beginPath();
      g.ellipse(bx, by, 14 * z, 6 * z, 0, 0, Math.PI * 2);
      g.stroke();
      g.globalCompositeOperation = "source-over";
    }

    // extraction zone marker - and the uplink pad, which is the same ring but
    // filled, because it is a place to stand rather than a place to arrive at
    const m = world.mission;
    if (m.zone && !m.done && !m.failed) {
      const sx = SX(m.zone.x, m.zone.y), sy = SY(m.zone.x, m.zone.y);
      const rx = m.zone.r * TILE_W * 0.5 * z, ry = m.zone.r * TILE_H * 0.5 * z;
      const pad = m.kind === "hold";
      const held = pad && world.agents.some((a) => a.hp > 0 && a.carId === null
        && (a.x - m.zone!.x) ** 2 + (a.y - m.zone!.y) ** 2 < m.zone!.r ** 2);
      if (pad) {
        g.fillStyle = held ? "rgba(120,255,190,0.14)" : "rgba(255,155,47,0.12)";
        g.beginPath();
        g.ellipse(sx, sy, rx, ry, 0, 0, Math.PI * 2);
        g.fill();
      }
      g.strokeStyle = pad
        ? (held ? "rgba(120,255,190,0.9)" : "rgba(255,155,47,0.85)")
        : "rgba(120,255,190,0.7)";
      g.lineWidth = 2;
      const pulse = 1 + 0.15 * Math.sin(time * (pad && !held ? 7 : 4));
      g.beginPath();
      g.ellipse(sx, sy, rx * pulse, ry * pulse, 0, 0, Math.PI * 2);
      g.stroke();
    }

    // rain overlay
    if (isRain(art.weather)) {
      if (this.rainDrops.length === 0) {
        for (let i = 0; i < 90; i++) {
          this.rainDrops.push({ x: Math.random(), y: Math.random(), v: 0.9 + Math.random() * 0.7 });
        }
      }
      g.strokeStyle = isNight(art.weather) ? "rgba(150,180,230,0.34)" : "rgba(200,215,235,0.4)";
      g.lineWidth = 1;
      g.beginPath();
      for (const d of this.rainDrops) {
        d.y += d.v * 0.03; d.x -= 0.004;
        if (d.y > 1) { d.y -= 1; d.x = Math.random(); }
        if (d.x < 0) d.x += 1;
        const rx = vx + d.x * vw, ry = vy + d.y * vh;
        g.moveTo(rx, ry);
        g.lineTo(rx - 3, ry + 11);
      }
      g.stroke();
    }

    // night vignette
    if (isNight(art.weather)) {
      const vg = g.createRadialGradient(cx, cy, Math.min(vw, vh) * 0.32, cx, cy, Math.max(vw, vh) * 0.75);
      vg.addColorStop(0, "rgba(0,0,10,0)");
      vg.addColorStop(1, "rgba(0,0,12,0.55)");
      g.fillStyle = vg;
      g.fillRect(vx, vy, vw, vh);
    }

    g.restore();
  }

  // door + stoop steps on a wall face at street level
  private drawDoor(
    g: CanvasRenderingContext2D, d: Deco, sx: number, groundY: number, tw: number, z: number, art: TileArt
  ): void {
    const doorW = 9, doorH = 20;
    const doorCols = ["#2a2e38", "#3a2c28", "#26323a", "#32283a"];
    const col = doorCols[d.variant % doorCols.length];
    g.save();
    if (d.face === 0) {
      const ax = sx + 3.5 * z;
      const ay = groundY + (TILE_H / 2) * z + 3.5 * 0.5 * z - doorH * z + (STORY_H - 30) * z;
      g.transform(z, 0.5 * z, 0, z, ax, ay);
    } else {
      const ax = sx + tw / 2 + 3.5 * z;
      const ay = groundY + TILE_H * z - 3.5 * 0.5 * z - doorH * z;
      g.transform(z, -0.5 * z, 0, z, ax, ay);
    }
    // frame, door, lit lintel sign
    g.fillStyle = "rgba(0,0,0,0.45)";
    g.fillRect(-1, -1, doorW + 2, doorH + 1);
    g.fillStyle = col;
    g.fillRect(0, 0, doorW, doorH);
    g.fillStyle = "rgba(255,255,255,0.12)";
    g.fillRect(0, 0, doorW, 1.5);
    g.fillStyle = art.night ? "#7dff9f" : "#3a5a44";
    g.fillRect(doorW - 2.5, 8, 1.5, 3); // keypad glow
    if (d.variant % 2 === 0) { // split doors
      g.fillStyle = "rgba(0,0,0,0.5)";
      g.fillRect(doorW / 2 - 0.5, 0, 1, doorH);
    }
    g.restore();
    // stoop steps out onto the pavement
    const stepCol = "rgba(255,255,255,0.14)";
    const stepDark = "rgba(0,0,0,0.3)";
    if (d.face === 0) {
      const bx = sx + 3.5 * z, by = groundY + (TILE_H / 2) * z + 2 * z;
      g.fillStyle = stepDark;
      g.fillRect(bx, by + 2.5 * z, 10 * z, 3 * z);
      g.fillStyle = stepCol;
      g.fillRect(bx, by + 2 * z, 10 * z, 1.2 * z);
      g.fillStyle = stepDark;
      g.fillRect(bx + z, by + 5.5 * z, 8 * z, 2.4 * z);
      g.fillStyle = stepCol;
      g.fillRect(bx + z, by + 5 * z, 8 * z, z);
    } else {
      const bx = sx + tw / 2 + 4 * z, by = groundY + (TILE_H / 2) * z + 2 * z;
      g.fillStyle = stepDark;
      g.fillRect(bx, by + 2.5 * z, 10 * z, 3 * z);
      g.fillStyle = stepCol;
      g.fillRect(bx, by + 2 * z, 10 * z, 1.2 * z);
    }
  }

  private drawEntity(
    g: CanvasRenderingContext2D, e: Entity, world: World, art: TileArt, people: PeopleAtlas,
    SX: (x: number, y: number) => number, SY: (x: number, y: number) => number, z: number, time: number
  ): void {
    if (e.kind === "fitting" && e.fitting) {
      this.drawFitting(g, e.fitting, SX, SY, z, art, time);
      return;
    }
    if (e.kind === "metro" && e.ramp) {
      this.drawMetroEntrance(g, e.ramp, SX, SY, z, art, time);
      return;
    }
    if (e.kind === "car" && e.car && e.car.marked && e.car.state !== "wreck") {
      // a chevron over a marked vehicle: a motor pool is only findable if the
      // cars in it look different from the hundred others on the kerb
      const sx = SX(e.car.x, e.car.y), sy = SY(e.car.x, e.car.y) - e.car.z * STORY_H * z;
      const bob = Math.sin(time * 4) * 1.5 * z;
      g.fillStyle = `rgba(255,80,80,${0.65 + 0.35 * Math.sin(time * 5)})`;
      g.beginPath();
      g.moveTo(sx, sy - 17 * z + bob);
      g.lineTo(sx - 4 * z, sy - 24 * z + bob);
      g.lineTo(sx + 4 * z, sy - 24 * z + bob);
      g.closePath(); g.fill();
    }
    if (e.kind === "gramp" && e.gramp) {
      this.drawGarageRamp(g, e.gramp, SX, SY, z, art);
      return;
    }
    if (e.kind === "platform" && e.plat) {
      this.drawPlatform(g, e.plat, SX, SY, z, art);
      return;
    }
    if (e.kind === "stair" && e.stair) {
      this.drawFireStair(g, e.stair, SX, SY, z);
      return;
    }
    if (e.kind === "lamp") {
      const sx = SX(e.x, e.y), sy = SY(e.x, e.y);
      // mirror the lamp so its arm reaches over the street it lights
      const gx = Math.floor(e.x), gy = Math.floor(e.y);
      const roadRight = isRoad(this.city, gx + 1, gy) || isRoad(this.city, gx, gy - 1);
      const roadLeft = isRoad(this.city, gx - 1, gy) || isRoad(this.city, gx, gy + 1);
      const flip = roadLeft && !roadRight;
      if (flip) {
        g.save();
        g.translate(sx * 2, 0);
        g.scale(-1, 1);
        g.drawImage(art.lamp, sx - 8 * z, sy - 40 * z, 20 * z, 42 * z);
        g.restore();
      } else {
        g.drawImage(art.lamp, sx - 8 * z, sy - 40 * z, 20 * z, 42 * z);
      }
      if (art.night) {
        this.lampGlows.push({
          x: flip ? sx - 6.5 * z : sx + 6.5 * z,
          y: sy - 31 * z,
          gy: sy - 1 * z,
          phase: gx * 3.1 + gy * 7.7,
        });
      }
      return;
    }
    if (e.kind === "prop" && e.prop) {
      const sx = SX(e.x, e.y), sy = SY(e.x, e.y);
      const p = e.prop;
      // Props are supersampled bitmaps, so drawing them means downscaling the
      // source: turn smoothing on for that, or the downscale is as blocky as
      // the upscale used to be. The pixel-art tiles need it off, so put it back.
      g.imageSmoothingEnabled = true;
      if (p.kind === "tree") {
        const img = art.trees[p.variant % art.trees.length];
        g.drawImage(img, sx - (TREE_W / 2) * z, sy - (TREE_H - 2) * z, TREE_W * z, TREE_H * z);
      } else if (p.kind === "bench") {
        const img = art.benches[p.variant % art.benches.length];
        g.drawImage(img, sx - (BENCH_W / 2) * z, sy - (BENCH_H - 2) * z, BENCH_W * z, BENCH_H * z);
      } else {
        const img = art.stalls[p.variant % art.stalls.length];
        g.drawImage(img, sx - (STALL_W / 2) * z, sy - (STALL_H - 2) * z, STALL_W * z, STALL_H * z);
        if (art.night) this.glow(sx, sy - 30 * z, 14 * z, "#ff9b2f", 0.3);
      }
      g.imageSmoothingEnabled = false;
      return;
    }
    if (e.kind === "fence" && e.fence) {
      this.drawFence(g, e.fence, art, SX, SY, z);
      return;
    }
    if (e.kind === "holo") {
      this.drawHologram(g, e.x, e.y, art, SX, SY, z, time);
      return;
    }
    if (e.kind === "pylon") {
      this.drawPylon(g, e, art, SX, SY, z);
      return;
    }
    if (e.kind === "deck") {
      this.drawDeck(g, e, art, SX, SY, z, time);
      return;
    }
    if (e.kind === "train" && e.train) {
      this.drawTrain(g, e.train, art, SX, SY, z);
      return;
    }
    if (e.kind === "car" && e.car) {
      this.drawCar(g, e.car, art, SX, SY, z, time);
      return;
    }
    if (e.kind === "ped" && e.ped) {
      this.drawPed(g, e.ped, world, people, SX, SY, z, time);
    }
  }

  // A fire escape bolted to the flank: a zig-zag of landings and flights from
  // the pavement to the parapet, drawn along the tile edge it shares with the
  // building so it reads as attached rather than free-standing.
  // The furniture of an underground concourse. Everything is built from the
  // same lit box so a hall reads as a parade of frontages: what changes is the
  // height, the colour of the light and what is written across it.
  private drawFitting(
    g: CanvasRenderingContext2D, f: Fitting,
    SX: (x: number, y: number) => number, SY: (x: number, y: number) => number, z: number,
    art: TileArt, time: number
  ): void {
    const lift = f.z * STORY_H * z;
    const cx = SX(f.x + 0.5, f.y + 0.5), cy = SY(f.x + 0.5, f.y + 0.5) - lift;
    const tw = TILE_W * z, th = TILE_H * z;
    const box = (h: number, body: string, top: string) => {
      const hh = h * z;
      g.fillStyle = body;
      g.beginPath();
      g.moveTo(cx - tw / 2, cy);
      g.lineTo(cx, cy + th / 2);
      g.lineTo(cx + tw / 2, cy);
      g.lineTo(cx + tw / 2, cy - hh);
      g.lineTo(cx, cy + th / 2 - hh);
      g.lineTo(cx - tw / 2, cy - hh);
      g.closePath();
      g.fill();
      g.fillStyle = top;
      g.beginPath();
      g.moveTo(cx, cy - th / 2 - hh);
      g.lineTo(cx + tw / 2, cy - hh);
      g.lineTo(cx, cy + th / 2 - hh);
      g.lineTo(cx - tw / 2, cy - hh);
      g.closePath();
      g.fill();
    };
    const sign = (col: string, h: number, w: number) => {
      g.fillStyle = col;
      g.fillRect(cx - w / 2, cy - h * z, w, 3.2 * z);
      this.glow(cx, cy - h * z, 11 * z, col, 0.45);
    };
    const flick = 0.75 + 0.25 * Math.sin(time * 3 + f.x * 1.7 + f.y);
    switch (f.kind) {
      case "ticket":                                   // the ticket hall
        box(13, "#2a3140", "#39424f");
        sign(`rgba(120,210,255,${flick})`, 12, tw * 0.62);
        break;
      case "shop": {
        box(12, "#242a35", "#333b47");
        const cols = ["#ff5fa8", "#5fe0ff", "#ffd166", "#a6ff6b"];
        sign(cols[f.variant % cols.length], 11.5, tw * 0.7);
        // a lit window under the sign
        g.fillStyle = art.night ? "#f4f6ff" : "#e8ecf6";
        g.globalAlpha = 0.75;
        g.fillRect(cx - tw * 0.26, cy - 7 * z, tw * 0.52, 4.5 * z);
        g.globalAlpha = 1;
        break;
      }
      case "food": {
        box(12, "#2b2330", "#3a3040");
        const cols = ["#ff8a3d", "#ffd166", "#ff5f5f", "#c06bff"];
        sign(cols[f.variant % cols.length], 11.5, tw * 0.66);
        // counter and stools
        g.fillStyle = "#5a4a3a";
        g.fillRect(cx - tw * 0.3, cy - 2 * z, tw * 0.6, 2 * z);
        break;
      }
      case "bench":
        g.fillStyle = "#3d4450";
        g.fillRect(cx - tw * 0.28, cy - 3.4 * z, tw * 0.56, 1.6 * z);
        g.fillStyle = "#2a3038";
        g.fillRect(cx - tw * 0.24, cy - 1.8 * z, 1.6 * z, 1.8 * z);
        g.fillRect(cx + tw * 0.24 - 1.6 * z, cy - 1.8 * z, 1.6 * z, 1.8 * z);
        break;
      case "map":
        box(8, "#232a34", "#2f3742");
        sign("rgba(120,255,190,0.9)", 7.5, tw * 0.4);
        break;
      case "column":
        g.fillStyle = "#39414d";
        g.fillRect(cx - 2.6 * z, cy - 14 * z, 5.2 * z, 14 * z);
        g.fillStyle = "#4a5462";
        g.fillRect(cx - 3.4 * z, cy - 15 * z, 6.8 * z, 1.6 * z);
        break;
    }
  }

  // A platform: the deck widened either side of the track, railed along both
  // edges and lit, so a stop is legible from street level.
  // The head of a ramp into the metro: a lit opening in the pavement, a rail
  // round the three sides you should not walk off, and the roundel on a post
  // so it reads as an entrance from across the street.
  // The way down into a basement garage. Out in the open the ramp is a trench
  // cut into the street, with a retaining wall down either side; where it goes
  // under the building it becomes a portal in the wall it passes through, lit
  // from inside. Without it the car simply sinks through the pavement.
  // The centrepiece of a roundabout: a holographic globe projected off a
  // plinth on the island. Latitude rings squash with the iso view; meridians
  // read the spin, their on-screen width breathing with the rotation; the
  // whole thing flickers slightly, as a projection should, and carries its
  // light with it at night.
  private drawHologram(
    g: CanvasRenderingContext2D, wx: number, wy: number, art: TileArt,
    SX: (x: number, y: number) => number, SY: (x: number, y: number) => number, z: number, time: number
  ): void {
    const sx = SX(wx, wy), sy = SY(wx, wy);
    const seed = (Math.floor(wx) * 7 + Math.floor(wy) * 13) % 5;
    const col = ["#25e0ff", "#ff2fa0", "#c8b4ff", "#7dff3f", "#ffe32f"][seed];
    const n = parseInt(col.slice(1), 16);
    const cr = (n >> 16) & 255, cg = (n >> 8) & 255, cb = n & 255;
    const rgba = (a: number) => `rgba(${cr},${cg},${cb},${a.toFixed(3)})`;

    // the emitter: a low drum with a lit lens
    const ph = 6 * z;
    g.fillStyle = art.night ? "#14171c" : "#2a2e35";
    g.beginPath(); g.ellipse(sx, sy - ph, 5.5 * z, 2.6 * z, 0, 0, Math.PI * 2); g.fill();
    g.fillRect(sx - 5.5 * z, sy - ph, 11 * z, ph);
    g.beginPath(); g.ellipse(sx, sy, 5.5 * z, 2.6 * z, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = rgba(0.9);
    g.beginPath(); g.ellipse(sx, sy - ph, 2.4 * z, 1.1 * z, 0, 0, Math.PI * 2); g.fill();

    // projection flicker: mostly steady, with the odd shiver
    const flick = 0.8 + 0.14 * Math.sin(time * 11 + seed * 2.1) + 0.06 * Math.sin(time * 37 + seed);
    const R = 11 * z;                                  // globe radius
    const cy = sy - ph - 20 * z;                       // globe centre height
    g.globalCompositeOperation = "lighter";

    // the column of light from lens to globe
    const beam = g.createLinearGradient(sx, sy - ph, sx, cy);
    beam.addColorStop(0, rgba(0.20 * flick));
    beam.addColorStop(1, rgba(0.04 * flick));
    g.fillStyle = beam;
    g.beginPath();
    g.moveTo(sx - 2.2 * z, sy - ph);
    g.lineTo(sx + 2.2 * z, sy - ph);
    g.lineTo(sx + R * 0.8, cy);
    g.lineTo(sx - R * 0.8, cy);
    g.closePath(); g.fill();

    // globe shell
    const shell = g.createRadialGradient(sx, cy, 0, sx, cy, R);
    shell.addColorStop(0, rgba(0.10 * flick));
    shell.addColorStop(0.85, rgba(0.05 * flick));
    shell.addColorStop(1, rgba(0));
    g.fillStyle = shell;
    g.beginPath(); g.arc(sx, cy, R, 0, Math.PI * 2); g.fill();
    g.lineWidth = Math.max(1, 0.7 * z);
    g.strokeStyle = rgba(0.5 * flick);
    g.beginPath(); g.arc(sx, cy, R, 0, Math.PI * 2); g.stroke();

    // latitude rings
    g.strokeStyle = rgba(0.4 * flick);
    for (const t of [-0.55, 0, 0.55]) {
      const ry = R * Math.sqrt(1 - t * t);
      g.beginPath(); g.ellipse(sx, cy + R * t * 0.9, ry, ry * 0.3, 0, 0, Math.PI * 2); g.stroke();
    }
    // meridians: their width breathes with the spin
    const spin = time * 0.7 + seed;
    for (let k = 0; k < 3; k++) {
      const w = Math.cos(spin + (k * Math.PI) / 3);
      g.strokeStyle = rgba((0.22 + 0.22 * Math.abs(w)) * flick);
      g.beginPath(); g.ellipse(sx, cy, Math.max(0.5, Math.abs(w) * R), R, 0, 0, Math.PI * 2); g.stroke();
    }
    // a bright tracer riding the equator marks the direction of spin
    const ta = spin * 1.6;
    g.fillStyle = rgba(0.85 * flick);
    g.fillRect(sx + Math.cos(ta) * R - z * 0.8, cy + Math.sin(ta) * R * 0.3 - z * 0.8, 1.6 * z, 1.6 * z);
    // scanlines through the projection
    g.strokeStyle = rgba(0.08 * flick);
    g.lineWidth = Math.max(1, 0.5 * z);
    const drift = (time * 6) % 3;
    for (let yy = -R; yy < R; yy += 3 * z) {
      const w = Math.sqrt(Math.max(0, R * R - (yy + drift * z) ** 2));
      if (w < 1) continue;
      g.beginPath(); g.moveTo(sx - w, cy + yy + drift * z); g.lineTo(sx + w, cy + yy + drift * z); g.stroke();
    }
    g.globalCompositeOperation = "source-over";
    if (art.night) this.glow(sx, cy, R * 2.4, col, 0.25 * flick);
  }

  private drawGarageRamp(
    g: CanvasRenderingContext2D, r: RampPart,
    SX: (x: number, y: number) => number, SY: (x: number, y: number) => number, z: number,
    art: TileArt
  ): void {
    const HALF = 0.92;                     // half of the two-tile cut, kerb either side
    const OPEN = 0.72;                     // headroom at the portal, in storeys
    // u runs down the ramp from the near edge of the tile, v across it; v is
    // centred between the pair of columns, so the whole wide trench draws from
    // this one part exactly as the single-tile cut used to
    const P = (u: number, v0: number, h: number): [number, number] => {
      const v = v0 + r.vMid;
      const wx = r.x + 0.5 + r.dx * u - r.dy * v;
      const wy = r.y + 0.5 + r.dy * u + r.dx * v;
      return [SX(wx, wy), SY(wx, wy) - h * STORY_H * z];
    };
    const quad = (a: [number, number], b: [number, number], c: [number, number], d: [number, number], fill: string) => {
      g.fillStyle = fill;
      g.beginPath();
      g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(c[0], c[1]); g.lineTo(d[0], d[1]);
      g.closePath(); g.fill();
    };

    if (r.portal && !this.rampBelow) {
      // Only the face the ramp enters through is worth drawing, and only when
      // it is turned towards the camera - the other two are behind the block.
      if (r.dx > 0 || r.dy > 0) return;
      const lo = r.zNear, hi = r.zNear + OPEN;
      const jamb = HALF + 0.06;
      // The opening starts below street level, so how much of it can be seen
      // is set by the trench in front: the sight line grazing that trench's
      // near rim is the lowest the eye reaches. Without the clip the portal
      // spills out over the pavement as a black slab.
      g.save();
      {
        const a0 = P(-1.5, -jamb, 0), b0 = P(-1.5, jamb, 0);
        const ex = (b0[0] - a0[0]) * 200, ey = (b0[1] - a0[1]) * 200;
        const far = 4000;
        g.beginPath();
        g.moveTo(a0[0] - ex, a0[1] - ey);
        g.lineTo(b0[0] + ex, b0[1] + ey);
        g.lineTo(b0[0] + ex, b0[1] + ey - far);
        g.lineTo(a0[0] - ex, a0[1] - ey - far);
        g.closePath();
        g.clip();
      }
      // the reveal around the opening, then the opening itself
      quad(P(-0.5, -jamb, lo), P(-0.5, jamb, lo), P(-0.5, jamb, hi + 0.1), P(-0.5, -jamb, hi + 0.1),
           art.night ? "#22252c" : "#3a3e46");
      quad(P(-0.5, -HALF, lo), P(-0.5, HALF, lo), P(-0.5, HALF, hi), P(-0.5, -HALF, hi), "#07080b");
      // the floor of it catching what light gets in
      quad(P(-0.5, -HALF, lo), P(-0.5, HALF, lo), P(-0.34, HALF, lo - 0.08), P(-0.34, -HALF, lo - 0.08),
           "#15181e");
      // lintel band, and the hazard stripe painted on it
      quad(P(-0.5, -jamb, hi), P(-0.5, jamb, hi), P(-0.5, jamb, hi + 0.1), P(-0.5, -jamb, hi + 0.1),
           art.night ? "#4a4438" : "#6e6650");
      const a = P(-0.5, -jamb, hi + 0.055), b = P(-0.5, jamb, hi + 0.055);
      g.strokeStyle = art.night ? "#8a7a2c" : "#d8c24a";
      g.lineWidth = Math.max(1, 1.6 * z);
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      // a light over the door, and the glow it throws on the reveal
      const lamp = P(-0.5, 0, hi + 0.05);
      g.fillStyle = art.night ? "#ffd489" : "#f0e6c8";
      g.fillRect(lamp[0] - 1.6 * z, lamp[1] - 0.8 * z, 3.2 * z, 1.6 * z);
      g.restore();
      if (art.night) this.glow(lamp[0], lamp[1], 12 * z, "#ffcc77", 0.35);
      return;
    }

    const nl0 = P(-0.5, -HALF, r.zNear), nr0 = P(-0.5, HALF, r.zNear);
    const fl0 = P(0.5, -HALF, r.zFar), fr0 = P(0.5, HALF, r.zFar);
    if (this.rampBelow) {
      // Seen from the garage there is no street left to cut into and nothing
      // in front to hide behind: the ramp is a deck on skirts, running down
      // out of the ceiling to the floor it serves.
      for (const v of [-HALF, HALF]) {
        quad(P(-0.5, v, r.zNear), P(0.5, v, r.zFar), P(0.5, v, GARAGE_LEVEL), P(-0.5, v, GARAGE_LEVEL),
             art.night ? "#191c22" : "#282c33");
      }
      quad(nl0, nr0, fr0, fl0, art.night ? "#2b2f36" : "#464b53");
      g.strokeStyle = art.night ? "rgba(190,170,90,0.4)" : "rgba(228,208,110,0.5)";
      g.lineWidth = Math.max(1, 0.8 * z);
      for (let k = 0; k < 2; k++) {
        const u = -0.3 + k * 0.42;
        const h = r.zNear + (r.zFar - r.zNear) * (u + 0.5);
        const a2 = P(u, -HALF * 0.7, h), b2 = P(u + 0.14, 0, h), c2 = P(u, HALF * 0.7, h);
        g.beginPath(); g.moveTo(a2[0], a2[1]); g.lineTo(b2[0], b2[1]); g.lineTo(c2[0], c2[1]); g.stroke();
      }
      return;
    }
    // The trench. A hole in the ground shows only what fits inside its own
    // opening: a sight line grazing the near rim is the lowest thing the eye
    // can reach, so everything the deck and walls project below that rim is
    // behind the pavement in front and must not be painted over it. Clipping
    // to the rim is what makes the cut read as sunk rather than piled up.
    const rim: [number, number][] = [
      P(-0.5, -HALF, 0), P(0.5, -HALF, 0), P(0.5, HALF, 0), P(-0.5, HALF, 0),
    ];
    g.save();
    g.beginPath();
    g.moveTo(rim[0][0], rim[0][1]);
    for (let k = 1; k < 4; k++) g.lineTo(rim[k][0], rim[k][1]);
    g.closePath();
    g.clip();
    // the walls of the cut, then the deck over them: whichever walls face away
    // from the eye end up behind the deck, which is where they belong
    for (const v of [-HALF, HALF]) {
      quad(P(-0.5, v, 0), P(0.5, v, 0), P(0.5, v, r.zFar), P(-0.5, v, r.zNear),
           art.night ? "#191c22" : "#282c33");
    }
    quad(P(-0.5, -HALF, 0), P(-0.5, HALF, 0), P(-0.5, HALF, r.zNear), P(-0.5, -HALF, r.zNear),
         art.night ? "#20242b" : "#31353d");
    quad(nl0, nr0, fr0, fl0, art.night ? "#2b2f36" : "#464b53");
    // it gets darker the further under the street it goes
    for (let k = 0; k < 3; k++) {
      const u0 = -0.5 + k / 3, u1 = -0.5 + (k + 1) / 3;
      const h0 = r.zNear + (r.zFar - r.zNear) * (u0 + 0.5);
      const h1 = r.zNear + (r.zFar - r.zNear) * (u1 + 0.5);
      const shade = 0.1 + 0.16 * k - r.zNear * 0.35;
      quad(P(u0, -HALF, h0), P(u0, HALF, h0), P(u1, HALF, h1), P(u1, -HALF, h1),
           `rgba(0,0,0,${Math.max(0, Math.min(0.8, shade)).toFixed(3)})`);
    }
    // chevrons down the middle, fading as the deck drops away
    g.strokeStyle = art.night ? "rgba(190,170,90,0.4)" : "rgba(228,208,110,0.5)";
    g.lineWidth = Math.max(1, 0.8 * z);
    for (let k = 0; k < 2; k++) {
      const u = -0.3 + k * 0.42;
      const h = r.zNear + (r.zFar - r.zNear) * (u + 0.5);
      const a2 = P(u, -HALF * 0.7, h), b2 = P(u + 0.14, 0, h), c2 = P(u, HALF * 0.7, h);
      g.beginPath(); g.moveTo(a2[0], a2[1]); g.lineTo(b2[0], b2[1]); g.lineTo(c2[0], c2[1]); g.stroke();
    }
    g.restore();
    // the rim itself, so the edge of the cut in the pavement reads
    g.strokeStyle = art.night ? "#5c626c" : "#9aa1ac";
    g.lineWidth = Math.max(1, 0.9 * z);
    for (const v of [-HALF, HALF]) {
      const a2 = P(-0.5, v, 0), b2 = P(0.5, v, 0);
      g.beginPath(); g.moveTo(a2[0], a2[1]); g.lineTo(b2[0], b2[1]); g.stroke();
    }
  }

  private drawMetroEntrance(
    g: CanvasRenderingContext2D, r: MetroRamp,
    SX: (x: number, y: number) => number, SY: (x: number, y: number) => number, z: number,
    art: TileArt, time: number
  ): void {
    const m = r.steps[0], nxt = r.steps[1] ?? m;
    const dx = Math.sign(nxt.x - m.x), dy = Math.sign(nxt.y - m.y);   // the way down
    const P = (u: number, v: number, h: number): [number, number] => {
      // u runs down the ramp, v across it
      const wx = m.x + 0.5 + dx * u - dy * v;
      const wy = m.y + 0.5 + dy * u + dx * v;
      return [SX(wx, wy), SY(wx, wy) - h];
    };
    // the opening: the mouth tile is a hole, dark, with the first step showing
    const a = P(-0.5, -0.5, 0), b = P(0.5, -0.5, 0), c = P(0.5, 0.5, 0), d = P(-0.5, 0.5, 0);
    g.fillStyle = "#0c0f14";
    g.beginPath();
    g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(c[0], c[1]); g.lineTo(d[0], d[1]);
    g.closePath(); g.fill();
    // a couple of treads catching the light from below
    for (let k = 1; k <= 3; k++) {
      const t0 = P(-0.5 + k * 0.25, -0.45, k * 1.6 * z), t1 = P(-0.5 + k * 0.25, 0.45, k * 1.6 * z);
      g.strokeStyle = `rgba(120,150,170,${0.5 - k * 0.12})`;
      g.lineWidth = Math.max(1, z);
      g.beginPath(); g.moveTo(t0[0], t0[1]); g.lineTo(t1[0], t1[1]); g.stroke();
    }
    // rail round the three closed sides
    const rail = 7 * z;
    const post = (q: [number, number]) => {
      g.strokeStyle = art.night ? "#5a6472" : "#8b95a3";
      g.lineWidth = Math.max(1, 0.9 * z);
      g.beginPath(); g.moveTo(q[0], q[1]); g.lineTo(q[0], q[1] - rail); g.stroke();
    };
    const bar = (q: [number, number], w: [number, number]) => {
      g.strokeStyle = art.night ? "#6c7686" : "#9aa4b2";
      g.lineWidth = Math.max(1, 0.9 * z);
      g.beginPath();
      g.moveTo(q[0], q[1] - rail); g.lineTo(w[0], w[1] - rail);
      g.moveTo(q[0], q[1] - rail * 0.5); g.lineTo(w[0], w[1] - rail * 0.5);
      g.stroke();
      post(q); post(w);
    };
    bar(P(-0.5, -0.5, 0), P(0.5, -0.5, 0));
    bar(P(-0.5, 0.5, 0), P(0.5, 0.5, 0));
    bar(P(-0.5, -0.5, 0), P(-0.5, 0.5, 0));
    // the sign: a post at the near corner carrying the roundel
    const foot = P(-0.55, 0.62, 0);
    const H = 20 * z;
    g.fillStyle = art.night ? "#39414c" : "#59616c";
    g.fillRect(foot[0] - 0.9 * z, foot[1] - H, 1.8 * z, H);
    const cx2 = foot[0], cy2 = foot[1] - H - 5 * z;
    const rr = 5.6 * z;
    const pulse = art.night ? 0.75 + 0.25 * Math.sin(time * 2 + m.x) : 1;
    g.strokeStyle = `rgba(58,150,220,${pulse})`;
    g.lineWidth = Math.max(1.6, 2.2 * z);
    g.beginPath(); g.arc(cx2, cy2, rr, 0, Math.PI * 2); g.stroke();
    g.fillStyle = `rgba(228,238,248,${pulse})`;
    g.fillRect(cx2 - rr * 1.25, cy2 - rr * 0.30, rr * 2.5, rr * 0.60);
    if (art.night) this.glow(cx2, cy2, 15 * z, "#3a96dc", 0.45);
  }

  private drawPlatform(
    g: CanvasRenderingContext2D, p: PlatTile,
    SX: (x: number, y: number) => number, SY: (x: number, y: number) => number, z: number, art: TileArt
  ): void {
    const lift = p.level * STORY_H * z;
    // du runs along the track, dv across it; both 0..1 within this one tile
    const P = (du: number, dv: number): [number, number] => {
      const wx = p.axis === "v" ? p.x + dv : p.x + du;
      const wy = p.axis === "v" ? p.y + du : p.y + dv;
      return [SX(wx, wy), SY(wx, wy) - lift];
    };
    const a = P(0, 0), b = P(1, 0), c = P(1, 1), d = P(0, 1);
    // the slab, with a skirt down its two camera-facing edges for thickness
    const skirt = 6 * z;
    g.fillStyle = art.night ? "#232830" : "#3d434c";
    for (const [q, r] of [[b, c], [c, d]] as [number, number][][]) {
      g.beginPath();
      g.moveTo(q[0], q[1]); g.lineTo(r[0], r[1]);
      g.lineTo(r[0], r[1] + skirt); g.lineTo(q[0], q[1] + skirt);
      g.closePath(); g.fill();
    }
    g.fillStyle = art.night ? "#2b3038" : "#4a515c";
    g.beginPath();
    g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(c[0], c[1]); g.lineTo(d[0], d[1]);
    g.closePath(); g.fill();
    g.strokeStyle = art.night ? "#3a414b" : "#5c6470";
    g.lineWidth = Math.max(1, 0.7 * z);
    g.stroke();

    const post = (q: [number, number], h: number) => {
      g.strokeStyle = art.night ? "#5a6472" : "#818b99";
      g.lineWidth = Math.max(1, 0.9 * z);
      g.beginPath(); g.moveTo(q[0], q[1]); g.lineTo(q[0], q[1] - h); g.stroke();
    };
    const rail = (q: [number, number], r: [number, number], h: number) => {
      g.strokeStyle = art.night ? "#5a6472" : "#818b99";
      g.lineWidth = Math.max(1, 0.9 * z);
      g.beginPath();
      g.moveTo(q[0], q[1] - h); g.lineTo(r[0], r[1] - h);
      g.moveTo(q[0], q[1] - h * 0.5); g.lineTo(r[0], r[1] - h * 0.5);
      g.stroke();
      post(q, h); post(r, h);
    };
    const H = 8 * z;
    if (p.dv === 0) {
      // the track edge: no railing to stand between the squad and the train,
      // just the painted line you are told not to cross
      g.strokeStyle = art.night ? "#8a7a24" : "#d8c341";
      g.lineWidth = Math.max(1, 1.6 * z);
      const e0 = P(0, 0.16), e1 = P(1, 0.16);
      g.beginPath(); g.moveTo(e0[0], e0[1]); g.lineTo(e1[0], e1[1]); g.stroke();
    }
    if (p.dv === PLATFORM_WIDE - 1) rail(P(0, 1), P(1, 1), H);
    if (p.du === 0) rail(P(0, 0), P(0, 1), H);
    if (p.du === PLATFORM_LONG - 1) rail(P(1, 0), P(1, 1), H);
    // lamps down the back edge
    if (p.dv === PLATFORM_WIDE - 1 && p.du % 3 === 1) {
      const q = P(0.5, 0.8);
      g.fillStyle = art.night ? "#3c434e" : "#5a626e";
      g.fillRect(q[0] - 0.8 * z, q[1] - 15 * z, 1.6 * z, 15 * z);
      g.fillStyle = art.night ? "#ffe9a8" : "#d8d2a0";
      g.fillRect(q[0] - 2 * z, q[1] - 17 * z, 4 * z, 2.4 * z);
      this.glow(q[0], q[1] - 15 * z, 14 * z, "#ffe9a8", art.night ? 0.45 : 0.1);
    }
  }

  private drawFireStair(
    g: CanvasRenderingContext2D, fs: StairRun,
    SX: (x: number, y: number) => number, SY: (x: number, y: number) => number, z: number
  ): void {
    // A fire escape is half a tile deep and two tiles long, laid along the wall
    // it serves. Two flights, each half the depth, run the full length side by
    // side and offset from one another by that half tile; a landing spanning
    // both caps each flight so an agent can turn the corner onto the next.
    // Giving each flight the whole two-tile run is what keeps its pitch
    // walkable - over a single tile it climbs a storey almost vertically.
    const ax = fs.dx, ay = fs.dy;                     // toward the wall it serves
    const ux = -ay, uy = ax;                          // along the wall face
    const cx = fs.x + 0.5, cy = fs.y + 0.5;
    const RUN = fs.run;                               // tiles of length
    const INSET = 0.05 / RUN;                         // clear of the ends
    const LAND = 0.34 / RUN;                          // share of the run a landing takes
    // t runs the length of the footprint, v out from the wall; both 0..1
    const uStart = fs.side < 0 ? 0.5 - RUN : -0.5;
    const wx = (t: number, v: number) => cx + ax * (0.5 - v) + ux * (uStart + t * RUN);
    const wy = (t: number, v: number) => cy + ay * (0.5 - v) + uy * (uStart + t * RUN);
    const P = (t: number, v: number, h: number): [number, number] => {
      const x = wx(t, v), y = wy(t, v);
      return [SX(x, y), SY(x, y) - (fs.base + h) * STORY_H * z];
    };
    const depth = (t: number, v: number) => wx(t, v) + wy(t, v);
    const lw = Math.max(1, 0.9 * z);
    const rail = 7 * z;
    const THICK = 0.12 * STORY_H * z;   // decks are steel plate on a beam, not paper
    // How far up this stair the horizontal cross-section lets us see. Anything
    // above the plane is taken away, and whatever the plane cuts through shows
    // its section in black, exactly as a sliced building does.
    const lim = this.secOn ? this.secAt - fs.base : Infinity;
    if (lim <= 0.01) return;
    // A station stair climbs 2.125 storeys, so its last flight is a stub. Cap
    // every flight at whichever comes first, the top of the stair or the cut.
    const top = Math.min(fs.h, lim);
    const RAIL_UP = rail / (STORY_H * z);   // the railing's own height, in storeys

    // A deck is an extruded box, not a bare quad: without the skirt down its
    // near edges the whole flight reads as a sheet of card from any angle that
    // shows its underside.
    const slab = (pts: [number, number][], fill: string) => {
      // the far edges' skirts fall under the deck itself, so paint those first
      // and let the near ones, which are the visible ones, land on top
      const edges = [0, 1, 2, 3].sort(
        (a, b) => (pts[a][1] + pts[(a + 1) % 4][1]) - (pts[b][1] + pts[(b + 1) % 4][1]));
      for (const e of edges) {
        const a = pts[e], b = pts[(e + 1) % 4];
        g.beginPath();
        g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]);
        g.lineTo(b[0], b[1] + THICK); g.lineTo(a[0], a[1] + THICK);
        g.closePath();
        // the side you see along the run catches less light than the end grain
        g.fillStyle = e % 2 === 0 ? "#3a414b" : "#2b313a";
        g.fill();
        g.strokeStyle = "#191d23"; g.lineWidth = lw * 0.7; g.stroke();
      }
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let k = 1; k < pts.length; k++) g.lineTo(pts[k][0], pts[k][1]);
      g.closePath();
      g.fillStyle = fill; g.fill();
      g.strokeStyle = "#20242b"; g.lineWidth = lw * 0.8; g.stroke();
    };
    // a railing reads as a railing only if it has uprights along it
    const handrail = (a: [number, number], b: [number, number]) => {
      g.strokeStyle = "#4a525f"; g.lineWidth = lw * 0.7;
      g.beginPath();
      for (let k = 0.18; k < 0.95; k += 0.22) {
        const mx = a[0] + (b[0] - a[0]) * k, my = a[1] + (b[1] - a[1]) * k;
        g.moveTo(mx, my); g.lineTo(mx, my - rail);
      }
      g.stroke();
      g.strokeStyle = "#5d6675"; g.lineWidth = lw * 1.4;
      g.beginPath();
      g.moveTo(a[0], a[1]); g.lineTo(a[0], a[1] - rail);
      g.moveTo(b[0], b[1]); g.lineTo(b[0], b[1] - rail);
      g.stroke();
      g.lineWidth = lw;
      g.beginPath();
      g.moveTo(a[0], a[1] - rail); g.lineTo(b[0], b[1] - rail);
      g.moveTo(a[0], a[1] - rail * 0.5); g.lineTo(b[0], b[1] - rail * 0.5);
      g.stroke();
    };

    // every piece is collected first, then painted back to front: the two
    // flights sit at different distances from the camera and would otherwise
    // overlap in the wrong order
    const parts: { d: number; h: number; draw: () => void }[] = [];

    // stanchions stand on the outboard side only - the wall side is bolted to
    // the building, and posts there just clutter the face
    for (const [pt, pv] of [[INSET, 0.95], [1 - INSET, 0.95]]) {
      parts.push({ d: depth(pt, pv), h: -1, draw: () => {
        // a stanchion is a box section, so give it a lit face and a shaded one
        const b = P(pt, pv, 0), t = P(pt, pv, top);
        const w = Math.max(1.6, 2.6 * z);
        g.fillStyle = "#272c34";
        g.fillRect(t[0] - w / 2, t[1], w, b[1] - t[1]);
        g.fillStyle = "#6f7887";
        g.fillRect(t[0] - w / 2, t[1], w * 0.42, b[1] - t[1]);
        g.fillStyle = "#141820";
        g.fillRect(t[0] + w / 2 - w * 0.18, t[1], w * 0.18, b[1] - t[1]);
        if (lim < fs.h) { g.fillStyle = "#000"; g.fillRect(t[0] - w / 2, t[1] - lw, w, lw * 2); }
      } });
    }

    for (let lvl = 0; lvl < fs.h; lvl++) {
      // flights alternate half and direction, so each one starts where the
      // landing below it ended
      const even = lvl % 2 === 0;
      const vLo = even ? 0.05 : 0.5, vHi = even ? 0.5 : 0.95;
      const tFoot = even ? INSET : 1 - INSET;
      const tHead = even ? 1 - INSET - LAND : INSET + LAND;
      const outV = even ? 0.5 : 0.95;                 // the flight's free side
      const h0 = lvl, h1 = lvl + 1;
      if (h0 >= top) break;                          // this flight is above the cut
      // a flight climbs one storey over its run, so the fraction of the run
      // left below the ceiling is just how much of that storey is left
      const keep = Math.min(1, top - h0);
      const sliced = lim < fs.h && h0 + keep >= lim - 1e-6;
      const tEnd = tFoot + (tHead - tFoot) * keep;
      const hEnd = h0 + keep;
      parts.push({ d: (depth(tFoot, vLo) + depth(tEnd, vHi)) / 2, h: lvl, draw: () => {
        slab([P(tFoot, vLo, h0), P(tFoot, vHi, h0), P(tEnd, vHi, hEnd), P(tEnd, vLo, hEnd)], "#79828f");
        g.strokeStyle = "#3b424d"; g.lineWidth = Math.max(0.8, lw * 0.7);
        g.beginPath();
        for (let k = 0.06; k < keep - 0.02; k += 0.075) {
          const t = tFoot + (tHead - tFoot) * k;
          const p0 = P(t, vLo, h0 + k), p1 = P(t, vHi, h0 + k);
          g.moveTo(p0[0], p0[1]); g.lineTo(p1[0], p1[1]);
        }
        g.stroke();
        // the railing stands proud of the deck, so it meets the plane first
        const rk = Math.min(keep, lim - RAIL_UP - h0);
        if (rk > 0.02) {
          const tR = tFoot + (tHead - tFoot) * rk;
          handrail(P(tFoot, outV, h0), P(tR, outV, h0 + rk));
        }
        if (sliced) {                                // the cut face itself
          const a = P(tEnd, vLo, hEnd), b = P(tEnd, vHi, hEnd);
          g.beginPath();
          g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]);
          g.lineTo(b[0], b[1] + THICK); g.lineTo(a[0], a[1] + THICK);
          g.closePath();
          g.fillStyle = "#000"; g.fill();
        }
      } });

      if (h1 > top + 1e-6) break;                    // and so is its landing
      const lt0 = even ? 1 - INSET - LAND : INSET, lt1 = even ? 1 - INSET : INSET + LAND;
      parts.push({ d: (depth(lt0, 0.05) + depth(lt1, 0.95)) / 2, h: lvl + 0.5, draw: () => {
        slab([P(lt0, 0.05, h1), P(lt0, 0.95, h1), P(lt1, 0.95, h1), P(lt1, 0.05, h1)], "#98a2b0");
        if (h1 + RAIL_UP <= lim) handrail(P(lt0, 0.95, h1), P(lt1, 0.95, h1));
      } });
    }

    parts.sort((a, b) => a.d - b.d || a.h - b.h);
    for (const part of parts) part.draw();
  }

  // tile-edge fence: posts + rails (park) or hazard railing (pit rim)
  private drawFence(
    g: CanvasRenderingContext2D, f: FenceEdge, art: TileArt,
    SX: (x: number, y: number) => number, SY: (x: number, y: number) => number, z: number
  ): void {
    // edge endpoints (tile corner coordinates)
    let ax: number, ay: number, bx: number, by: number;
    switch (f.edge) {
      case 0: ax = f.x; ay = f.y; bx = f.x; by = f.y + 1; break;       // NW
      case 1: ax = f.x; ay = f.y; bx = f.x + 1; by = f.y; break;       // NE
      case 2: ax = f.x + 1; ay = f.y; bx = f.x + 1; by = f.y + 1; break; // SE
      default: ax = f.x; ay = f.y + 1; bx = f.x + 1; by = f.y + 1;     // SW
    }
    const x0 = SX(ax, ay), yy0 = SY(ax, ay), x1 = SX(bx, by), yy1 = SY(bx, by);
    const hgt = (f.hazard ? 6 : 8) * z;
    const postCol = f.hazard ? "#26262c" : (art.night ? "#3c444c" : "#4a545c");
    const railCol = f.hazard ? "#e0c020" : (art.night ? "#5a666e" : "#6e7a82");
    g.lineWidth = Math.max(1, z * 0.8);
    // posts
    g.strokeStyle = postCol;
    g.beginPath();
    for (const t of [0.12, 0.5, 0.88]) {
      const px = x0 + (x1 - x0) * t, py = yy0 + (yy1 - yy0) * t;
      g.moveTo(px, py);
      g.lineTo(px, py - hgt);
    }
    g.stroke();
    // top rail
    g.strokeStyle = railCol;
    g.beginPath();
    g.moveTo(x0, yy0 - hgt); g.lineTo(x1, yy1 - hgt);
    g.stroke();
    // second rail
    g.strokeStyle = f.hazard ? "#8a7a18" : postCol;
    g.beginPath();
    g.moveTo(x0, yy0 - hgt * 0.5); g.lineTo(x1, yy1 - hgt * 0.5);
    g.stroke();
  }

  private drawPylon(
    g: CanvasRenderingContext2D, e: Entity, art: TileArt,
    SX: (x: number, y: number) => number, SY: (x: number, y: number) => number, z: number
  ): void {
    const sx = SX(e.x, e.y), sy = SY(e.x, e.y);
    const top = sy - TRAIN_ELEV * z;
    g.fillStyle = "rgba(0,0,0,0.35)";
    g.beginPath(); g.ellipse(sx, sy, 5 * z, 2.2 * z, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = art.night ? "#2e323c" : "#4c525c";
    g.fillRect(sx - 1.8 * z, top + 4 * z, 3.6 * z, TRAIN_ELEV * z - 4 * z);
    g.fillStyle = art.night ? "#3c424e" : "#5c646e";
    g.fillRect(sx - 1.8 * z, top + 4 * z, 1.2 * z, TRAIN_ELEV * z - 4 * z);
    // cross arm under the deck
    g.fillStyle = art.night ? "#343a46" : "#545c66";
    g.fillRect(sx - 9 * z, top + 3 * z, 18 * z, 2.5 * z);
  }

  private drawDeck(
    g: CanvasRenderingContext2D, e: Entity, art: TileArt,
    SX: (x: number, y: number) => number, SY: (x: number, y: number) => number, z: number, time: number
  ): void {
    const cxp = SX(e.x, e.y), cyp = SY(e.x, e.y) - TRAIN_ELEV * z;
    // direction of one tile step along the line, in screen px
    const dxs = e.deckAxis === "v" ? isoX(0, 1) * z : isoX(1, 0) * z;
    const dys = e.deckAxis === "v" ? isoY(0, 1) * z : isoY(1, 0) * z;
    // width basis = the other iso axis, scaled to deck width
    const wxs = (e.deckAxis === "v" ? isoX(1, 0) : isoX(0, 1)) * z * 0.34;
    const wys = (e.deckAxis === "v" ? isoY(1, 0) : isoY(0, 1)) * z * 0.34;
    const hx = dxs / 2, hy = dys / 2;
    // top slab
    g.fillStyle = art.night ? "#39404c" : "#5a626e";
    g.beginPath();
    g.moveTo(cxp - hx - wxs, cyp - hy - wys);
    g.lineTo(cxp + hx - wxs, cyp + hy - wys);
    g.lineTo(cxp + hx + wxs, cyp + hy + wys);
    g.lineTo(cxp - hx + wxs, cyp - hy + wys);
    g.closePath(); g.fill();
    // front skirt (thickness)
    const skirt = 5 * z;
    g.fillStyle = art.night ? "#262b34" : "#454c56";
    g.beginPath();
    g.moveTo(cxp - hx + wxs, cyp - hy + wys);
    g.lineTo(cxp + hx + wxs, cyp + hy + wys);
    g.lineTo(cxp + hx + wxs, cyp + hy + wys + skirt);
    g.lineTo(cxp - hx + wxs, cyp - hy + wys + skirt);
    g.closePath(); g.fill();
    // rails
    g.strokeStyle = art.night ? "#141821" : "#31363e";
    g.lineWidth = Math.max(1, z * 0.7);
    g.beginPath();
    g.moveTo(cxp - hx - wxs * 0.45, cyp - hy - wys * 0.45);
    g.lineTo(cxp + hx - wxs * 0.45, cyp + hy - wys * 0.45);
    g.moveTo(cxp - hx + wxs * 0.45, cyp - hy + wys * 0.45);
    g.lineTo(cxp + hx + wxs * 0.45, cyp + hy + wys * 0.45);
    g.stroke();
    // guide light
    if (art.night && ((e.x + e.y) & 3) === 0) {
      const blink = 0.55 + 0.45 * Math.sin(time * 3 + e.x + e.y);
      g.fillStyle = `rgba(60,220,255,${blink})`;
      g.fillRect(cxp + wxs - z, cyp + wys - z, 2 * z, 2 * z);
    }
  }

  private drawTrain(
    g: CanvasRenderingContext2D, t: TrainSeg, art: TileArt,
    SX: (x: number, y: number) => number, SY: (x: number, y: number) => number, z: number
  ): void {
    const night = art.night;
    const fx = Math.cos(t.angle), fy = Math.sin(t.angle);
    const rx = -fy, ry = fx;
    const px = (df: number, dr: number, lift: number): [number, number] => {
      const wx = t.wx + fx * df + rx * dr, wy = t.wy + fy * df + ry * dr;
      return [SX(wx, wy), SY(wx, wy) - lift];
    };
    const lit = t.flash ? new Path2D() : null;
    const quad = (pts: [number, number][], col: string) => {
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.closePath();
      g.fill();
      if (lit) {
        lit.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) lit.lineTo(pts[i][0], pts[i][1]);
        lit.closePath();
      }
    };
    const shade = (hex: string, f: number): string => {
      const n = parseInt(hex.slice(1), 16);
      const r = Math.min(255, (((n >> 16) & 255) * f) | 0);
      const gg = Math.min(255, (((n >> 8) & 255) * f) | 0);
      const b = Math.min(255, ((n & 255) * f) | 0);
      return `rgb(${r},${gg},${b})`;
    };

    const L = 0.86, W = 0.3;
    const elev = t.lift * z;
    const h0 = elev + 2.5 * z;   // maglev gap above the deck
    const h1 = elev + 13 * z;    // roof
    const body = night ? "#46525e" : "#828c98";

    // shadow cast onto the deck
    quad([px(L, W * 1.15, elev + 0.5 * z), px(L, -W * 1.15, elev + 0.5 * z), px(-L, -W * 1.15, elev + 0.5 * z), px(-L, W * 1.15, elev + 0.5 * z)], "rgba(0,0,0,0.3)");

    // body box: back-to-front side faces, then the roof
    const base: [number, number][] = [px(L, W, h0), px(L, -W, h0), px(-L, -W, h0), px(-L, W, h0)];
    const top: [number, number][] = [px(L, W, h1), px(L, -W, h1), px(-L, -W, h1), px(-L, W, h1)];
    const centerY = (base[0][1] + base[2][1]) / 2;
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0]]
      .map((e) => ({ e, midY: (base[e[0]][1] + base[e[1]][1]) / 2 }))
      .sort((a, b) => a.midY - b.midY);
    for (const { e, midY } of edges) {
      quad([base[e[0]], base[e[1]], top[e[1]], top[e[0]]], shade(body, midY > centerY ? 0.85 : 0.55));
    }
    quad(top, shade(body, 1.15));
    // roof spine
    quad([px(L * 0.8, W * 0.35, h1 + 0.1), px(L * 0.8, -W * 0.35, h1 + 0.1), px(-L * 0.8, -W * 0.35, h1 + 0.1), px(-L * 0.8, W * 0.35, h1 + 0.1)], shade(body, 0.9));

    // lit window band on the camera-facing long sides
    const winCol = night ? "#9fe8ff" : "#d5e6ee";
    const sepCol = shade(body, 0.6);
    for (const dr of [W, -W]) {
      const midY = px(0, dr, h0)[1];
      if (midY <= centerY) continue; // back side, hidden
      quad([px(L * 0.8, dr, h0 + 4 * z), px(-L * 0.8, dr, h0 + 4 * z), px(-L * 0.8, dr, h0 + 8.5 * z), px(L * 0.8, dr, h0 + 8.5 * z)], winCol);
      for (let f = -L * 0.72; f < L * 0.75; f += 0.3) {
        quad([px(f, dr, h0 + 4 * z), px(f + 0.06, dr, h0 + 4 * z), px(f + 0.06, dr, h0 + 8.5 * z), px(f, dr, h0 + 8.5 * z)], sepCol);
      }
    }
    // nose light on the lead car
    if (t.head) {
      quad([px(L, W * 0.4, h0 + 3 * z), px(L, -W * 0.4, h0 + 3 * z), px(L, -W * 0.4, h0 + 6 * z), px(L, W * 0.4, h0 + 6 * z)], "#fff8c8");
      const np = px(L, 0, h0 + 4.5 * z);
      this.glow(np[0], np[1], 9 * z, "#fff8c8", night ? 0.5 : 0.15);
    }
    if (night) {
      const sx = SX(t.wx, t.wy), sy = SY(t.wx, t.wy) - elev;
      g.globalCompositeOperation = "lighter";
      const gr = g.createRadialGradient(sx, sy, 0, sx, sy, 20 * z);
      gr.addColorStop(0, "rgba(120,200,255,0.12)");
      gr.addColorStop(1, "rgba(120,200,255,0)");
      g.fillStyle = gr;
      g.fillRect(sx - 20 * z, sy - 20 * z, 40 * z, 40 * z);
      g.globalCompositeOperation = "source-over";
    }
    this.flashOver(g, lit, t.flash, t.flashOk);
  }

  // Ring stacks for the car bodywork and canopy: {h} is the fraction of the
  // part's height, {s} the plan scale at that height. More segments than the
  // eye can count is the point - the silhouette has to read as a curve.
  private static readonly HULL_SEGS = 20;
  private static readonly HULL_RINGS = [
    { h: 0, s: 0.7 }, { h: 0.22, s: 0.93 }, { h: 0.52, s: 1 }, { h: 0.82, s: 0.93 }, { h: 1, s: 0.7 },
  ];
  private static readonly CAB_SEGS = 16;
  private static readonly CAB_RINGS = [
    { h: 0, s: 1 }, { h: 0.44, s: 0.94 }, { h: 0.78, s: 0.78 }, { h: 1, s: 0.46 },
  ];

  private drawCar(
    g: CanvasRenderingContext2D, c: Car, art: TileArt,
    SX: (x: number, y: number) => number, SY: (x: number, y: number) => number, z: number, time: number
  ): void {
    const night = isNight(art.weather);
    const m = CAR_MODELS[c.model % CAR_MODELS.length];
    const shade = (hex: string, f: number): string => {
      const n = parseInt(hex.slice(1), 16);
      const r = Math.min(255, (((n >> 16) & 255) * f) | 0);
      const gg = Math.min(255, (((n >> 8) & 255) * f) | 0);
      const b = Math.min(255, ((n & 255) * f) | 0);
      return `rgb(${r},${gg},${b})`;
    };
    const fx = Math.cos(c.angle), fy = Math.sin(c.angle);
    const rx = -fy, ry = fx;
    // every height in this body is scaled by the model's own fit, so a chassis
    // that would otherwise stand taller than the storey it parks under is
    // squashed as one piece rather than clipped somewhere in the middle
    const px = (df: number, dr: number, lift: number): [number, number] => {
      const wx = c.x + fx * df + rx * dr, wy = c.y + fy * df + ry * dr;
      return [SX(wx, wy), SY(wx, wy) - lift * m.vfit - c.z * STORY_H * z];
    };
    const lit = c.flash ? new Path2D() : null;
    const quad = (pts: [number, number][], col: string) => {
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.closePath();
      g.fill();
      if (lit) {
        lit.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) lit.lineTo(pts[i][0], pts[i][1]);
        lit.closePath();
      }
    };
    // extrude a convex footprint (body-space points) between two heights;
    // side brightness rolls smoothly toward the camera for a rounded hull
    const extrude = (pts: [number, number][], h0: number, h1: number, col: string, topCol: string | null) => {
      const base = pts.map(([df, dr]) => px(df, dr, h0));
      const top = pts.map(([df, dr]) => px(df, dr, h1));
      const n = pts.length;
      let minY = 1e9, maxY = -1e9;
      for (const p of base) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
      const span = Math.max(1, maxY - minY);
      const order: { i: number; midY: number }[] = [];
      for (let i = 0; i < n; i++) order.push({ i, midY: (base[i][1] + base[(i + 1) % n][1]) / 2 });
      order.sort((a, b) => a.midY - b.midY);
      for (const { i, midY } of order) {
        const j = (i + 1) % n;
        const t = (midY - minY) / span; // 0 back .. 1 camera-facing
        quad([base[i], base[j], top[j], top[i]], shade(col, 0.5 + 0.42 * t));
      }
      if (topCol) quad(top, topCol);
    };
    // Stack rings of a plan into a solid. Each ring sits at its own height and
    // is drawn at its own scale, so the surface curves in two directions; the
    // segments of one column are drawn together, columns back to front, and
    // brightness rolls both across the beam and up the ring stack. With enough
    // segments the facets disappear and the body reads as moulded, not folded.
    const loft = (
      rings: { h: number; s: number }[], segs: number,
      plan: (segs: number, sc: number) => [number, number][],
      base: number, height: number, col: string, topCol: string | null,
      // Height added per point from where it sits along the body. This is what
      // turns a slab into a wedge - a flat deck from nose to tail is the single
      // thing that made every one of these read as a boat with a cabin on it.
      ramp?: (df: number, up: number) => number
    ) => {
      const pts = rings.map((r) => plan(segs, r.s).map(([df, dr]) =>
        px(df, dr, base + r.h * height + (ramp ? ramp(df, r.h) : 0))));
      const foot = pts[0];
      let minY = 1e9, maxY = -1e9;
      for (const p of foot) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
      const span = Math.max(1, maxY - minY);
      const order: { i: number; t: number }[] = [];
      for (let i = 0; i < segs; i++) {
        order.push({ i, t: ((foot[i][1] + foot[(i + 1) % segs][1]) / 2 - minY) / span });
      }
      order.sort((a, b) => a.t - b.t);
      const top = pts[pts.length - 1];
      for (const { i, t } of order) {
        const j = (i + 1) % segs;
        const across = 0.46 + 0.5 * t;                // 0 back .. 1 camera-facing
        for (let b = 0; b < pts.length - 1; b++) {
          const up = 0.78 + 0.4 * (b / Math.max(1, pts.length - 2)); // sill dark, deck bright
          quad([pts[b][i], pts[b][j], pts[b + 1][j], pts[b + 1][i]], shade(col, across * up));
        }
      }
      if (topCol) quad(top, topCol);
      // rim light where the crown turns away: the giveaway of a curved panel
      g.strokeStyle = shade(col, 1.5);
      g.globalAlpha = 0.35;
      g.lineWidth = Math.max(1, 0.6 * z);
      g.beginPath();
      g.moveTo(top[0][0], top[0][1]);
      for (let i2 = 1; i2 < top.length; i2++) g.lineTo(top[i2][0], top[i2][1]);
      g.closePath();
      g.stroke();
      g.globalAlpha = 1;
    };

    // ---- shadow, oriented along the projected body axis ----
    const L = m.L, W = m.W;
    const sx = SX(c.x, c.y), sy = SY(c.x, c.y) - c.z * STORY_H * z;
    const nose = px(L, 0, 0), tail = px(-L, 0, 0);
    const bodyAngle = Math.atan2(nose[1] - tail[1], nose[0] - tail[0]);
    const bodyLen = Math.hypot(nose[0] - tail[0], nose[1] - tail[1]);
    g.fillStyle = "rgba(0,0,0,0.45)";
    g.beginPath();
    g.ellipse(sx, sy, bodyLen * 0.6, 7 * z, bodyAngle, 0, Math.PI * 2);
    g.fill();

    if (c.state === "wreck") {
      // A burnt-out car, not a lump: it keeps the chassis it had, at the size
      // it had, with the panels buckled over it. Everything is seeded off the
      // car's id so the wreckage holds still frame to frame.
      let sd = (c.id * 2654435761) >>> 0;
      const rnd = () => { sd = (sd * 1664525 + 1013904223) >>> 0; return sd / 4294967296; };
      const SOOT = "#131315", CHAR = "#1d1a1a", RUST = "#332119", BARE = "#3a3a40";

      // scorch on the tarmac, wider than the body's own shadow above
      g.fillStyle = "rgba(0,0,0,0.5)";
      g.beginPath();
      g.ellipse(sx, sy, bodyLen * 0.62, 7.5 * z, bodyAngle, 0, Math.PI * 2);
      g.fill();

      // small stuff blown clear: glass, trim, a wheel that came off. Kept close
      // so the wreck still reads as one car rather than a scatter of junk.
      const bits: { df: number; dr: number; s: number; h: number; col: string }[] = [];
      for (let i = 0; i < 7; i++) {
        // kept within the car's own outline: a wreck fills the space the car
        // did, so nothing is thrown far enough to widen the silhouette
        const a = rnd() * Math.PI * 2, rr = 0.7 + rnd() * 0.32;
        bits.push({ df: Math.cos(a) * rr * L, dr: Math.sin(a) * rr * W * 1.35,
                    s: 0.05 + rnd() * 0.08, h: (0.4 + rnd() * 1.0) * z,
                    col: rnd() > 0.55 ? SOOT : RUST });
      }
      bits.sort((p2, q2) => (p2.df + p2.dr) - (q2.df + q2.dr));
      for (const b of bits) {
        const o = b.s;
        extrude([[b.df + o, b.dr + o], [b.df + o, b.dr - o], [b.df - o, b.dr - o], [b.df - o, b.dr + o]],
                0, b.h, b.col, "#2a2622");
      }

      // ---- the car itself, at its own footprint ----
      // The wreck occupies the volume the car did: same plan, same standing
      // height, taken from the model's own hull and roof rather than guessed.
      const wlift = 2 * z, wHull = m.hull * z, wTop = m.cabH * z;
      // burnt tyres at the four corners, sitting under the body
      for (const [wf, ws] of [[0.62, 1], [0.62, -1], [-0.62, 1], [-0.62, -1]] as [number, number][]) {
        const tf = L * wf, tr = W * ws * 0.94;
        extrude([[tf + 0.16 * L, tr + 0.1 * W], [tf + 0.16 * L, tr - 0.1 * W],
                 [tf - 0.16 * L, tr - 0.1 * W], [tf - 0.16 * L, tr + 0.1 * W]],
                0, wlift * 1.3, "#0d0d0e", "#17171a");
      }
      // the floor pan: the full plan of the car, scorched, sitting on its rims
      const pan: [number, number][] = [
        [L * 0.98, W * 0.42], [L * 0.86, W * 0.86], [-L * 0.86, W * 0.9],
        [-L * 0.98, W * 0.4], [-L * 0.98, -W * 0.4], [-L * 0.86, -W * 0.9],
        [L * 0.86, -W * 0.86], [L * 0.98, -W * 0.42],
      ];
      extrude(pan, wlift * 0.5, wlift + wHull * 0.8, CHAR, "#221f1f");
      // buckled body panels over it: two masses inside the footprint, of
      // different heights, on a jagged plan - the car crushed, not replaced
      const jag = (sc: number, ox: number, oy: number, lo: number, hi: number): [number, number][] => {
        const p2: [number, number][] = [];
        const n = 10;
        for (let k = 0; k < n; k++) {
          const th = (k / n) * Math.PI * 2;
          const rl = L * sc * (lo + rnd() * (hi - lo)), rw = W * sc * (lo + rnd() * (hi - lo)) * 1.05;
          p2.push([Math.cos(th) * rl + ox, Math.sin(th) * rw + oy]);
        }
        return p2;
      };
      extrude(jag(1.0, 0, 0, 0.86, 1.0), wlift + wHull * 0.55,
              wlift + wHull + (wTop - wHull) * 0.5, SOOT, "#242024");
      // the cabin, collapsed and canted over, still standing to the roofline
      const cant = (rnd() - 0.5) * 0.24 * L, cants = (rnd() - 0.5) * 0.36 * W;
      extrude(jag(0.56, cant, cants, 0.8, 1.05), wlift + wHull + (wTop - wHull) * 0.35,
              wlift + wTop * (0.9 + rnd() * 0.14), "#0e0e10", "#1f1c20");

      // exposed ribs where the roof tore off: bare spars across the shell
      g.strokeStyle = BARE;
      g.lineWidth = Math.max(1, 0.7 * z);
      for (let k = 0; k < 4; k++) {
        const f = -0.55 + k * 0.36;
        const rh = wlift + wHull + (wTop - wHull) * (0.45 + rnd() * 0.4);
        const a2 = px(L * f, -W * 0.75, rh);
        const b2 = px(L * f + 0.1 * L, W * 0.75, rh);
        g.beginPath(); g.moveTo(a2[0], a2[1]); g.lineTo(b2[0], b2[1]); g.stroke();
      }
      // a door hanging open off one flank, and the bumper torn half away
      const ds = rnd() > 0.5 ? 1 : -1;
      const dTop = wlift + wHull + (wTop - wHull) * 0.75;
      quad([px(-0.1 * L, ds * W * 0.95, wlift + wHull * 0.7), px(0.42 * L, ds * W * 1.25, wlift + wHull * 0.6),
            px(0.42 * L, ds * W * 1.25, dTop), px(-0.1 * L, ds * W * 0.95, dTop)], "#111113");
      quad([px(-0.1 * L, ds * W * 0.95, wlift + wHull * 0.7), px(0.42 * L, ds * W * 1.25, wlift + wHull * 0.6),
            px(0.42 * L, ds * W * 1.2, wlift + wHull * 0.95), px(-0.1 * L, ds * W * 0.9, wlift + wHull * 1.05)], "#2c2622");
      quad([px(L * 0.99, -W * 0.5, wlift * 0.7), px(L * 1.02, W * 0.2, wlift * 0.5),
            px(L * 1.02, W * 0.2, wHull * 0.8), px(L * 0.99, -W * 0.5, wHull * 0.9)], "#26221e");

      // rust and bare-metal patches burned through the soot
      for (let k = 0; k < 5; k++) {
        const pf = (rnd() - 0.5) * 1.5 * L, ps2 = (rnd() - 0.5) * 1.5 * W;
        const w2 = (0.08 + rnd() * 0.14) * L, h2 = (0.1 + rnd() * 0.2) * W;
        const hh = wlift + wHull * (0.85 + rnd() * 0.5);
        quad([px(pf - w2, ps2 - h2, hh), px(pf + w2, ps2 - h2, hh),
              px(pf + w2, ps2 + h2, hh), px(pf - w2, ps2 + h2, hh)],
             rnd() > 0.5 ? RUST : "#2a2a2f");
      }

      // the wound at the core still glowing, breathing with the fire
      const glow = 0.55 + 0.45 * Math.sin(time * 7.3 + c.id * 1.7);
      g.globalCompositeOperation = "lighter";
      const gp = px(0, 0, wlift + wHull);
      const gr = g.createRadialGradient(gp[0], gp[1], 0, gp[0], gp[1], 12 * z);
      gr.addColorStop(0, `rgba(255,110,30,${(0.3 + 0.28 * glow).toFixed(3)})`);
      gr.addColorStop(0.5, `rgba(200,50,15,${(0.15 + 0.1 * glow).toFixed(3)})`);
      gr.addColorStop(1, "rgba(200,50,15,0)");
      g.fillStyle = gr;
      g.fillRect(gp[0] - 12 * z, gp[1] - 12 * z, 24 * z, 24 * z);
      g.globalCompositeOperation = "source-over";
      return;
    }

    const accent = m.accent;
    const lift = 2 * z;
    const hullH = m.hull * z;
    const cabTop = m.cabH * z;
    const glass = night ? "#31434f" : m.glassTint;
    const moving = c.speed > 0.5;

    // headlight cone on the ground at night
    if (night && moving) {
      quad([px(L, -W * 0.7, 0), px(L, W * 0.7, 0), px(L + 2.6, W * 1.8, 0), px(L + 2.6, -W * 1.8, 0)], "rgba(255,245,200,0.09)");
    }
    // hover underglow: a pool of accent light that falls off to nothing, so
    // the road under the car reads as lit road rather than a tile of another
    // colour. A hard-edged quad here showed up as a mismatched paving slab.
    if (night) {
      const n = parseInt(accent.slice(1), 16);
      const cr = (n >> 16) & 255, cg = (n >> 8) & 255, cb = n & 255;
      const rad = bodyLen * 0.62;
      g.save();
      g.globalCompositeOperation = "lighter";
      g.translate(sx, sy);
      g.rotate(bodyAngle);
      g.scale(1, 0.34);
      const pool = g.createRadialGradient(0, 0, 0, 0, 0, rad);
      pool.addColorStop(0, `rgba(${cr},${cg},${cb},0.15)`);
      pool.addColorStop(0.45, `rgba(${cr},${cg},${cb},0.07)`);
      pool.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      g.fillStyle = pool;
      g.beginPath();
      g.arc(0, 0, rad, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }

    // hull plan: a superellipse whose squareness is the model's own, narrowed
    // toward the nose by its taper. round 0 is a slab-sided box, 1 an ellipse.
    const e = 2 / (4.5 - 2.5 * m.round);
    const plan = (segs: number, sc: number): [number, number][] => {
      const out: [number, number][] = [];
      for (let k = 0; k < segs; k++) {
        const th = (k + 0.5) * Math.PI * 2 / segs;
        const ca = Math.cos(th), sa = Math.sin(th);
        const hx = L * Math.sign(ca) * Math.abs(ca) ** e;
        const hy = W * Math.sign(sa) * Math.abs(sa) ** e;
        // haunches: push the widest part of the plan back over the rear axle,
        // so the body has shoulders instead of being a lozenge
        const u = hx / L;
        const hip = 1 + m.hips * (0.34 * Math.exp(-((u + 0.42) ** 2) / 0.10)
                                - 0.20 * Math.max(0, u) ** 1.5);
        out.push([hx * sc, hy * sc * hip * (1 - m.taper * Math.max(0, u))]);
      }
      return out;
    };
    if (m.skirt) {                                   // ground-effect flare
      extrude([[L * 0.82, W * 1.16], [L * 0.82, -W * 1.16], [-L * 0.82, -W * 1.16], [-L * 0.82, W * 1.16]],
              lift - 1.4 * z, lift + 1.8 * z, shade(m.body, 0.5), null);
    }
    // bodywork: rings stacked into a solid that tucks under at the sill and
    // crowns at the deck, so the flanks curve instead of standing flat
    const wedgeAt = (df: number, up: number) =>
      m.wedge === 0 ? 0 : m.wedge * z * up * (0.5 - 0.5 * (df / L));
    loft(Renderer.HULL_RINGS, Renderer.HULL_SEGS, plan, lift, hullH, m.body, shade(m.body, 1.14), wedgeAt);
    // character line: a shadowed crease following the widest ring around the
    // camera-facing flank, drawn only where the panel actually turns
    {
      const belt = plan(Renderer.HULL_SEGS, 0.99).map(([df, dr]) => px(df, dr, lift + hullH * 0.56));
      g.strokeStyle = shade(m.body, 0.62);
      g.lineWidth = Math.max(1, 0.5 * z);
      g.beginPath();
      let pen = false;
      for (let k = 0; k <= Renderer.HULL_SEGS; k++) {
        const q = belt[k % Renderer.HULL_SEGS];
        if (q[1] > sy + hullH * 0.1) {
          if (pen) g.lineTo(q[0], q[1]); else { g.moveTo(q[0], q[1]); pen = true; }
        } else pen = false;
      }
      g.stroke();
    }
    if (m.bull) {                                    // welded ram bar
      extrude([[L * 1.1, W * 0.82], [L * 1.1, -W * 0.82], [L * 0.96, -W * 0.82], [L * 0.96, W * 0.82]],
              lift + hullH * 0.15, lift + hullH * 0.95, shade(m.accent, 0.55), shade(m.accent, 0.8));
    }

    // deck seams and a nose flash
    g.strokeStyle = shade(m.body, 0.7);
    g.lineWidth = Math.max(1, z * 0.5);
    g.beginPath();
    const s1 = px(L * 0.55, W * 0.85, lift + hullH + 0.1), s2 = px(L * 0.55, -W * 0.85, lift + hullH + 0.1);
    g.moveTo(s1[0], s1[1]); g.lineTo(s2[0], s2[1]);
    g.stroke();
    quad([px(L * 0.92, W * 0.28, lift + hullH + 0.1), px(L * 0.92, -W * 0.28, lift + hullH + 0.1),
          px(L * 0.78, -W * 0.42, lift + hullH + 0.1), px(L * 0.78, W * 0.42, lift + hullH + 0.1)], accent);

    // livery
    if (m.livery === "check") {                     // taxi chequer along the flank
      for (const s of [1, -1]) {
        if (px(0, W * s, lift)[1] <= sy) continue;
        for (let k = 0; k < 8; k++) {
          const f0 = -L * 0.8 + k * (L * 1.6 / 8);
          quad([px(f0, W * s, lift + hullH * 0.42), px(f0 + L * 1.6 / 8, W * s, lift + hullH * 0.42),
                px(f0 + L * 1.6 / 8, W * s, lift + hullH * 0.72), px(f0, W * s, lift + hullH * 0.72)],
               k % 2 ? accent : "#f2f2f2");
        }
      }
    } else if (m.livery === "stripe") {             // racing / service stripe
      for (const s of [1, -1]) {
        if (px(0, W * s, lift)[1] <= sy) continue;
        quad([px(L * 0.92, W * s, lift + hullH * 0.5), px(-L * 0.92, W * s, lift + hullH * 0.5),
              px(-L * 0.92, W * s, lift + hullH * 0.72), px(L * 0.92, W * s, lift + hullH * 0.72)], accent);
      }
    } else if (m.livery === "corp") {               // thin chrome/gold beltline
      for (const s of [1, -1]) {
        if (px(0, W * s, lift)[1] <= sy) continue;
        quad([px(L * 0.9, W * s, lift + hullH * 0.78), px(-L * 0.9, W * s, lift + hullH * 0.78),
              px(-L * 0.9, W * s, lift + hullH * 0.9), px(L * 0.9, W * s, lift + hullH * 0.9)], accent);
      }
    } else if (m.livery === "rust") {               // patchwork of primer and rot
      for (const s of [1, -1]) {
        if (px(0, W * s, lift)[1] <= sy) continue;
        for (let k = 0; k < 3; k++) {
          const f0 = -L * 0.7 + k * L * 0.55;
          quad([px(f0, W * s, lift + hullH * 0.3), px(f0 + L * 0.3, W * s, lift + hullH * 0.3),
                px(f0 + L * 0.3, W * s, lift + hullH * 0.62), px(f0, W * s, lift + hullH * 0.62)],
               k % 2 ? shade(accent, 0.9) : shade(m.body, 0.62));
        }
      }
    }

    // neon side strip along the camera-facing skirt
    for (const s of [1, -1]) {
      const mid = px(0, W * s, lift + 1.2 * z);
      if (mid[1] <= sy) continue;                    // far side, hidden by the hull
      g.globalAlpha = night ? 0.95 : 0.55;
      quad([px(L * 0.55, W * s, lift + 1 * z), px(-L * 0.72, W * s, lift + 1 * z),
            px(-L * 0.72, W * s, lift + 1.9 * z), px(L * 0.55, W * s, lift + 1.9 * z)], accent);
      g.globalAlpha = 1;
    }

    // canopy: a blown-glass bubble over the cabin, lofted the same way as the
    // body so the glazing curves back into the roofline
    const cF = L * m.cabF, cB = L * m.cabB, cw = W * m.cabW;
    const cMid = (cF + cB) / 2, cHalf = Math.max(0.05, (cF - cB) / 2);
    const cabPlan = (segs: number, sc: number): [number, number][] => {
      const out: [number, number][] = [];
      for (let k = 0; k < segs; k++) {
        const th = (k + 0.5) * Math.PI * 2 / segs;
        const ca = Math.cos(th), sa = Math.sin(th);
        const gx = Math.sign(ca) * Math.abs(ca) ** 0.8;   // slightly squared off
        const gy = Math.sign(sa) * Math.abs(sa) ** 0.8;
        out.push([cMid + cHalf * gx * sc, cw * gy * sc]);
      }
      return out;
    };
    // The canopy sits on the deck the wedge left it on, and on a fastback it
    // runs out to the tail instead of stopping in a wall: the glazing and the
    // rear deck become one line, which is the whole look of a modern coupe.
    const cabRamp = (df: number, up: number) => {
      const w = wedgeAt(df, 1);
      if (m.fast === 0) return w;
      const u = (df - cB) / Math.max(0.001, cF - cB);   // 1 at the windscreen, 0 at the back
      return w - m.fast * (cabTop - hullH) * up * (1 - u) ** 1.6;
    };
    // On a shell the dome is bodywork rather than glazing: one moulded piece
    // from sill to crown, which is what makes the classic Bullfrog car read as
    // a beetle instead of a hull with a cabin on it.
    loft(Renderer.CAB_RINGS, Renderer.CAB_SEGS, cabPlan, lift + hullH, cabTop - hullH,
         m.shell ? shade(m.body, 1.04) : glass,
         m.shell ? shade(m.body, 1.2) : (night ? "#243038" : shade(m.glassTint, 0.82)), cabRamp);
    if (m.shell) {
      // A shell is one moulded piece, so everything that makes it read as a
      // vehicle has to be set into that piece: a wrapped screen rather than a
      // scribed line, a shut line down the flank, a rubbing strip round the
      // sill and louvres over the tail. Each is drawn only on the half of the
      // body turned toward the camera, which is what stops the far side of a
      // closed surface showing through it.
      const R = Renderer.CAB_RINGS;
      const ringScale = (hh: number): number => {
        for (let i = 0; i < R.length - 1; i++) {
          if (hh <= R[i + 1].h) {
            const t = (hh - R[i].h) / Math.max(1e-6, R[i + 1].h - R[i].h);
            return R[i].s + (R[i + 1].s - R[i].s) * t;
          }
        }
        return R[R.length - 1].s;
      };
      // a point on the dome's surface, by angle round the body and height up it
      const dome = (th: number, hh: number): [number, number] => {
        const sc = ringScale(hh);
        const ca = Math.cos(th), sa = Math.sin(th);
        const gx = Math.sign(ca) * Math.abs(ca) ** 0.8, gy = Math.sign(sa) * Math.abs(sa) ** 0.8;
        const df = cMid + cHalf * gx * sc, dr = cw * gy * sc;
        return px(df, dr, lift + hullH + (cabTop - hullH) * hh + cabRamp(df, hh));
      };
      const SEG = 28;
      // wrapped glazing: a band of screen round the shell, segment by segment
      const glassCol = night ? "#1b2731" : shade(m.glassTint, 0.72);
      const bandRef = px(0, 0, lift + hullH + (cabTop - hullH) * 0.52)[1];
      for (let k = 0; k < SEG; k++) {
        const t0 = (k / SEG) * Math.PI * 2, t1 = ((k + 1) / SEG) * Math.PI * 2;
        const a = dome(t0, 0.36), b = dome(t1, 0.36);
        const cU = dome(t1, 0.68), dU = dome(t0, 0.68);
        if ((a[1] + b[1]) / 2 < bandRef) continue;   // far side of the shell
        quad([a, b, cU, dU], glassCol);
      }
      // the screen's own frame, top and bottom, so the band has an edge
      for (const hh of [0.36, 0.68]) {
        g.strokeStyle = shade(m.body, hh > 0.5 ? 1.25 : 0.55);
        g.lineWidth = Math.max(1, 0.6 * z);
        g.beginPath();
        let pen = false;
        const ref = px(0, 0, lift + hullH + (cabTop - hullH) * hh)[1];
        for (let k = 0; k <= SEG; k++) {
          const q = dome((k / SEG) * Math.PI * 2, hh);
          if (q[1] > ref) { if (pen) g.lineTo(q[0], q[1]); else { g.moveTo(q[0], q[1]); pen = true; } }
          else pen = false;
        }
        g.stroke();
      }
      // shut line: the one panel gap on a body that has no other
      for (const sgn of [1, -1]) {
        const seam: [number, number][] = [];
        for (let k = 0; k <= 6; k++) seam.push(dome(sgn * Math.PI / 2, 0.04 + k * 0.15));
        const ref = px(0, 0, lift + hullH + (cabTop - hullH) * 0.5)[1];
        if (seam[3][1] < ref) continue;
        g.strokeStyle = shade(m.body, 0.6);
        g.lineWidth = Math.max(1, 0.5 * z);
        g.beginPath();
        g.moveTo(seam[0][0], seam[0][1]);
        for (let k = 1; k < seam.length; k++) g.lineTo(seam[k][0], seam[k][1]);
        g.stroke();
      }
      // rubbing strip round the sill, and louvres over the tail
      {
        const strip = plan(Renderer.HULL_SEGS, 1.0)
          .map(([df, dr]) => px(df, dr, lift + hullH * 0.34));
        g.strokeStyle = shade(m.body, 0.46);
        g.lineWidth = Math.max(1, 1.2 * z);
        g.beginPath();
        let pen = false;
        for (let k = 0; k <= Renderer.HULL_SEGS; k++) {
          const q = strip[k % Renderer.HULL_SEGS];
          if (q[1] > sy) { if (pen) g.lineTo(q[0], q[1]); else { g.moveTo(q[0], q[1]); pen = true; } }
          else pen = false;
        }
        g.stroke();
      }
      if (px(-L, 0, lift + hullH * 0.6)[1] >= px(0, 0, lift + hullH * 0.6)[1]) {
        for (let k = 0; k < 3; k++) {
          const h0 = lift + hullH * (0.5 + k * 0.13);
          quad([px(-L * 0.9, W * 0.3, h0), px(-L * 0.9, -W * 0.3, h0),
                px(-L * 0.9, -W * 0.3, h0 + 0.7 * z), px(-L * 0.9, W * 0.3, h0 + 0.7 * z)],
               shade(m.body, 0.42));
        }
      }
    }
    // glasshouse: glazing carried down the flanks rather than a dome perched on
    // the deck, so there is a side window and a pillar to read
    if (m.glassDrop > 0) {
      const drop = m.glassDrop * hullH;
      for (const s2 of [1, -1]) {
        if (px(cMid, cw * s2, lift)[1] <= sy) continue;
        quad([px(cF * 0.96, cw * s2 * 0.98, lift + hullH),
              px(cB * 0.9, cw * s2 * 0.98, lift + hullH),
              px(cB * 0.9, cw * s2 * 0.98, lift + hullH - drop),
              px(cF * 0.96, cw * s2 * 0.98, lift + hullH - drop)], shade(glass, 0.78));
      }
    }
    // a soft specular sliding off the crown of the dome
    const gl = px(cMid + cHalf * 0.3, cw * 0.2, lift + cabTop * 0.94);
    const glr = Math.max(1.2, cHalf * TILE_W * 0.26 * z);
    const spec = g.createRadialGradient(gl[0], gl[1], 0, gl[0], gl[1], glr);
    spec.addColorStop(0, m.shell
      ? (night ? "rgba(210,235,255,0.4)" : "rgba(255,255,255,0.62)")
      : (night ? "rgba(190,225,255,0.22)" : "rgba(255,255,255,0.34)"));
    spec.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = spec;
    g.beginPath();
    g.ellipse(gl[0], gl[1], glr, glr * 0.5, 0, 0, Math.PI * 2);
    g.fill();

    // full-width cargo box: vans, haulers and armoured wagons
    if (m.cargo > 0) {
      const bx = Math.min(cB, L * 0.5), bw = W * 0.94;
      if (m.fast > 0) {
        // faired cargo volume: the same plan as the body, tucked in at the top
        // and running out to the tail, rather than a black rectangular prism
        // sat on the deck - which is what made every van look like a wheelie bin
        const boxPlan = (segs: number, sc: number): [number, number][] => {
          const out: [number, number][] = [];
          for (let k = 0; k < segs; k++) {
            const th = (k + 0.5) * Math.PI * 2 / segs;
            const ca = Math.cos(th), sa = Math.sin(th);
            const gx = Math.sign(ca) * Math.abs(ca) ** 0.55;
            const gy = Math.sign(sa) * Math.abs(sa) ** 0.55;
            const mid = (bx - L * 0.94) / 2, half = (bx + L * 0.94) / 2;
            out.push([mid + half * gx * sc, bw * gy * sc]);
          }
          return out;
        };
        loft(Renderer.CAB_RINGS, Renderer.HULL_SEGS, boxPlan, lift + hullH, m.cargo * z,
             shade(m.body, 0.9), shade(m.body, 1.06), wedgeAt);
      } else {
        extrude([[bx, bw], [bx, -bw], [-L * 0.94, -bw], [-L * 0.94, bw]],
                lift + hullH, lift + hullH + m.cargo * z, shade(m.body, 0.88), shade(m.body, 1.05));
      }
      for (const s2 of [1, -1]) {                    // shutter seams down the flanks
        if (px(0, bw * s2, lift)[1] <= sy) continue;
        g.strokeStyle = shade(m.body, 0.6);
        g.lineWidth = Math.max(1, z * 0.5);
        for (let k = 1; k < 3; k++) {
          const f0 = bx + (-L * 0.94 - bx) * (k / 3);
          const a0 = px(f0, bw * s2, lift + hullH + 1 * z), a1 = px(f0, bw * s2, lift + hullH + m.cargo * z - 1 * z);
          g.beginPath(); g.moveTo(a0[0], a0[1]); g.lineTo(a1[0], a1[1]); g.stroke();
        }
        quad([px(bx, bw * s2, lift + hullH + m.cargo * z * 0.72), px(-L * 0.94, bw * s2, lift + hullH + m.cargo * z * 0.72),
              px(-L * 0.94, bw * s2, lift + hullH + m.cargo * z * 0.86), px(bx, bw * s2, lift + hullH + m.cargo * z * 0.86)],
             m.accent);
      }
    }

    // roof furniture
    if (m.rack) {
      extrude([[cB - 0.05, cw * 0.9], [cB - 0.05, -cw * 0.9], [-L * 0.85, -cw * 0.9], [-L * 0.85, cw * 0.9]],
              lift + hullH, lift + hullH + 4 * z, shade(m.body, 0.8), shade(m.body, 0.95));
    }
    if (m.bar === 1) {                               // police strobes
      const blink = Math.floor(performance.now() / 260) % 2 === 0;
      quad([px(0.14, cw * 0.62, lift + cabTop), px(0.14, 0, lift + cabTop), px(-0.14, 0, lift + cabTop + 2.2 * z), px(-0.14, cw * 0.62, lift + cabTop + 2.2 * z)], blink ? "#ff2f4a" : "#3a1015");
      quad([px(0.14, 0, lift + cabTop), px(0.14, -cw * 0.62, lift + cabTop), px(-0.14, -cw * 0.62, lift + cabTop + 2.2 * z), px(-0.14, 0, lift + cabTop + 2.2 * z)], blink ? "#1e2c8c" : "#2fa8ff");
      const lp = px(0, 0, lift + cabTop + 1.5 * z);
      this.glow(lp[0], lp[1], 9 * z, blink ? "#ff2f4a" : "#2fa8ff", night ? 0.5 : 0.22);
    } else if (m.bar === 2) {                        // lit hire sign
      quad([px(0.15, cw * 0.4, lift + cabTop), px(0.15, -cw * 0.4, lift + cabTop),
            px(-0.15, -cw * 0.4, lift + cabTop + 2.2 * z), px(-0.15, cw * 0.4, lift + cabTop + 2.2 * z)],
           night ? "#ffe9a8" : "#e8d890");
      const lp = px(0, 0, lift + cabTop + 1.6 * z);
      this.glow(lp[0], lp[1], 7 * z, "#ffe9a8", night ? 0.35 : 0.1);
    }
    if (m.spoiler) {
      extrude([[-L * 0.78, W * 0.95], [-L * 0.78, -W * 0.95], [-L * 0.95, -W * 0.95], [-L * 0.95, W * 0.95]],
              lift + hullH, lift + hullH + 4.5 * z, shade(m.body, 0.7), accent);
    }
    if (m.fin > 0) {
      const f1 = px(-L * 0.68, 0, lift + hullH), f2 = px(-L * 0.95, 0, lift + hullH);
      const f3 = px(-L * 0.95, 0, lift + hullH + m.fin * z);
      quad([f1, f2, f3], shade(m.body, 0.75));
      g.fillStyle = accent;
      g.fillRect(f3[0] - z * 0.6, f3[1] - z * 0.6, 1.2 * z, 2.2 * z);
    }

    // ---- headlamps and tail lamps ----
    // Spot lamps sunk into the panel, not a bar hung off the nose: a bezel of
    // shadowed bodywork, a lens inside it, the pip where the reflector catches
    // the sky, and the bloom carried by the shared emissive pass. A lamp on the
    // side of the car turned away from the camera is not drawn at all.
    {
      // half-width of the hull plan at a point along the body, so a lamp is
      // set into the panel that is actually there rather than into thin air
      const halfAt = (df: number): number => {
        const u = Math.max(-0.999, Math.min(0.999, df / L));
        const ca = Math.sign(u) * Math.abs(u) ** (1 / e);
        const sa = Math.sqrt(Math.max(0, 1 - ca * ca));
        const hip = 1 + m.hips * (0.34 * Math.exp(-((u + 0.42) ** 2) / 0.10)
                                - 0.20 * Math.max(0, u) ** 1.5);
        return W * sa ** e * hip * (1 - m.taper * Math.max(0, u));
      };
      // A lamp that is lit and a lamp that is off are not the same object. At
      // night the lens is the light source and carries the reflector pip and
      // the bloom. By day it is dark glass sunk in a panel, catching the sky
      // across its top and a rim of housing under it: a pale disc with a white
      // highlight in the middle of it is what reads as an eye, not a lamp.
      const lamp = (df: number, dr: number, up: number, ref: number, r: number,
                    onCol: string, offCol: string, bloom: string, str: number) => {
        const p = px(df, dr, up);
        if (p[1] < ref - 0.4) return;                // this end, or this flank, faces away
        const rx = r * 1.1, ry = r * 0.66;           // a lamp unit is wider than it is tall
        g.fillStyle = shade(m.body, night ? 0.4 : 0.68);   // the recess it sits in
        g.beginPath(); g.ellipse(p[0], p[1], rx * 1.26, ry * 1.42, 0, 0, Math.PI * 2); g.fill();
        if (night) {
          g.fillStyle = onCol;
          g.beginPath(); g.ellipse(p[0], p[1], rx, ry, 0, 0, Math.PI * 2); g.fill();
          g.fillStyle = "rgba(255,255,255,0.72)";    // reflector pip
          g.beginPath();
          g.ellipse(p[0] - rx * 0.27, p[1] - ry * 0.3, rx * 0.29, ry * 0.34, 0, 0, Math.PI * 2);
          g.fill();
          this.glow(p[0], p[1], r * 4.5, bloom, str);
          return;
        }
        const gr = g.createLinearGradient(p[0], p[1] - ry, p[0], p[1] + ry);
        gr.addColorStop(0, shade(offCol, 1.7));      // the sky, across the top of the glass
        gr.addColorStop(0.5, shade(offCol, 0.85));
        gr.addColorStop(1, shade(offCol, 0.5));
        g.fillStyle = gr;
        g.beginPath(); g.ellipse(p[0], p[1], rx, ry, 0, 0, Math.PI * 2); g.fill();
        g.strokeStyle = shade(m.body, 1.45);         // the housing rim under it
        g.lineWidth = Math.max(0.7, 0.35 * z);
        g.beginPath();
        g.ellipse(p[0], p[1], rx, ry, 0, 0.12 * Math.PI, 0.88 * Math.PI);
        g.stroke();
      };
      const nf = L * 0.88, tf = -L * 0.9;
      const nw = halfAt(nf), tw2 = halfAt(tf);
      const nz = lift + hullH * 0.56 + wedgeAt(nf, 0.56);
      const tz = lift + hullH * 0.6 + wedgeAt(tf, 0.6);
      const nRef = px(0, 0, nz)[1], tRef = px(0, 0, tz)[1];
      const r0 = Math.max(0.9, W * TILE_W * 0.16 * z);
      const lensOn = "#fff6d2", lensOff = "#2b333c";     // lit filament / dark glass
      const rearOn = "#ff4a56", rearOff = "#4a1a20";
      for (const s of [1, -1]) {
        if (m.lamps >= 2) {
          lamp(nf, nw * s * 0.42, nz, nRef, r0 * 0.66, lensOn, lensOff, "#fff4be", 0.34);
          lamp(nf, nw * s * 0.8, nz, nRef, r0 * 0.66, lensOn, lensOff, "#fff4be", 0.34);
          lamp(tf, tw2 * s * 0.46, tz, tRef, r0 * 0.55, rearOn, rearOff, "#ff3048", 0.26);
          lamp(tf, tw2 * s * 0.84, tz, tRef, r0 * 0.55, rearOn, rearOff, "#ff3048", 0.26);
        } else {
          lamp(nf, nw * s * 0.64, nz, nRef, r0, lensOn, lensOff, "#fff4be", 0.46);
          lamp(tf, tw2 * s * 0.66, tz, tRef, r0 * 0.8, rearOn, rearOff, "#ff3048", 0.34);
        }
      }
    }

    // ---- rear hover thrusters with exhaust when moving, one pair per bank ----
    const banks: [number, number][] = [];
    for (let b = 0; b < m.turbo; b++) {
      const f0 = -L * (1 - b * 0.2);                  // both banks stay aft of the cabin
      banks.push([f0, 0.55], [f0, -0.55]);
    }
    for (const [df, s] of banks) {
      const t0 = px(df, W * s, lift + 2 * z);
      g.fillStyle = shade(m.body, 0.5);
      g.fillRect(t0[0] - 1.4 * z, t0[1] - 1.4 * z, 2.8 * z, 2.8 * z);
      g.fillStyle = moving ? "#9fe8ff" : "#3a606c";
      g.fillRect(t0[0] - 0.8 * z, t0[1] - 0.8 * z, 1.6 * z, 1.6 * z);
      if (moving) {
        this.glow(t0[0], t0[1], 5 * z, "#9fe8ff", night ? 0.4 : 0.16);
        const len = 0.25 + (c.speed / 9) * 0.8; // exhaust streak scales with speed
        g.globalCompositeOperation = "lighter";
        g.globalAlpha = 0.3;
        quad([px(df, W * s + 0.05, lift + 2 * z), px(df, W * s - 0.05, lift + 2 * z),
              px(df - len, W * s - 0.02, lift + 2 * z), px(df - len, W * s + 0.02, lift + 2 * z)], "#9fe8ff");
        g.globalAlpha = 1;
        g.globalCompositeOperation = "source-over";
      }
    }

    if (c.state === "player" || c.state === "launching" || c.state === "docking") {
      g.strokeStyle = "rgba(120,255,190,0.8)";
      g.lineWidth = 1.5;
      g.beginPath();
      g.ellipse(sx, sy, 19 * z, 8.5 * z, 0, 0, Math.PI * 2);
      g.stroke();
    }
    this.flashOver(g, lit, c.flash ?? 0, c.flashOk ?? true);
  }

  private drawPed(
    g: CanvasRenderingContext2D, p: Ped, world: World, people: PeopleAtlas,
    SX: (x: number, y: number) => number, SY: (x: number, y: number) => number, z: number, time: number
  ): void {
    const sheet =
      p.team === "player" ? people.player.sheet :
      p.team === "cop" ? people.cop.sheet :
      p.team === "enemy" ? people.enemy.sheet :
      people.civs[p.model % people.civs.length].sheet;

    let col = 0;
    if (p.state === "dead") {
      col = 9 + Math.min(3, Math.floor(p.deadT * 7));
    } else if (p.state === "flee") {
      col = 5 + (Math.floor(p.animT * 9) % 4);
    } else if (p.path && (p.state === "walk" || p.state === "follow")) {
      col = 1 + (Math.floor(p.animT * (2.4 * p.speed)) % 4);
    }
    // gassed: drawn with the falling frame, flat out until they come round
    if (p.stunT > 0 && p.state !== "dead") col = 10;
    const sx = SX(p.x, p.y), sy = SY(p.x, p.y) - p.z * STORY_H * z;
    const s = PED_SCALE * z;
    if (p.cloakOn) g.globalAlpha = 0.4 + 0.1 * Math.sin(time * 6);
    if (p.state !== "dead" && p.trainId === null) {
      g.fillStyle = "rgba(0,0,0,0.4)";
      g.beginPath(); g.ellipse(sx, sy, 5 * z, 2.2 * z, 0, 0, Math.PI * 2); g.fill();
    }
    if (p.team === "player" && p.agentIdx >= 0 && world.uiSelected[p.agentIdx] && p.state !== "dead") {
      g.strokeStyle = "rgba(255,155,47,0.9)";
      g.lineWidth = 1.5;
      g.beginPath(); g.ellipse(sx, sy, 6.5 * z, 3 * z, 0, 0, Math.PI * 2); g.stroke();
    }
    // Riding: the marker says who is aboard and where, but the agent itself is
    // inside the carriage and has no business being drawn on its roof.
    if (p.trainId !== null) return;
    if (p.vip && p.state !== "dead") {
      // amber and steady while he is stood waiting for you to come back into
      // view: a marker that never changes makes waiting look like being stuck
      const waiting = p.persuaded && p.blindT > 0.4;
      g.fillStyle = waiting
        ? "rgba(255,155,47,0.95)"
        : `rgba(255,255,255,${0.5 + 0.5 * Math.sin(time * 5)})`;
      g.beginPath();
      g.moveTo(sx, sy - FH * s - 6 * z);
      g.lineTo(sx - 3 * z, sy - FH * s - 11 * z);
      g.lineTo(sx + 3 * z, sy - FH * s - 11 * z);
      g.closePath(); g.fill();
    }
    if (p.persuaded && p.state !== "dead") {
      g.fillStyle = "#d98cff";
      g.fillRect(sx - 1.5 * z, sy - FH * s - 5 * z, 3 * z, 3 * z);
    }
    g.drawImage(
      sheet, col * FW, p.dir * FH, FW, FH,
      sx - (FW / 2) * s, sy - (FH - 2) * s, FW * s, FH * s
    );
    if (p.team === "player" && p.shieldOn && p.state !== "dead") {
      g.strokeStyle = `rgba(122,255,200,${0.4 + 0.3 * Math.sin(time * 8)})`;
      g.lineWidth = 1.5;
      g.beginPath();
      g.ellipse(sx, sy - 10 * z, 8 * z, 14 * z, 0, 0, Math.PI * 2);
      g.stroke();
    }
    if (p.state !== "dead" && p.hp < p.maxHp && (p.team === "player" || p.vip)) {
      const w = 14 * z;
      g.fillStyle = "#300";
      g.fillRect(sx - w / 2, sy - FH * s - 3 * z, w, 2 * z);
      g.fillStyle = p.team === "player" ? "#6f6" : "#fff";
      g.fillRect(sx - w / 2, sy - FH * s - 3 * z, w * Math.max(0, p.hp / p.maxHp), 2 * z);
    }
    g.globalAlpha = 1;   // the cloak's shimmer must not bleed into the next body
  }
}
