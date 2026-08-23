// The left control panel: agent dolls, inventory, minimap, walk/shoot toggles.
// Drawn straight onto the main canvas in CSS pixels; hit() maps taps to actions.

import { GRID, clamp } from "../engine/util";
import { ITEMS } from "../game/items";
import { Ped, World } from "../game/world";
import { FW, FH, PeopleAtlas } from "../sprites/people";
import { itemIcons } from "../sprites/icons";

export type PanelHit =
  | { type: "doll"; i: number }
  | { type: "emblem" }
  | { type: "slot"; i: number }
  | { type: "toggle"; mode: "walk" | "shoot" }
  | { type: "obj" }
  | { type: "sound" }
  | { type: "pause" }
  | { type: "minimap" }
  | { type: "none" };

export interface PanelLayout {
  w: number; h: number;
  header: { x: number; y: number; w: number; h: number };
  dolls: { x: number; y: number; w: number; h: number }[];
  emblem: { x: number; y: number; r: number };
  slots: { x: number; y: number; w: number; h: number }[];
  minimap: { x: number; y: number; w: number; h: number };
  walkBtn: { x: number; y: number; w: number; h: number };
  shootBtn: { x: number; y: number; w: number; h: number };
  objBtn: { x: number; y: number; w: number; h: number };
  sndBtn: { x: number; y: number; w: number; h: number };
  pauseBtn: { x: number; y: number; w: number; h: number };
}

const ORANGE = "#ff9b2f";
const PANEL_BG = "#191b22";
const BEVEL_L = "#2e3140";
const BEVEL_D = "#0c0d12";

function inRect(px: number, py: number, r: { x: number; y: number; w: number; h: number }): boolean {
  return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
}

export class Panel {
  layout: PanelLayout;
  minimapRange = 44; // tiles from center to minimap edge

  constructor(w: number, h: number) {
    this.layout = this.computeLayout(w, h);
  }

  resize(w: number, h: number): void {
    this.layout = this.computeLayout(w, h);
  }

  private computeLayout(w: number, h: number): PanelLayout {
    const pad = Math.max(3, w * 0.03);
    const headerH = Math.max(18, h * 0.055);
    let y = headerH + pad;

    // dolls 2x2
    const dollW = (w - pad * 3) / 2;
    const dollH = Math.min(h * 0.16, dollW * 0.85);
    const dolls = [];
    for (let i = 0; i < 4; i++) {
      dolls.push({
        x: pad + (i % 2) * (dollW + pad),
        y: y + Math.floor(i / 2) * (dollH + pad),
        w: dollW, h: dollH,
      });
    }
    const emblem = { x: w / 2, y: y + dollH + pad / 2, r: Math.max(11, w * 0.085) };
    y += dollH * 2 + pad * 2;

    // inventory 4x2
    const slotW = (w - pad * 5) / 4;
    const slotH = Math.min(h * 0.085, slotW * 1.0);
    const slots = [];
    for (let i = 0; i < 8; i++) {
      slots.push({
        x: pad + (i % 4) * (slotW + pad),
        y: y + Math.floor(i / 4) * (slotH + pad),
        w: slotW, h: slotH,
      });
    }
    y += slotH * 2 + pad * 2;

    // toggles at the bottom; minimap fills the space between
    const togH = Math.max(26, h * 0.075);
    const togY = h - togH - pad;
    const mmSize = Math.min(w - pad * 2, togY - pad - y);
    const minimap = { x: (w - mmSize) / 2, y, w: mmSize, h: mmSize };

    const walkBtn = { x: pad, y: togY, w: (w - pad * 3) / 2, h: togH };
    const shootBtn = { x: pad * 2 + walkBtn.w, y: togY, w: walkBtn.w, h: togH };

    const btnW = Math.max(24, w * 0.16);
    const objBtn = { x: w - btnW * 3 - pad * 3, y: 2, w: btnW, h: headerH - 4 };
    const sndBtn = { x: w - btnW * 2 - pad * 2, y: 2, w: btnW, h: headerH - 4 };
    const pauseBtn = { x: w - btnW - pad, y: 2, w: btnW, h: headerH - 4 };

    return {
      w, h,
      header: { x: 0, y: 0, w, h: headerH },
      dolls, emblem, slots, minimap, walkBtn, shootBtn, objBtn, sndBtn, pauseBtn,
    };
  }

