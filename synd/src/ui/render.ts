// Isometric world renderer: diagonal-row painter's algorithm so tall building
// blocks correctly occlude people and cars behind them. Also draws the static
// street furniture (fences, doors, pit rails) and the elevated skytrain.

import { City, Deco, Prop, T_BUILDING, T_GROUND, T_ISLAND, T_PARK, T_PIT, T_ROAD, T_SIDEWALK, T_WALL, D_S, D_W, idx, inGrid, isRoad } from "../city/citygen";
import { GRID, STORY_H, TILE_H, TILE_W, isNight, isRain, isoX, isoY } from "../engine/util";
import { PeopleAtlas, FW, FH } from "../sprites/people";
import { BENCH_H, BENCH_W, STALL_H, STALL_W, TREE_H, TREE_W } from "../sprites/props";
import { CAR_MODELS } from "../sprites/cars";
import { TileArt } from "../sprites/tiles";
import { Car, Ped, World } from "../game/world";
import { ITEMS } from "../game/items";
import { ICON_SIZE, itemIcons } from "../sprites/icons";

export interface Camera {
  x: number; y: number; // tile coords at viewport center
  zoom: number;
}

const TRAIN_ELEV = 64;   // px above ground at zoom 1
const PED_SCALE = 1.2;   // people vs the 30px story: roughly one story tall

interface Entity {
  s: number;    // depth key = tx + ty
  pri: number;  // within-bucket order: 0 elevated structure, 1 ground, 2 trains
  kind: "ped" | "car" | "drop" | "lamp" | "fence" | "pylon" | "deck" | "train" | "prop";
  ped?: Ped;
  car?: Car;
  drop?: { x: number; y: number; item: { type: string } };
  fence?: FenceEdge;
  train?: TrainSeg;
  prop?: Prop;
  deckAxis?: "v" | "h";
  x: number; y: number;
}

interface FenceEdge {
  x: number; y: number;
  edge: 0 | 1 | 2 | 3;   // 0 NW, 1 NE, 2 SE, 3 SW (tile edge)
  hazard: boolean;       // yellow pit railing vs park fence
}

interface TrainSeg { wx: number; wy: number; angle: number; head: boolean; }

interface DeckTile { x: number; y: number; axis: "v" | "h"; pylon: boolean; }

export class Renderer {
  private decoIndex = new Map<number, Deco[]>();
  private fences: FenceEdge[] = [];
  private decks: DeckTile[] = [];
  private buildingId: Int32Array; // connected-component label per WALL/BUILDING tile
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

    for (const d of city.decos) {
      const k = idx(d.x, d.y);
      let arr = this.decoIndex.get(k);
      if (!arr) { arr = []; this.decoIndex.set(k, arr); }
      arr.push(d);
    }
    this.buildFences();
    this.buildDecks();
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

