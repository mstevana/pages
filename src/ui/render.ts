// Isometric world renderer: diagonal-row painter's algorithm so tall building
// blocks correctly occlude people and cars behind them.

import { City, Deco, T_BUILDING, T_ISLAND, T_PARK, T_ROAD, T_SIDEWALK, T_WALL, D_S, D_W, idx } from "../city/citygen";
import { GRID, STORY_H, TILE_H, TILE_W, isNight, isRain, isoX, isoY } from "../engine/util";
import { PeopleAtlas, FW, FH } from "../sprites/people";
import { TileArt } from "../sprites/tiles";
import { Car, Ped, World } from "../game/world";
import { ITEMS } from "../game/items";

export interface Camera {
  x: number; y: number; // tile coords at viewport center
  zoom: number;
}

interface Entity {
  s: number;    // depth key = tx + ty
  kind: "ped" | "car" | "drop" | "lamp";
  ped?: Ped;
  car?: Car;
  drop?: { x: number; y: number; item: { type: string } };
  x: number; y: number;
}

export class Renderer {
  private decoIndex = new Map<number, Deco[]>();
  rainDrops: { x: number; y: number; v: number }[] = [];

  constructor(private city: City) {
    for (const d of city.decos) {
      const k = idx(d.x, d.y);
      let arr = this.decoIndex.get(k);
      if (!arr) { arr = []; this.decoIndex.set(k, arr); }
      arr.push(d);
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
    // world tile -> screen
    const SX = (tx: number, ty: number) => cx + (isoX(tx, ty) - camPX) * z;
    const SY = (tx: number, ty: number) => cy + (isoY(tx, ty) - camPY) * z;

    g.save();
    g.beginPath();
    g.rect(vx, vy, vw, vh);
    g.clip();
    g.fillStyle = isNight(art.weather) ? "#040508" : "#101216";
    g.fillRect(vx, vy, vw, vh);
    g.imageSmoothingEnabled = false;

    // visible tile bounds from the 4 viewport corners (with margin for tall buildings)
    const margin = 14;
    const corners = [
      [vx, vy], [vx + vw, vy], [vx, vy + vh + 12 * STORY_H * z], [vx + vw, vy + vh + 12 * STORY_H * z],
    ];
    let txMin = 1e9, txMax = -1e9, tyMin = 1e9, tyMax = -1e9;
    for (const [px, py] of corners) {
      const wx = (px - cx) / z + camPX, wy = (py - cy) / z + camPY;
      const tx = wx / TILE_W + wy / TILE_H, ty = wy / TILE_H - wx / TILE_W;
      txMin = Math.min(txMin, tx); txMax = Math.max(txMax, tx);
      tyMin = Math.min(tyMin, ty); tyMax = Math.max(tyMax, ty);
    }
    const x0 = Math.max(0, Math.floor(txMin) - 2), x1 = Math.min(GRID - 1, Math.ceil(txMax) + 2);
    const y0 = Math.max(0, Math.floor(tyMin) - margin), y1 = Math.min(GRID - 1, Math.ceil(tyMax) + 2);

    const tiles = this.city.tiles, hArr = this.city.height, lane = this.city.laneDir;
    const tw = TILE_W * z, th = TILE_H * z;

    // ---- pass 1: flat ground ----
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const t = tiles[idx(tx, ty)];
        if (t === T_WALL || t === T_BUILDING) continue;
        const sx = SX(tx, ty) - tw / 2, sy = SY(tx, ty);
        if (sx > vx + vw || sx + tw < vx || sy > vy + vh || sy + th < vy) continue;
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

    // ---- pass 2: blocks + entities in depth order ----
    const adFrame = Math.floor(time * 2.2);
    for (let s = x0 + y0; s <= x1 + y1; s++) {
      for (let tx = Math.max(x0, s - y1); tx <= Math.min(x1, s - y0); tx++) {
        const ty = s - tx;
        const i = idx(tx, ty);
        const t = tiles[i];
        if (t !== T_WALL && t !== T_BUILDING) continue;
        const stories = hArr[i] || 1;
        const block = art.blocks[Math.min(11, stories - 1)][(tx * 31 + ty * 17) % 3];
        const sx = SX(tx, ty) - tw / 2;
        const syTop = SY(tx, ty) - stories * STORY_H * z;
        if (sx > vx + vw || sx + tw < vx || syTop > vy + vh || syTop + th + stories * STORY_H * z < vy) continue;
        g.drawImage(block, sx, syTop, tw, th + stories * STORY_H * z);
        // decorations on this wall
        const decs = this.decoIndex.get(i);
        if (decs) {
          const groundY = SY(tx, ty);
          for (const d of decs) {
            const level = Math.min(d.level, stories - 1);
            // top of story `level` band on each face (see block sprite geometry)
            const img = d.kind === "videowall"
              ? art.ads[d.variant % art.ads.length][(adFrame + d.variant) % 4]
              : art.neons[d.variant % art.neons.length];
            const inset = (TILE_W - 4 - img.width) / 2 + 2; // sprite px from face edge
            g.save();
            if (d.face === 0) {
              // SW face: top edge slopes +0.5 starting at the left vertex
              const ax = sx + inset * z;
              const ay = groundY + (TILE_H / 2) * z - (level + 1) * STORY_H * z + (inset * 0.5 + 1) * z;
              g.transform(z, 0.5 * z, 0, z, ax, ay);
            } else {
              // SE face: top edge slopes -0.5 starting at the bottom vertex
              const ax = sx + tw / 2 + inset * z;
              const ay = groundY + TILE_H * z - (level + 1) * STORY_H * z + (1 - inset * 0.5) * z;
              g.transform(z, -0.5 * z, 0, z, ax, ay);
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
    // projectiles
    for (const pr of world.projectiles) {
      const sx = SX(pr.x, pr.y), sy = SY(pr.x, pr.y) - 6 * z;
      g.fillStyle = ITEMS[pr.type]?.color ?? "#ffe";
      g.fillRect(sx - z, sy - z, 2 * z, 2 * z);
    }
    // beams
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
    // muzzle flashes / explosions glow
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
    // particles
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

  private drawEntity(
    g: CanvasRenderingContext2D, e: Entity, world: World, art: TileArt, people: PeopleAtlas,
    SX: (x: number, y: number) => number, SY: (x: number, y: number) => number, z: number, time: number
  ): void {
    if (e.kind === "lamp") {
      const sx = SX(e.x, e.y), sy = SY(e.x, e.y);
      g.drawImage(art.lamp, sx - 4 * z, sy - 38 * z, 16 * z, 40 * z);
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

  private drawCar(
    g: CanvasRenderingContext2D, c: Car, art: TileArt,
    SX: (x: number, y: number) => number, SY: (x: number, y: number) => number, z: number
  ): void {
    const sx = SX(c.x, c.y), sy = SY(c.x, c.y);
    // shadow
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
      // hover glow
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
      // cabin
      g.fillStyle = "rgba(140,220,255,0.85)";
      g.fillRect(-L * 0.35, -W * 0.72, L * 0.75, W * 1.44);
      // nose stripe
      g.fillStyle = "rgba(255,255,255,0.25)";
      g.fillRect(L * 0.55, -W, L * 0.2, W * 2);
      // headlights
      g.fillStyle = night ? "#fff8c8" : "#d8d8c0";
      g.fillRect(L * 0.92, -W * 0.8, 0.08, W * 0.35);
      g.fillRect(L * 0.92, W * 0.45, 0.08, W * 0.35);
      // tail
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
    const s = 1.35 * z;
    if (p.state !== "dead") {
      g.fillStyle = "rgba(0,0,0,0.4)";
      g.beginPath(); g.ellipse(sx, sy, 5 * z, 2.2 * z, 0, 0, Math.PI * 2); g.fill();
    }
    // selection ring for player agents
    if (p.team === "player" && p.agentIdx >= 0 && world.uiSelected[p.agentIdx] && p.state !== "dead") {
      g.strokeStyle = "rgba(255,155,47,0.9)";
      g.lineWidth = 1.5;
      g.beginPath(); g.ellipse(sx, sy, 6.5 * z, 3 * z, 0, 0, Math.PI * 2); g.stroke();
    }
    // vip marker
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
    // shield shimmer
    if (p.team === "player" && p.shieldOn && p.state !== "dead") {
      g.strokeStyle = `rgba(122,255,200,${0.4 + 0.3 * Math.sin(time * 8)})`;
      g.lineWidth = 1.5;
      g.beginPath();
      g.ellipse(sx, sy - 10 * z, 8 * z, 14 * z, 0, 0, Math.PI * 2);
      g.stroke();
    }
    // health bar for hurt actors
    if (p.state !== "dead" && p.hp < p.maxHp && (p.team === "player" || p.vip)) {
      const w = 14 * z;
      g.fillStyle = "#300";
      g.fillRect(sx - w / 2, sy - FH * s - 3 * z, w, 2 * z);
      g.fillStyle = p.team === "player" ? "#6f6" : "#fff";
      g.fillRect(sx - w / 2, sy - FH * s - 3 * z, w * Math.max(0, p.hp / p.maxHp), 2 * z);
    }
  }
}