  hit(px: number, py: number): PanelHit {
    const L = this.layout;
    const dx = px - L.emblem.x, dy = py - L.emblem.y;
    if (dx * dx + dy * dy < L.emblem.r * L.emblem.r) return { type: "emblem" };
    for (let i = 0; i < 4; i++) if (inRect(px, py, L.dolls[i])) return { type: "doll", i };
    for (let i = 0; i < 8; i++) if (inRect(px, py, L.slots[i])) return { type: "slot", i };
    if (inRect(px, py, L.walkBtn)) return { type: "toggle", mode: "walk" };
    if (inRect(px, py, L.shootBtn)) return { type: "toggle", mode: "shoot" };
    if (inRect(px, py, L.objBtn)) return { type: "obj" };
    if (inRect(px, py, L.sndBtn)) return { type: "sound" };
    if (inRect(px, py, L.pauseBtn)) return { type: "pause" };
    if (inRect(px, py, L.minimap)) return { type: "minimap" };
    return { type: "none" };
  }

  // Which agent's inventory is shown: the first selected living one.
  invAgent(world: World): Ped | null {
    for (let i = 0; i < 4; i++) {
      if (world.uiSelected[i] && world.agents[i] && world.agents[i].hp > 0) return world.agents[i];
    }
    return null;
  }

