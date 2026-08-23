// Isometric world renderer: diagonal-row painter's algorithm so tall building
// blocks correctly occlude people and cars behind them. Also draws the static
// street furniture (fences, doors, pit rails) and the elevated skytrain.

import { City, Deco, T_BUILDING, T_GROUND, T_ISLAND, T_PARK, T_PIT, T_ROAD, T_SIDEWALK, T_WALL, D_S, D_W, idx, inGrid } from "../city/citygen";
import { GRID, STORY_H, TILE_H, TILE_W, isNight, isRain, isoX, isoY } from "../engine/util";
import { PeopleAtlas, FW, FH } from "../sprites/people";
import { TileArt } from "../sprites/tiles";
import { Car, Ped, World } from "../game/world";
import { ITEMS } from "../game/items";

export interface Camera {
  x: number; y: number; // tile coords at viewport center
  zoom: number;
}

const TRAIN_ELEV = 64;   // px above ground at zoom 1
const PED_SCALE = 1.2;   // people vs the 30px story: roughly one story tall

interface Entity {
  s: number;    // depth key = tx + ty
  kind: "ped" | "car" | "drop" | "lamp" | "fence" | "pylon" | "deck" | "train";
  ped?: Ped;
  car?: Car;
  drop?: { x: number; y: number; item: { type: string } };
  fence?: FenceEdge;
  train?: TrainSeg;
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
  rainDrops: { x: number; y: number; v: number }[] = [];