  private buildDecks(): void {
    for (const line of this.city.skytrains) {
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
    time: number
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
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
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
            else if (bits === D_S) img = art.roadDashV;
            else if (bits === D_W) img = art.roadDashH;
            else img = art.road;
            break;
          }
          case T_SIDEWALK: img = art.sidewalk; break;
          case T_PARK: img = art.park; break;
          case T_ISLAND: img = art.island; break;
          default: img = art.ground;
        }
        g.drawImage(img, sx, sy, tw, th);
      }
    }

    // ---- collect entities bucketed by depth ----
    const buckets = new Map<number, Entity[]>();
    const push = (e: Entity) => {
      let b = buckets.get(e.s);
      if (!b) { b = []; buckets.set(e.s, b); }
      b.push(e);
    };
    for (const p of world.peds) {
      if (p.carId !== null || p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
      push({ s: Math.floor(p.x) + Math.floor(p.y), pri: 1, kind: "ped", ped: p, x: p.x, y: p.y });
    }
    for (const c of world.cars) {
      if (c.x < x0 || c.x > x1 || c.y < y0 || c.y > y1) continue;
      push({ s: Math.floor(c.x) + Math.floor(c.y), pri: 1, kind: "car", car: c, x: c.x, y: c.y });
    }
    for (const l of this.city.lamps) {
      if (l.x < x0 || l.x > x1 || l.y < y0 || l.y > y1) continue;
      push({ s: l.x + l.y, pri: 1, kind: "lamp", x: l.x + 0.5, y: l.y + 0.5 });
    }
    for (const p of this.city.props) {
      if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
      push({ s: p.x + p.y, pri: 1, kind: "prop", prop: p, x: p.x + 0.5, y: p.y + 0.5 });
    }
    for (const f of this.fences) {
      if (f.x < x0 || f.x > x1 || f.y < y0 || f.y > y1) continue;
      push({ s: f.x + f.y, pri: 1, kind: "fence", fence: f, x: f.x + 0.5, y: f.y + 0.5 });
    }
    for (const d of this.decks) {
      if (d.x < x0 - 1 || d.x > x1 || d.y < y0 - 1 || d.y > y1) continue;
      if (d.pylon) push({ s: d.x + d.y, pri: 0, kind: "pylon", x: d.x + 1, y: d.y + 1, deckAxis: d.axis });
      push({ s: d.x + d.y, pri: 0, kind: "deck", x: d.x + 1, y: d.y + (d.axis === "v" ? 0.5 : 1), deckAxis: d.axis });
    }
    // trains: two per line, opposite directions, deterministic from time
    for (const line of this.city.skytrains) {
      const segLen = 1.9, nSeg = 4, span = GRID + nSeg * segLen + 8;
      for (let tr = 0; tr < 2; tr++) {
        const speed = 14 + tr * 3;
        const dirSign = tr === 0 ? 1 : -1;
        const head = ((time * speed + tr * 217) % span);
        for (let k = 0; k < nSeg; k++) {
          const u = dirSign > 0 ? head - k * segLen : GRID - (head - k * segLen);
          if (u < -2 || u > GRID + 2) continue;
          const wx = line.axis === "v" ? line.pos + 1 : u;
          const wy = line.axis === "v" ? u : line.pos + 1;
          if (wx < x0 || wx > x1 || wy < y0 || wy > y1) continue;
          const angle = line.axis === "v" ? Math.atan2(dirSign, 0) : Math.atan2(0, dirSign);
          push({ s: Math.floor(wx) + Math.floor(wy), pri: 2, kind: "train", x: wx, y: wy, train: { wx, wy, angle, head: k === 0 } });
        }
      }
    }

    // ---- cutaway targets: living agents (and their car) the camera must
    // be able to see - occluding buildings render floors above the first
    // at low alpha ----
    const cutTargets: { ax: number; ay: number; s: number }[] = [];
    for (const a of world.agents) {
      if (a.hp <= 0 || a.carId !== null) continue;
      cutTargets.push({ ax: SX(a.x, a.y), ay: SY(a.x, a.y), s: Math.floor(a.x) + Math.floor(a.y) });
    }
    for (const c of world.cars) {
      if (c.state === "player" && c.occupants.length > 0) {
        cutTargets.push({ ax: SX(c.x, c.y), ay: SY(c.x, c.y), s: Math.floor(c.x) + Math.floor(c.y) });
      }
    }

    // which whole buildings occlude an agent? (they cut away above floor 1)
    const cutIds = new Set<number>();
    if (cutTargets.length > 0) {
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const i = idx(tx, ty);
          const t = tiles[i];
          if (t !== T_WALL && t !== T_BUILDING) continue;
          const stories = hArr[i] || 1;
          if (stories <= 1) continue;
          const id = this.buildingId[i];
          if (id < 0 || cutIds.has(id)) continue;
          const s = tx + ty;
          const colCx = SX(tx, ty);
          const syTop = SY(tx, ty) - stories * STORY_H * z;
          const baseBottom = syTop + stories * STORY_H * z + th;
          for (const ct of cutTargets) {
            if (s > ct.s && Math.abs(colCx - ct.ax) < tw * 0.8 && ct.ay - 32 * z < baseBottom && ct.ay > syTop) {
              cutIds.add(id);
              break;
            }
          }
        }
      }
    }

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
        if (t === T_BUILDING && !cut) {
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
            const level = Math.min(d.level, stories - 1);
            const img = d.kind === "videowall"
              ? art.ads[d.variant % art.ads.length][(adFrame + d.variant) % 4]
              : d.kind === "billboard" ? art.billboards[d.variant % art.billboards.length]
              : d.kind === "shopwin" ? art.shops[d.variant % art.shops.length]
              : art.neons[d.variant % art.neons.length];
            const sxAd = d.kind === "videowall" ? 1.2 : d.kind === "neon" ? 1.1 : 1.0;
            const syAd = d.kind === "videowall" ? 1.7 : d.kind === "neon" ? 1.5
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
              if (d.kind === "videowall") {
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

    // ---- effects ----
    for (const pr of world.projectiles) {
      const sx = SX(pr.x, pr.y), sy = SY(pr.x, pr.y) - 6 * z;
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
      g.moveTo(SX(b.x0, b.y0), SY(b.x0, b.y0) - 6 * z);
      g.lineTo(SX(b.x1, b.y1), SY(b.x1, b.y1) - 6 * z);
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

    // smoke sits behind the flames, so draw it first and unlit
    for (const pt of world.particles) {
      if (pt.kind !== "smoke") continue;
      const t = Math.max(0, pt.life / pt.maxLife);
      const sx = SX(pt.x, pt.y), sy = SY(pt.x, pt.y) - 4 * z - pt.lift * z;
      const r = pt.size * z;
      const gr = g.createRadialGradient(sx, sy, 0, sx, sy, r);
      gr.addColorStop(0, `rgba(58,58,66,${0.45 * t})`);
      gr.addColorStop(1, "rgba(40,40,48,0)");
      g.fillStyle = gr;
      g.fillRect(sx - r, sy - r, r * 2, r * 2);
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
      const r = Math.max(1, pt.size * z);
      const gr = g.createRadialGradient(sx, sy, 0, sx, sy, r);
      gr.addColorStop(0, `rgba(${c},${0.9 * t})`);
      gr.addColorStop(0.5, `rgba(${c},${0.4 * t})`);
      gr.addColorStop(1, `rgba(${c},0)`);
      g.fillStyle = gr;
      g.fillRect(sx - r, sy - r, r * 2, r * 2);
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
      const t = 1 - pg.life / pg.maxLife;      // 0 fresh -> 1 gone
      const fade = 1 - t;
      const mx = SX(pg.x, pg.y), my = SY(pg.x, pg.y);
      const col = pg.ok ? "79,220,106" : "224,64,64";
      const rx = (TILE_W / 2) * z, ry = (TILE_H / 2) * z;
      // expanding shockwave ring
      const grow = 0.35 + t * 1.5;
      g.strokeStyle = `rgba(${col},${0.8 * fade})`;
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

    // extraction zone marker
    const m = world.mission;
    if (m.zone && !m.done && !m.failed) {
      const sx = SX(m.zone.x, m.zone.y), sy = SY(m.zone.x, m.zone.y);
      g.strokeStyle = "rgba(120,255,190,0.7)";
      g.lineWidth = 2;
      const pulse = 1 + 0.15 * Math.sin(time * 4);
      g.beginPath();
      g.ellipse(sx, sy, m.zone.r * TILE_W * 0.5 * z * pulse, m.zone.r * TILE_H * 0.5 * z * pulse, 0, 0, Math.PI * 2);
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
      return;
    }
    if (e.kind === "fence" && e.fence) {
      this.drawFence(g, e.fence, art, SX, SY, z);
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
      this.drawCar(g, e.car, art, SX, SY, z);
      return;
    }
    if (e.kind === "ped" && e.ped) {
      this.drawPed(g, e.ped, world, people, SX, SY, z, time);
    }
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
    const quad = (pts: [number, number][], col: string) => {
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.closePath();
      g.fill();
    };
    const shade = (hex: string, f: number): string => {
      const n = parseInt(hex.slice(1), 16);
      const r = Math.min(255, (((n >> 16) & 255) * f) | 0);
      const gg = Math.min(255, (((n >> 8) & 255) * f) | 0);
      const b = Math.min(255, ((n & 255) * f) | 0);
      return `rgb(${r},${gg},${b})`;
    };

    const L = 0.86, W = 0.3;
    const elev = TRAIN_ELEV * z;
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
    SX: (x: number, y: number) => number, SY: (x: number, y: number) => number, z: number
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
    const px = (df: number, dr: number, lift: number): [number, number] => {
      const wx = c.x + fx * df + rx * dr, wy = c.y + fy * df + ry * dr;
      return [SX(wx, wy), SY(wx, wy) - lift];
    };
    const quad = (pts: [number, number][], col: string) => {
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.closePath();
      g.fill();
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
      base: number, height: number, col: string, topCol: string | null
    ) => {
      const pts = rings.map((r) => plan(segs, r.s).map(([df, dr]) => px(df, dr, base + r.h * height)));
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
    const sx = SX(c.x, c.y), sy = SY(c.x, c.y);
    const nose = px(L, 0, 0), tail = px(-L, 0, 0);
    const bodyAngle = Math.atan2(nose[1] - tail[1], nose[0] - tail[0]);
    const bodyLen = Math.hypot(nose[0] - tail[0], nose[1] - tail[1]);
    g.fillStyle = "rgba(0,0,0,0.45)";
    g.beginPath();
    g.ellipse(sx, sy, bodyLen * 0.6, 7 * z, bodyAngle, 0, Math.PI * 2);
    g.fill();

    if (c.state === "wreck") {
      extrude([[L * 0.9, W * 0.5], [L * 0.6, W], [-L * 0.9, W], [-L, W * 0.5], [-L, -W * 0.5], [-L * 0.9, -W], [L * 0.6, -W], [L * 0.9, -W * 0.5]], 0, 3.5 * z, "#1a1a1c", "#2a2a2c");
      g.fillStyle = "#0e0e10"; // burst canopy
      g.fillRect(sx - 5 * z, sy - 6 * z, 9 * z, 4 * z);
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
    // hover underglow in the car's accent color
    if (night) {
      g.globalCompositeOperation = "lighter";
      const n = parseInt(accent.slice(1), 16);
      quad(
        [px(L * 1.02, W * 1.2, 0.8 * z), px(L * 1.02, -W * 1.2, 0.8 * z), px(-L * 1.02, -W * 1.2, 0.8 * z), px(-L * 1.02, W * 1.2, 0.8 * z)],
        `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.14)`
      );
      g.globalCompositeOperation = "source-over";
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
        out.push([hx * sc, hy * sc * (1 - m.taper * Math.max(0, hx / L))]);
      }
      return out;
    };
    const tw = W * (1 - m.taper);
    if (m.skirt) {                                   // ground-effect flare
      extrude([[L * 0.82, W * 1.16], [L * 0.82, -W * 1.16], [-L * 0.82, -W * 1.16], [-L * 0.82, W * 1.16]],
              lift - 1.4 * z, lift + 1.8 * z, shade(m.body, 0.5), null);
    }
    // bodywork: rings stacked into a solid that tucks under at the sill and
    // crowns at the deck, so the flanks curve instead of standing flat
    loft(Renderer.HULL_RINGS, Renderer.HULL_SEGS, plan, lift, hullH, m.body, shade(m.body, 1.14));
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
    loft(Renderer.CAB_RINGS, Renderer.CAB_SEGS, cabPlan, lift + hullH, cabTop - hullH,
         glass, night ? "#243038" : shade(m.glassTint, 0.82));
    // a soft specular sliding off the crown of the dome
    const gl = px(cMid + cHalf * 0.3, cw * 0.2, lift + cabTop * 0.94);
    const glr = Math.max(1.2, cHalf * TILE_W * 0.26 * z);
    const spec = g.createRadialGradient(gl[0], gl[1], 0, gl[0], gl[1], glr);
    spec.addColorStop(0, night ? "rgba(190,225,255,0.22)" : "rgba(255,255,255,0.34)");
    spec.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = spec;
    g.beginPath();
    g.ellipse(gl[0], gl[1], glr, glr * 0.5, 0, 0, Math.PI * 2);
    g.fill();

    // full-width cargo box: vans, haulers and armoured wagons
    if (m.cargo > 0) {
      const bx = Math.min(cB, L * 0.5), bw = W * 0.94;
      extrude([[bx, bw], [bx, -bw], [-L * 0.94, -bw], [-L * 0.94, bw]],
              lift + hullH, lift + hullH + m.cargo * z, shade(m.body, 0.88), shade(m.body, 1.05));
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

    // ---- light bar across the nose + taillight strip ----
    const hl = night ? "#fff8c8" : "#e8e8d0";
    quad([px(L, tw * 0.9, lift + hullH * 0.55), px(L, -tw * 0.9, lift + hullH * 0.55),
          px(L * 0.98, -tw * 0.9, lift + hullH * 0.8), px(L * 0.98, tw * 0.9, lift + hullH * 0.8)], hl);
    quad([px(-L, W * 0.5, lift + hullH * 0.45), px(-L, -W * 0.5, lift + hullH * 0.45),
          px(-L, -W * 0.5, lift + hullH * 0.72), px(-L, W * 0.5, lift + hullH * 0.72)], night ? "#ff3048" : "#c02838");
    // bloom via the shared emissive pass
    const hp = px(L, 0, lift + hullH * 0.68);
    this.glow(hp[0], hp[1], 8 * z, "#fff4be", night ? 0.5 : 0.1);
    const tp = px(-L, 0, lift + hullH * 0.58);
    this.glow(tp[0], tp[1], 6.5 * z, "#ff3048", night ? 0.4 : 0.14);

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
    const sx = SX(p.x, p.y), sy = SY(p.x, p.y);
    const s = PED_SCALE * z;
    if (p.state !== "dead") {
      g.fillStyle = "rgba(0,0,0,0.4)";
      g.beginPath(); g.ellipse(sx, sy, 5 * z, 2.2 * z, 0, 0, Math.PI * 2); g.fill();
    }
    if (p.team === "player" && p.agentIdx >= 0 && world.uiSelected[p.agentIdx] && p.state !== "dead") {
      g.strokeStyle = "rgba(255,155,47,0.9)";
      g.lineWidth = 1.5;
      g.beginPath(); g.ellipse(sx, sy, 6.5 * z, 3 * z, 0, 0, Math.PI * 2); g.stroke();
    }
    if (p.vip && p.state !== "dead") {
      g.fillStyle = `rgba(255,255,255,${0.5 + 0.5 * Math.sin(time * 5)})`;
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
  }
}