  draw(
    g: CanvasRenderingContext2D,
    world: World,
    people: PeopleAtlas,
    mapBase: HTMLCanvasElement,
    mode: "walk" | "shoot",
    muted: boolean,
    time: number,
    missionNo: number,
    giveTarget = -1  // doll index hovered while dragging an item, -1 none
  ): void {
    const L = this.layout;
    // panel body
    g.fillStyle = PANEL_BG;
    g.fillRect(0, 0, L.w, L.h);
    g.fillStyle = BEVEL_L; g.fillRect(L.w - 2, 0, 2, L.h);
    g.fillStyle = BEVEL_D; g.fillRect(L.w - 1, 0, 1, L.h);

    // header
    g.fillStyle = "#0e0f14";
    g.fillRect(0, 0, L.w, L.header.h);
    g.fillStyle = ORANGE;
    g.font = `bold ${Math.max(10, L.header.h * 0.55)}px monospace`;
    g.textBaseline = "middle";
    g.fillText(`SYND ${String(missionNo).padStart(2, "0")}`, 4, L.header.h / 2 + 1);
    this.smallBtn(g, L.objBtn, "OBJ", false);
    this.smallBtn(g, L.sndBtn, muted ? "S/X" : "SND", muted);
    this.smallBtn(g, L.pauseBtn, "II", false);

    // dolls
    const invOwner = this.invAgent(world);
    for (let i = 0; i < 4; i++) {
      const r = L.dolls[i];
      const a = world.agents[i];
      const sel = world.uiSelected[i];
      const canReceive = giveTarget === i && a && a.hp > 0 && a !== invOwner && a.inv.length < 8 && a.carId === null;
      g.fillStyle = sel ? "#232633" : "#14161d";
      if (canReceive) g.fillStyle = "#1c3328";
      g.fillRect(r.x, r.y, r.w, r.h);
      g.strokeStyle = sel ? ORANGE : "#33364a";
      g.lineWidth = sel ? 2 : 1;
      if (canReceive) { g.strokeStyle = "#4fdc6a"; g.lineWidth = 2; }
      g.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      if (!a || a.hp <= 0) {
        g.fillStyle = "#3a2028";
        g.fillRect(r.x + 2, r.y + 2, r.w - 4, r.h - 4);
        g.fillStyle = "#c04858";
        g.font = `bold ${Math.max(8, r.h * 0.22)}px monospace`;
        g.textAlign = "center";
        g.fillText("K.I.A.", r.x + r.w / 2, r.y + r.h / 2);
        g.textAlign = "left";
        continue;
      }
      // doll sprite (idle, facing S)
      const s = Math.min((r.h - 14) / FH, (r.w * 0.5) / FW);
      g.drawImage(people.player.sheet, 0, 0, FW, FH, r.x + 3, r.y + r.h / 2 - (FH * s) / 2 - 2, FW * s, FH * s);
      // name + bars
      const bx = r.x + FW * s + 7;
      const bw = r.x + r.w - 4 - bx;
      g.fillStyle = "#9fe8ff";
      g.font = `bold ${Math.max(7, r.h * 0.18)}px monospace`;
      g.fillText(a.carId !== null ? "IN CAR" : this.agentName(world, i), bx, r.y + r.h * 0.24);
      // hp bar
      g.fillStyle = "#3a1418";
      g.fillRect(bx, r.y + r.h * 0.42, bw, 4);
      g.fillStyle = a.hp > 35 ? "#4fdc6a" : "#e2c33c";
      g.fillRect(bx, r.y + r.h * 0.42, bw * clamp(a.hp / a.maxHp, 0, 1), 4);
      // shield bar
      if (a.shieldOn) {
        g.fillStyle = "#12333a";
        g.fillRect(bx, r.y + r.h * 0.42 + 6, bw, 3);
        g.fillStyle = "#7affc8";
        g.fillRect(bx, r.y + r.h * 0.42 + 6, bw * clamp(a.shield / 100, 0, 1), 3);
      }
      // selected weapon short label
      const it = a.sel >= 0 && a.sel < a.inv.length ? a.inv[a.sel] : null;
      g.fillStyle = "#5f7d8c";
      g.font = `${Math.max(7, r.h * 0.16)}px monospace`;
      g.fillText(it ? ITEMS[it.type].short : "-", bx, r.y + r.h * 0.8);
    }
    // emblem (select all)
    const em = L.emblem;
    g.beginPath();
    g.arc(em.x, em.y, em.r, 0, Math.PI * 2);
    g.fillStyle = "#0e0f16";
    g.fill();
    g.strokeStyle = ORANGE;
    g.lineWidth = 2;
    g.stroke();
    g.fillStyle = ORANGE;
    g.font = `bold ${em.r * 0.75}px monospace`;
    g.textAlign = "center";
    g.fillText("S", em.x, em.y + 1);
    g.textAlign = "left";

    // inventory of first selected agent
    const icons = itemIcons();
    const inv = this.invAgent(world);
    for (let i = 0; i < 8; i++) {
      const r = L.slots[i];
      const item = inv && i < inv.inv.length ? inv.inv[i] : null;
      const isSel = inv !== null && i === inv.sel && item !== null;
      const isShieldOn = item?.type === "shield" && inv?.shieldOn;
      g.fillStyle = isSel ? "#4a2c10" : "#101218";
      g.fillRect(r.x, r.y, r.w, r.h);
      g.strokeStyle = isSel ? ORANGE : isShieldOn ? "#7affc8" : "#2c2f3e";
      g.lineWidth = isSel || isShieldOn ? 2 : 1;
      g.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      if (item) {
        const def = ITEMS[item.type];
        // the item's own icon identifies the slot; the equipped weapon is
        // still spelled out in words next to the agent's doll
        const icon = icons[item.type];
        const isz = Math.min(r.w - 6, r.h - 11);
        g.drawImage(icon, r.x + (r.w - isz) / 2, r.y + 2, isz, isz);
        // charge bar graph
        const frac = clamp(item.charge / def.charge, 0, 1);
        g.fillStyle = "#0a0b10";
        g.fillRect(r.x + 3, r.y + r.h - 7, r.w - 6, 4);
        g.fillStyle = frac > 0.25 ? def.color : "#e04040";
        g.fillRect(r.x + 3, r.y + r.h - 7, (r.w - 6) * frac, 4);
      }
    }

    // minimap
    this.drawMinimap(g, world, mapBase, time);

    // toggles
    this.toggleBtn(g, L.walkBtn, "WALK", mode === "walk", "#4fdc6a");
    this.toggleBtn(g, L.shootBtn, "SHOOT", mode === "shoot", "#e04040");
  }