  constructor(private city: City) {
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
            const bits = lane[idx(tx, ty)];
            if (isRain(art.weather) && ((tx * 7 + ty * 13) % 11 === 0)) img = art.roadPuddle;
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
      push({ s: Math.floor(p.x) + Math.floor(p.y), kind: "ped", ped: p, x: p.x, y: p.y });
    }
    for (const c of world.cars) {
      if (c.x < x0 || c.x > x1 || c.y < y0 || c.y > y1) continue;
      push({ s: Math.floor(c.x) + Math.floor(c.y), kind: "car", car: c, x: c.x, y: c.y });
    }
    for (const d of world.drops) {
      if (d.x < x0 || d.x > x1 || d.y < y0 || d.y > y1) continue;
      push({ s: Math.floor(d.x) + Math.floor(d.y), kind: "drop", drop: d, x: d.x, y: d.y });
    }
    for (const l of this.city.lamps) {
      if (l.x < x0 || l.x > x1 || l.y < y0 || l.y > y1) continue;
      push({ s: l.x + l.y, kind: "lamp", x: l.x + 0.5, y: l.y + 0.5 });
    }
    for (const f of this.fences) {
      if (f.x < x0 || f.x > x1 || f.y < y0 || f.y > y1) continue;
      push({ s: f.x + f.y, kind: "fence", fence: f, x: f.x + 0.5, y: f.y + 0.5 });
    }
    for (const d of this.decks) {
      if (d.x < x0 - 1 || d.x > x1 || d.y < y0 - 1 || d.y > y1) continue;
      if (d.pylon) push({ s: d.x + d.y + 1, kind: "pylon", x: d.x + 1, y: d.y + 1, deckAxis: d.axis });
      push({ s: d.x + d.y + 1, kind: "deck", x: d.x + 1, y: d.y + (d.axis === "v" ? 0.5 : 1), deckAxis: d.axis });
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
          push({ s: Math.floor(wx) + Math.floor(wy), kind: "train", x: wx, y: wy, train: { wx, wy, angle, head: k === 0 } });
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
        g.drawImage(block, sx, syTop, tw, th + stories * STORY_H * z);
        // sparse roof furniture (interior roof tiles only, so it never tiles)
        if (t === T_BUILDING) {
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
            const level = Math.min(d.level, stories - 1);
            const img = d.kind === "videowall"
              ? art.ads[d.variant % art.ads.length][(adFrame + d.variant) % 4]
              : art.neons[d.variant % art.neons.length];
            const sxAd = d.kind === "videowall" ? 1.2 : 1.1;
            const syAd = d.kind === "videowall" ? 1.7 : 1.5;
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
            if (d.kind === "videowall" && isNight(art.weather)) {
              g.globalCompositeOperation = "lighter";
              g.globalAlpha = 0.25;
              g.drawImage(img, -1, -1, img.width + 2, img.height + 2);
              g.globalAlpha = 1;
              g.globalCompositeOperation = "source-over";
            }
            g.restore();
          }
        }
      }
      const b = buckets.get(s);
      if (b) {
        b.sort((a, bb) => (a.x + a.y) - (bb.x + bb.y));
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

    // ---- effects ----
    for (const pr of world.projectiles) {
      const sx = SX(pr.x, pr.y), sy = SY(pr.x, pr.y) - 6 * z;
      g.fillStyle = ITEMS[pr.type]?.color ?? "#ffe";
      g.fillRect(sx - z, sy - z, 2 * z, 2 * z);
    }
    for (const b of world.beams) {
      g.strokeStyle = b.color;
      g.globalAlpha = Math.min(1, b.life / 0.12);
      g.lineWidth = 2 * z;
      g.beginPath();
      g.moveTo(SX(b.x0, b.y0), SY(b.x0, b.y0) - 6 * z);
      g.lineTo(SX(b.x1, b.y1), SY(b.x1, b.y1) - 6 * z);
      g.stroke();
      g.globalAlpha = 1;
    }
    g.globalCompositeOperation = "lighter";
    for (const f of world.flashes) {
      const sx = SX(f.x, f.y), sy = SY(f.x, f.y) - 6 * z;
      const r = 10 * z * (f.life / 0.06);
      const gr = g.createRadialGradient(sx, sy, 0, sx, sy, r);
      gr.addColorStop(0, "rgba(255,240,180,0.8)");
      gr.addColorStop(1, "rgba(255,240,180,0)");
      g.fillStyle = gr;
      g.fillRect(sx - r, sy - r, r * 2, r * 2);
    }
    g.globalCompositeOperation = "source-over";
    for (const pt of world.particles) {
      g.globalAlpha = Math.max(0, pt.life / pt.maxLife);
      g.fillStyle = pt.color;
      const sx = SX(pt.x, pt.y), sy = SY(pt.x, pt.y) - 4 * z;
      g.fillRect(sx, sy, pt.size * z, pt.size * z);
    }
    g.globalAlpha = 1;

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
      g.drawImage(art.lamp, sx - 4 * z, sy - 38 * z, 16 * z, 40 * z);
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
    if (e.kind === "drop" && e.drop) {
      const sx = SX(e.x, e.y), sy = SY(e.x, e.y);
      const bob = Math.sin(time * 3 + e.x) * 1.5 * z;
      const def = ITEMS[e.drop.item.type as keyof typeof ITEMS];
      g.fillStyle = "rgba(0,0,0,0.4)";
      g.beginPath(); g.ellipse(sx, sy, 5 * z, 2 * z, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = def.color;
      g.fillRect(sx - 3 * z, sy - 6 * z + bob, 6 * z, 4 * z);
      g.strokeStyle = "rgba(255,255,255,0.7)";
      g.lineWidth = 1;
      g.strokeRect(sx - 3 * z, sy - 6 * z + bob, 6 * z, 4 * z);
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
    const sx = SX(t.wx, t.wy), sy = SY(t.wx, t.wy) - TRAIN_ELEV * z;
    g.save();
    g.transform(
      (TILE_W / 2) * z, (TILE_H / 2) * z,
      -(TILE_W / 2) * z, (TILE_H / 2) * z,
      sx, sy - 4 * z
    );
    g.rotate(t.angle);
    const L = 0.9, W = 0.3;
    g.fillStyle = art.night ? "#3a4552" : "#6a7480";
    g.fillRect(-L, -W, L * 2, W * 2);
    // lit window band
    g.fillStyle = art.night ? "#9fe8ff" : "#c8dae2";
    g.fillRect(-L * 0.85, -W * 0.55, L * 1.7, W * 1.1);
    g.fillStyle = art.night ? "#3a4552" : "#6a7480";
    for (let wx = -L * 0.8; wx < L * 0.8; wx += 0.24) g.fillRect(wx, -W * 0.55, 0.06, W * 1.1);
    if (t.head) {
      g.fillStyle = "#fff8c8";
      g.fillRect(L * 0.9, -W * 0.5, 0.1, W);
    }
    g.restore();
    if (art.night) {
      g.globalCompositeOperation = "lighter";
      const gr = g.createRadialGradient(sx, sy, 0, sx, sy, 20 * z);
      gr.addColorStop(0, "rgba(120,200,255,0.12)");
      gr.addColorStop(1, "rgba(120,200,255,0)");
      g.fillStyle = gr;
      g.fillRect(sx - 20 * z, sy - 20 * z, 40 * z, 40 * z);
      g.globalCompositeOperation = "source-over";
    }
  }

  private drawCar(
    g: CanvasRenderingContext2D, c: Car, art: TileArt,
    SX: (x: number, y: number) => number, SY: (x: number, y: number) => number, z: number
  ): void {
    const sx = SX(c.x, c.y), sy = SY(c.x, c.y);
    g.fillStyle = "rgba(0,0,0,0.45)";
    g.beginPath(); g.ellipse(sx, sy, 16 * z, 7 * z, 0, 0, Math.PI * 2); g.fill();
    g.save();
    // tile-space -> screen-space basis so the box is naturally isometric
    // (transform() composes with the DPR matrix; setTransform would clobber it)
    g.transform(
      (TILE_W / 2) * z, (TILE_H / 2) * z,
      -(TILE_W / 2) * z, (TILE_H / 2) * z,
      sx, sy - 3 * z
    );
    g.rotate(c.angle);
    const L = 1.25, W = 0.52;
    if (c.state === "wreck") {
      g.fillStyle = "#1a1a1c";
      g.fillRect(-L, -W, L * 2, W * 2);
      g.fillStyle = "#333";
      g.fillRect(-L * 0.5, -W * 0.7, L, W * 1.4);
    } else {
      const night = isNight(art.weather);
      if (night && c.speed > 0.5) {
        g.fillStyle = "rgba(255,245,200,0.10)";
        g.beginPath();
        g.moveTo(L, -W * 0.6); g.lineTo(L + 2.6, -W * 1.8); g.lineTo(L + 2.6, W * 1.8); g.lineTo(L, W * 0.6);
        g.closePath(); g.fill();
      }
      if (night) {
        g.fillStyle = "rgba(60,180,255,0.25)";
        g.fillRect(-L - 0.08, -W - 0.08, (L + 0.08) * 2, (W + 0.08) * 2);
      }
      g.fillStyle = c.color;
      g.fillRect(-L, -W, L * 2, W * 2);
      g.fillStyle = "rgba(140,220,255,0.85)";
      g.fillRect(-L * 0.35, -W * 0.72, L * 0.75, W * 1.44);
      g.fillStyle = "rgba(255,255,255,0.25)";
      g.fillRect(L * 0.55, -W, L * 0.2, W * 2);
      g.fillStyle = night ? "#fff8c8" : "#d8d8c0";
      g.fillRect(L * 0.92, -W * 0.8, 0.08, W * 0.35);
      g.fillRect(L * 0.92, W * 0.45, 0.08, W * 0.35);
      g.fillStyle = "#ff3048";
      g.fillRect(-L, -W * 0.8, 0.06, W * 0.3);
      g.fillRect(-L, W * 0.5, 0.06, W * 0.3);
    }
    g.restore();
    if (c.state === "player") {
      g.strokeStyle = "rgba(120,255,190,0.8)";
      g.lineWidth = 1.5;
      g.beginPath(); g.ellipse(sx, sy, 18 * z, 8 * z, 0, 0, Math.PI * 2); g.stroke();
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