  private agentName(world: World, i: number): string {
    return world.agentNames[i] ?? `AGT ${i + 1}`;
  }

  private smallBtn(g: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }, label: string, off: boolean): void {
    g.fillStyle = "#1c1f2a";
    g.fillRect(r.x, r.y, r.w, r.h);
    g.strokeStyle = "#3a3e52";
    g.lineWidth = 1;
    g.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    g.fillStyle = off ? "#666" : "#9fe8ff";
    g.font = `bold ${Math.max(7, r.h * 0.5)}px monospace`;
    g.textAlign = "center";
    g.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + 1);
    g.textAlign = "left";
  }

  private toggleBtn(g: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }, label: string, on: boolean, onColor: string): void {
    g.fillStyle = on ? "#26301e" : "#14161d";
    if (on && label === "SHOOT") g.fillStyle = "#33161a";
    g.fillRect(r.x, r.y, r.w, r.h);
    g.strokeStyle = on ? onColor : "#33364a";
    g.lineWidth = on ? 2 : 1;
    g.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    g.fillStyle = on ? onColor : "#5f7d8c";
    g.font = `bold ${Math.max(9, r.h * 0.42)}px monospace`;
    g.textAlign = "center";
    g.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + 1);
    g.textAlign = "left";
  }

  private drawMinimap(g: CanvasRenderingContext2D, world: World, mapBase: HTMLCanvasElement, time: number): void {
    const r = this.layout.minimap;
    if (r.w < 20) return;
    const range = this.minimapRange;
    const cx = clamp(world.camX, range, GRID - range);
    const cy = clamp(world.camY, range, GRID - range);
    g.save();
    g.beginPath();
    g.rect(r.x, r.y, r.w, r.h);
    g.clip();
    g.imageSmoothingEnabled = false;
    g.drawImage(mapBase, cx - range, cy - range, range * 2, range * 2, r.x, r.y, r.w, r.h);
    const k = r.w / (range * 2);
    const mx = (wx: number) => r.x + (wx - (cx - range)) * k;
    const my = (wy: number) => r.y + (wy - (cy - range)) * k;
    const dot = (wx: number, wy: number, col: string, size: number) => {
      g.fillStyle = col;
      g.fillRect(mx(wx) - size / 2, my(wy) - size / 2, size, size);
    };
    for (const c of world.cars) if (c.state !== "wreck") dot(c.x, c.y, "#3f9fbf", 2);
    for (const d of world.drops) dot(d.x, d.y, "#ff9b2f", 2);
    for (const p of world.peds) {
      if (p.state === "dead") continue;
      if (p.team === "civ" && !p.vip) dot(p.x, p.y, "#6a6f7a", 1.5);
      else if (p.team === "cop") dot(p.x, p.y, "#4a6aff", 2.5);
      else if (p.team === "enemy") dot(p.x, p.y, "#ff3048", 2.5);
    }
    for (const a of world.agents) if (a.hp > 0) dot(a.x, a.y, "#ffe32f", 3);
    // objective: white dot with radar pings, clamped to the minimap edge
    const obj = world.objectivePoint();
    if (obj) {
      const ox = clamp(mx(obj.x), r.x + 4, r.x + r.w - 4);
      const oy = clamp(my(obj.y), r.y + 4, r.y + r.h - 4);
      const ping = (time % 1.6) / 1.6;
      g.strokeStyle = `rgba(255,255,255,${1 - ping})`;
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(ox, oy, 3 + ping * 12, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = "#fff";
      g.beginPath();
      g.arc(ox, oy, 2.2, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
    g.strokeStyle = "#33364a";
    g.lineWidth = 1;
    g.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
  }
}
