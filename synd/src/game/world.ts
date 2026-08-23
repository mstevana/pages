// The live mission world: pedestrians, cops, enemy agents, cars, projectiles,
// dropped items, objectives, and all the AI that drives them.

import { City, T_ROAD, DBIT, DX, DY, idx, inGrid, isRoad, isWalkable } from "../city/citygen";
import { AudioEngine } from "../engine/audio";
import { Rng } from "../engine/rng";
import { GRID, Weather, clamp, dist, dist2 } from "../engine/util";
import { ITEMS, ItemStack, ItemType, copDrop, enemyDrop, newItem } from "./items";
import { Pathfinder } from "./pathfind";
import { SaveData } from "./save";

export type Team = "player" | "civ" | "cop" | "enemy";
export type PedState = "idle" | "walk" | "flee" | "follow" | "dead";
export type ObjectiveKind = "assassinate" | "persuade" | "escort" | "killall";

let nextId = 1;

export interface Ped {
  id: number;
  team: Team;
  model: number;          // civ model index; unused for cop/enemy/player
  x: number; y: number;
  dir: number;            // 0..7 facing
  hp: number; maxHp: number;
  state: PedState;
  path: { x: number; y: number }[] | null;
  pathIdx: number;
  speed: number;
  animT: number;
  deadT: number;          // time since death
  thinkT: number;         // AI repath/decide timer
  fleeFrom: { x: number; y: number } | null;
  fireCd: number;
  weapon: ItemType | null; // for cops/enemies
  // player agents only
  agentIdx: number;        // 0..3, -1 otherwise
  inv: ItemStack[];
  sel: number;             // selected inventory index, -1 none
  shieldOn: boolean;
  shield: number;          // shield charge if shieldOn
  fireAt: { x: number; y: number; until: number } | null;
  dropOrder: { invIdx: number; x: number; y: number } | null;
  pickOrder: number | null; // drop id
  giveOrder: { invIdx: number; targetId: number } | null; // hand item to a squadmate
  carId: number | null;     // inside car
  boardOrder: number | null;
  // vip / persuasion
  vip: boolean;
  persuaded: boolean;
  followId: number | null;
  hostileCop: boolean;      // cop that has turned on the player
}

export interface Car {
  id: number;
  x: number; y: number;
  angle: number;          // rendered angle in *screen* space
  dir: number;            // current lane dir 0..3 (N,E,S,W)
  speed: number;
  color: string;
  hp: number;
  state: "drive" | "stopping" | "parked" | "player" | "wreck";
  path: { x: number; y: number }[] | null;
  pathIdx: number;
  pilotOut: boolean;
  occupants: number[];    // agent ped ids
}

export interface Projectile {
  x: number; y: number;
  vx: number; vy: number;
  dmg: number;
  team: Team;
  life: number;
  type: ItemType;
}

export interface Beam { x0: number; y0: number; x1: number; y1: number; life: number; color: string; }
export interface Drop { id: number; x: number; y: number; item: ItemStack; }
export interface Particle { x: number; y: number; vx: number; vy: number; life: number; maxLife: number; color: string; size: number; }
export interface Flash { x: number; y: number; life: number; }

export interface Mission {
  kind: ObjectiveKind;
  text: string;
  targetId: number;                    // vip ped id (0 for killall)
  zone: { x: number; y: number; r: number } | null; // extraction / return zone
  startPos: { x: number; y: number };
  enemiesLeft: number;
  waveT: number;
  phase: number;                       // escort: 0 = reach target, 1 = bring home
  done: boolean;
  failed: boolean;
  failReason: string;
}

export interface MissionResult {
  success: boolean;
  reason: string;
  kills: number;
  creditsEarned: number;
}

const AGENT_HP = 100;
const CIV_LIMIT = 90;
const CAR_LIMIT = 7;
const COP_LIMIT = 4;
const NPC_FIRE_MULT = 2.1; // NPCs shoot slower than player agents

export class World {
  rng: Rng;
  peds: Ped[] = [];
  cars: Car[] = [];
  projectiles: Projectile[] = [];
  beams: Beam[] = [];
  drops: Drop[] = [];
  particles: Particle[] = [];
  flashes: Flash[] = [];
  mission: Mission;
  agents: Ped[] = [];              // the (up to) 4 player agents, index-stable
  time = 0;
  heat = 0;                        // police alert level
  kills = 0;
  creditsEarned = 0;
  camX: number; camY: number;      // camera focus in tile coords (set by main)
  uiSelected: boolean[] = [true, true, true, true]; // which agents the UI has selected
  agentNames: string[] = [];
  result: MissionResult | null = null;
  pf: Pathfinder;
  notify: (msg: string) => void = () => {};

  constructor(
    public city: City,
    public weather: Weather,
    save: SaveData,
    public audio: AudioEngine,
    kind: ObjectiveKind,
    public missionNo: number
  ) {
    this.rng = new Rng(city.seed ^ 0xbeef01);
    this.pf = new Pathfinder(city);
    this.agentNames = save.agents.map((a) => a.name);

    // squad insertion near a map-edge sidewalk
    const start = this.findStart();
    this.camX = start.x; this.camY = start.y;

    for (let i = 0; i < 4; i++) {
      const sa = save.agents[i];
      if (!sa || !sa.alive) { this.agents.push(this.makeDeadPlaceholder(i)); continue; }
      const p = this.makePed("player", start.x + (i % 2) * 1.2 - 0.6, start.y + Math.floor(i / 2) * 1.2 - 0.6);
      p.agentIdx = i;
      p.hp = Math.max(35, sa.hp);
      p.maxHp = AGENT_HP;
      p.inv = sa.inv.map((s) => ({ ...s }));
      p.sel = p.inv.findIndex((s) => ITEMS[s.type].weapon && s.charge > 0);
      p.speed = 3.1;
      this.agents.push(p);
      this.peds.push(p);
    }

    this.mission = this.setupMission(kind, start);
    // persuade missions: issue a persuadertron to the first living agent
    if (kind === "persuade") {
      const a = this.agents.find((p) => p.hp > 0 && p.agentIdx >= 0);
      if (a && a.inv.length < 8 && !a.inv.some((s) => s.type === "persuadertron")) {
        a.inv.push(newItem("persuadertron"));
      }
    }
  }

  private makeDeadPlaceholder(i: number): Ped {
    const p = this.makePed("player", -100, -100);
    p.agentIdx = i;
    p.hp = 0; p.state = "dead"; p.deadT = 999;
    return p;
  }

  private findStart(): { x: number; y: number } {
    // on a sidewalk next to an avenue, in the outer third of the map
    const c = this.city;
    for (let tries = 0; tries < 200; tries++) {
      const vertical = this.rng.chance(0.5);
      if (vertical && c.vRoads.length > 0) {
        const rx = this.rng.pick(c.vRoads);
        const ry = this.rng.chance(0.5) ? this.rng.int(14, 60) : this.rng.int(GRID - 60, GRID - 14);
        const sx = this.rng.chance(0.5) ? rx - 1 : rx + 2;
        if (isWalkable(c, sx, ry)) return { x: sx + 0.5, y: ry + 0.5 };
      } else if (c.hRoads.length > 0) {
        const ry = this.rng.pick(c.hRoads);
        const rx = this.rng.chance(0.5) ? this.rng.int(14, 60) : this.rng.int(GRID - 60, GRID - 14);
        const sy = this.rng.chance(0.5) ? ry - 1 : ry + 2;
        if (isWalkable(c, rx, sy)) return { x: rx + 0.5, y: sy + 0.5 };
      }
    }
    const n = this.pf.nearestWalkable(20, 20, 20);
    return n ? { x: n.x + 0.5, y: n.y + 0.5 } : { x: 20.5, y: 20.5 };
  }

  private farPoint(from: { x: number; y: number }, minDist: number): { x: number; y: number } {
    for (let tries = 0; tries < 300; tries++) {
      const x = this.rng.int(12, GRID - 12), y = this.rng.int(12, GRID - 12);
      if (dist(x, y, from.x, from.y) < minDist) continue;
      const n = this.pf.nearestWalkable(x, y, 8);
      if (n) return { x: n.x + 0.5, y: n.y + 0.5 };
    }
    // opposite corner fallback
    const n = this.pf.nearestWalkable(GRID - 1 - (from.x | 0), GRID - 1 - (from.y | 0), 20);
    return n ? { x: n.x + 0.5, y: n.y + 0.5 } : { x: GRID / 2, y: GRID / 2 };
  }

  private setupMission(kind: ObjectiveKind, start: { x: number; y: number }): Mission {
    const m: Mission = {
      kind, text: "", targetId: 0, zone: null, startPos: { ...start },
      enemiesLeft: 0, waveT: 10, phase: 0, done: false, failed: false, failReason: "",
    };
    switch (kind) {
      case "assassinate": {
        const p = this.farPoint(start, 320);
        const vip = this.spawnCiv(p.x, p.y, true);
        vip.vip = true; vip.maxHp = vip.hp = 70;
        m.targetId = vip.id;
        m.text = "ASSASSINATE the marked individual. Local police are on syndicate payroll: they WILL shoot on sight.";
        this.heat = 10; // cops hostile from the start
        break;
      }
      case "persuade": {
        const p = this.farPoint(start, 320);
        const vip = this.spawnCiv(p.x, p.y, true);
        vip.vip = true; vip.maxHp = vip.hp = 60;
        m.targetId = vip.id;
        m.zone = { x: start.x, y: start.y, r: 5 };
        m.text = "PERSUADE the target with the Persuadertron, then escort them to the extraction zone. Rival agents will intervene.";
        break;
      }
      case "escort": {
        const p = this.farPoint(start, 320);
        const vip = this.spawnCiv(p.x, p.y, true);
        vip.vip = true; vip.maxHp = vip.hp = 60;
        m.targetId = vip.id;
        m.zone = { x: start.x, y: start.y, r: 5 };
        m.phase = 0;
        m.text = "REACH the VIP across the city, then ESCORT them back to the insertion point. Expect heavy resistance.";
        break;
      }
      case "killall": {
        const count = 30;
        m.enemiesLeft = count;
        for (let i = 0; i < count; i++) {
          const p = this.farPoint(start, 60 + this.rng.int(0, 200));
          this.spawnEnemy(p.x, p.y);
        }
        m.text = "ELIMINATE all 30 rival syndicate agents operating in this sector. They are hunting you too.";
        break;
      }
    }
    return m;
  }

  // ---------- spawning ----------

  private makePed(team: Team, x: number, y: number): Ped {
    return {
      id: nextId++, team, model: 0, x, y, dir: 0,
      hp: 30, maxHp: 30, state: "idle", path: null, pathIdx: 0,
      speed: 2.2, animT: 0, deadT: 0, thinkT: this.rng.float(0, 2),
      fleeFrom: null, fireCd: 0, weapon: null,
      agentIdx: -1, inv: [], sel: -1, shieldOn: false, shield: 0,
      fireAt: null, dropOrder: null, pickOrder: null, giveOrder: null, carId: null, boardOrder: null,
      vip: false, persuaded: false, followId: null, hostileCop: false,
    };
  }

  spawnCiv(x: number, y: number, persistent = false): Ped {
    const p = this.makePed("civ", x, y);
    p.model = this.rng.int(0, 29);
    p.hp = p.maxHp = 26;
    p.speed = this.rng.float(1.6, 2.4);
    if (persistent) p.thinkT = 0;
    this.peds.push(p);
    return p;
  }

  spawnCop(x: number, y: number): Ped {
    const p = this.makePed("cop", x, y);
    p.hp = p.maxHp = 55;
    p.speed = 2.9;
    p.weapon = "gun";
    this.peds.push(p);
    return p;
  }

  spawnEnemy(x: number, y: number): Ped {
    const p = this.makePed("enemy", x, y);
    p.hp = p.maxHp = 80 + this.missionNo * 4;
    p.speed = 3.0;
    p.weapon = this.rng.pick(["gun", "uzi", "uzi", "shotgun"] as ItemType[]);
    this.peds.push(p);
    return p;
  }

  spawnCar(x: number, y: number, dir: number): Car {
    const car: Car = {
      id: nextId++, x, y, angle: 0, dir, speed: 0,
      color: this.rng.pick(["#3a5a72", "#7a3050", "#4a7a3a", "#5a5a70", "#8a5a28", "#2a5a8a", "#8a8a92", "#7a2828"]),
      hp: 40, state: "drive", path: null, pathIdx: 0, pilotOut: false, occupants: [],
    };
    this.cars.push(car);
    return car;
  }

  // keep the area around the camera populated
  private populate(): void {
    const cx = this.camX, cy = this.camY;
    // civilians
    let nCiv = 0, nCop = 0;
    for (const p of this.peds) {
      if (p.state === "dead") continue;
      if (p.team === "civ" && !p.vip) nCiv++;
      if (p.team === "cop") nCop++;
    }
    const civTarget = Math.min(CIV_LIMIT, 40 + this.missionNo * 2);
    for (let i = nCiv; i < civTarget; i++) {
      const s = this.ringSpawn(cx, cy, 15, 40);
      if (s) this.spawnCiv(s.x, s.y);
    }
    const copTarget = Math.min(COP_LIMIT, 2 + Math.floor(this.heat / 4));
    for (let i = nCop; i < copTarget; i++) {
      const s = this.ringSpawn(cx, cy, 16, 38);
      if (s) this.spawnCop(s.x, s.y);
    }
    // cars on roads
    const activeCars = this.cars.filter((c) => c.state === "drive").length;
    for (let i = activeCars; i < CAR_LIMIT; i++) {
      const s = this.ringSpawnRoad(cx, cy, 18, 45);
      if (s) {
        const bits = this.city.laneDir[idx(s.x | 0, s.y | 0)];
        for (let d = 0; d < 4; d++) if (bits & DBIT[d]) { this.spawnCar(s.x, s.y, d); break; }
      }
    }
    // despawn far, non-essential things
    for (const p of this.peds) {
      if (p.team === "civ" && !p.vip && !p.persuaded && dist2(p.x, p.y, cx, cy) > 70 * 70) p.deadT = 1e9;
      if (p.team === "cop" && p.state !== "dead" && !p.hostileCop && dist2(p.x, p.y, cx, cy) > 70 * 70) p.deadT = 1e9;
    }
    this.peds = this.peds.filter((p) => !(p.deadT >= 1e9));
    this.cars = this.cars.filter((c) => !(c.state === "drive" && dist2(c.x, c.y, cx, cy) > 80 * 80));
  }

  private ringSpawn(cx: number, cy: number, r0: number, r1: number): { x: number; y: number } | null {
    for (let tries = 0; tries < 12; tries++) {
      const a = this.rng.float(0, Math.PI * 2);
      const r = this.rng.float(r0, r1);
      const x = Math.round(cx + Math.cos(a) * r), y = Math.round(cy + Math.sin(a) * r);
      if (!inGrid(x, y)) continue;
      const t = this.city.tiles[idx(x, y)];
      if (t === 1 || t === 6) return { x: x + 0.5, y: y + 0.5 }; // sidewalk or park
    }
    return null;
  }

  private ringSpawnRoad(cx: number, cy: number, r0: number, r1: number): { x: number; y: number } | null {
    for (let tries = 0; tries < 12; tries++) {
      const a = this.rng.float(0, Math.PI * 2);
      const r = this.rng.float(r0, r1);
      const x = Math.round(cx + Math.cos(a) * r), y = Math.round(cy + Math.sin(a) * r);
      if (inGrid(x, y) && this.city.tiles[idx(x, y)] === T_ROAD) return { x: x + 0.5, y: y + 0.5 };
    }
    return null;
  }

  // ---------- player commands ----------

  selectedAgents(sel: boolean[]): Ped[] {
    return this.agents.filter((a, i) => sel[i] && a.hp > 0);
  }

  cmdMove(sel: boolean[], tx: number, ty: number): void {
    const group = this.selectedAgents(sel);
    let n = 0;
    for (const a of group) {
      a.fireAt = null; a.dropOrder = null; a.pickOrder = null; a.giveOrder = null; a.boardOrder = null;
      if (a.carId !== null) {
        const car = this.cars.find((c) => c.id === a.carId);
        if (car && car.state === "player" && car.occupants[0] === a.id) {
          const p = this.pf.drivePath(car.x, car.y, tx, ty);
          if (p) { car.path = p; car.pathIdx = 0; }
        }
        continue;
      }
      const ox = (n % 2) * 1.4 - 0.7, oy = Math.floor(n / 2) * 1.4 - 0.7;
      const p = this.pf.walkPath(a.x, a.y, tx + ox, ty + oy) ?? this.pf.walkPath(a.x, a.y, tx, ty);
      if (p) { a.path = p; a.pathIdx = 0; a.state = "walk"; }
      n++;
    }
  }

  cmdShoot(sel: boolean[], tx: number, ty: number): void {
    for (const a of this.selectedAgents(sel)) {
      if (a.carId !== null) continue;
      a.fireAt = { x: tx, y: ty, until: this.time + 0.6 };
    }
  }

  cmdDropItem(sel: boolean[], invIdx: number, tx: number, ty: number): void {
    const a = this.selectedAgents(sel)[0];
    if (!a || a.carId !== null || invIdx < 0 || invIdx >= a.inv.length) return;
    a.dropOrder = { invIdx, x: tx, y: ty };
    a.pickOrder = null; a.boardOrder = null; a.giveOrder = null;
    const p = this.pf.walkPath(a.x, a.y, tx, ty);
    if (p) { a.path = p; a.pathIdx = 0; a.state = "walk"; }
  }

  cmdPickup(sel: boolean[], dropId: number): void {
    const a = this.selectedAgents(sel)[0];
    const d = this.drops.find((dd) => dd.id === dropId);
    if (!a || !d || a.carId !== null) return;
    a.pickOrder = dropId; a.dropOrder = null; a.boardOrder = null; a.giveOrder = null;
    const p = this.pf.walkPath(a.x, a.y, d.x, d.y);
    if (p) { a.path = p; a.pathIdx = 0; a.state = "walk"; }
  }

  // drag an item onto a squadmate's doll: hand it over (walking up first if needed)
  cmdGiveItem(sel: boolean[], invIdx: number, targetAgentIdx: number): void {
    const src = this.selectedAgents(sel)[0];
    const target = this.agents[targetAgentIdx];
    if (!src || !target || target === src) return;
    if (src.carId !== null || target.hp <= 0 || target.carId !== null) return;
    if (invIdx < 0 || invIdx >= src.inv.length) return;
    if (target.inv.length >= 8) {
      this.notify(`${this.agentNames[targetAgentIdx] ?? "AGENT"}: INVENTORY FULL`);
      return;
    }
    if (dist2(src.x, src.y, target.x, target.y) < 2.5 * 2.5) {
      this.transferItem(src, invIdx, target);
      return;
    }
    src.giveOrder = { invIdx, targetId: target.id };
    src.dropOrder = null; src.pickOrder = null; src.boardOrder = null;
    const p = this.pf.walkPath(src.x, src.y, target.x, target.y);
    if (p) { src.path = p; src.pathIdx = 0; src.state = "walk"; }
  }

  private transferItem(src: Ped, invIdx: number, target: Ped): void {
    if (invIdx >= src.inv.length || target.inv.length >= 8 || target.hp <= 0) return;
    const [it] = src.inv.splice(invIdx, 1);
    target.inv.push(it);
    if (src.sel === invIdx) src.sel = src.inv.findIndex((s) => ITEMS[s.type].weapon && s.charge > 0);
    else if (src.sel > invIdx) src.sel--;
    if (src.sel >= src.inv.length) src.sel = src.inv.length - 1;
    if (target.sel < 0) target.sel = target.inv.length - 1;
    this.audio.pickup();
    const tName = this.agentNames[target.agentIdx] ?? "AGENT";
    this.notify(`${ITEMS[it.type].name} \u2192 ${tName}`);
  }

  cmdBoardCar(sel: boolean[], carId: number): void {
    const car = this.cars.find((c) => c.id === carId);
    if (!car || !(car.state === "parked" || car.state === "player")) return;
    for (const a of this.selectedAgents(sel)) {
      if (a.carId !== null) continue;
      a.boardOrder = carId; a.dropOrder = null; a.pickOrder = null; a.giveOrder = null;
      const p = this.pf.walkPath(a.x, a.y, car.x, car.y);
      if (p) { a.path = p; a.pathIdx = 0; a.state = "walk"; }
    }
  }

  cmdExitCar(sel: boolean[]): void {
    for (const a of this.selectedAgents(sel)) {
      if (a.carId === null) continue;
      const car = this.cars.find((c) => c.id === a.carId);
      if (!car) { a.carId = null; continue; }
      car.occupants = car.occupants.filter((o) => o !== a.id);
      if (car.occupants.length === 0) { car.state = "parked"; car.path = null; car.speed = 0; }
      a.carId = null;
      const n = this.pf.nearestWalkable((car.x | 0) - 1, (car.y | 0) - 1, 4);
      if (n) { a.x = n.x + 0.5; a.y = n.y + 0.5; } else { a.x = car.x; a.y = car.y; }
    }
  }

  selectItem(agent: Ped, invIdx: number): void {
    if (invIdx < 0 || invIdx >= agent.inv.length) return;
    const it = agent.inv[invIdx];
    const def = ITEMS[it.type];
    if (it.type === "medkit") {
      if (it.charge > 0 && agent.hp < agent.maxHp) {
        agent.hp = agent.maxHp;
        it.charge--;
        this.audio.medkit();
        if (it.charge <= 0) agent.inv.splice(invIdx, 1);
      }
      return; // selection stays where it was
    }
    if (it.type === "shield") {
      agent.shieldOn = !agent.shieldOn;
      this.audio.click();
      return;
    }
    agent.sel = invIdx;
  }

  // ---------- combat ----------

  private fireWeapon(shooter: Ped, item: ItemStack | null, wType: ItemType, tx: number, ty: number): void {
    const def = ITEMS[wType];
    if (item && item.charge <= 0) return;
    if (item) item.charge--;
    shooter.fireCd = def.cooldown;
    const dx = tx - shooter.x, dy = ty - shooter.y;
    const len = Math.max(0.001, Math.sqrt(dx * dx + dy * dy));
    const baseA = Math.atan2(dy, dx);
    this.audio.shoot(wType);
    this.flashes.push({ x: shooter.x, y: shooter.y, life: 0.06 });
    this.alertArea(shooter.x, shooter.y, 14, shooter);
    if (wType === "laser") {
      // hitscan beam, pierces peds, stops at walls
      const maxR = def.range;
      let ex = shooter.x + (dx / len) * maxR, ey = shooter.y + (dy / len) * maxR;
      const steps = Math.ceil(maxR * 3);
      for (let i = 1; i <= steps; i++) {
        const px = shooter.x + (dx / len) * (maxR * i / steps);
        const py = shooter.y + (dy / len) * (maxR * i / steps);
        if (!this.pf.losShot(shooter.x, shooter.y, px, py)) { ex = px; ey = py; break; }
      }
      this.beams.push({ x0: shooter.x, y0: shooter.y, x1: ex, y1: ey, life: 0.12, color: def.color });
      for (const p of this.peds) {
        if (p === shooter || p.state === "dead" || p.carId !== null) continue;
        if (this.pointSegDist(p.x, p.y, shooter.x, shooter.y, ex, ey) < 0.5) {
          this.damagePed(p, def.damage, shooter);
        }
      }
      for (const c of this.cars) {
        if (this.pointSegDist(c.x, c.y, shooter.x, shooter.y, ex, ey) < 0.9) this.damageCar(c, def.damage, shooter);
      }
      return;
    }
    for (let i = 0; i < def.pellets; i++) {
      const a = baseA + (this.rng.next() - 0.5) * def.spread * 2;
      this.projectiles.push({
        x: shooter.x, y: shooter.y,
        vx: Math.cos(a) * def.speed, vy: Math.sin(a) * def.speed,
        dmg: def.damage, team: shooter.team, life: def.range / def.speed, type: wType,
      });
    }
  }

  private pointSegDist(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
    const dx = x1 - x0, dy = y1 - y0;
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) return dist(px, py, x0, y0);
    let t = ((px - x0) * dx + (py - y0) * dy) / l2;
    t = clamp(t, 0, 1);
    return dist(px, py, x0 + t * dx, y0 + t * dy);
  }

  damagePed(p: Ped, dmg: number, from: Ped | null): void {
    if (p.state === "dead") return;
    if (p.team === "player" && p.shieldOn && p.shield > 0) {
      p.shield = Math.max(0, p.shield - dmg * 0.8);
      dmg *= 0.15;
    }
    p.hp -= dmg;
    this.audio.hit();
    this.bloodBurst(p.x, p.y, 3);
    if (p.team === "civ" && p.state !== "flee" && !p.persuaded) {
      this.startFlee(p, from ? { x: from.x, y: from.y } : { x: p.x, y: p.y });
    }
    if (p.team === "cop" && from && from.team === "player") {
      p.hostileCop = true;
      this.heat = Math.max(this.heat, 6);
    }
    if (p.hp <= 0) this.killPed(p, from);
  }

  private killPed(p: Ped, from: Ped | null): void {
    p.hp = 0;
    p.state = "dead";
    p.deadT = 0;
    p.path = null;
    p.animT = 0;
    this.audio.die();
    this.bloodBurst(p.x, p.y, 8);
    this.alertArea(p.x, p.y, 10, from);
    if (from && from.team === "player") {
      this.kills++;
      if (p.team === "enemy") this.creditsEarned += 150;
      else if (p.team === "cop") { this.creditsEarned += 40; this.heat = Math.max(this.heat, 8); }
      else if (p.team === "civ" && !p.vip) { this.creditsEarned -= 25; this.heat += 1.5; }
    }
    // loot drops
    if (p.team === "cop") {
      const t = copDrop(() => this.rng.next());
      if (t) this.addDrop(p.x, p.y, newItem(t));
    } else if (p.team === "enemy") {
      const t = enemyDrop(() => this.rng.next());
      if (t) this.addDrop(p.x, p.y, newItem(t));
      if (this.mission.kind === "killall") {
        this.mission.enemiesLeft--;
        this.notify(`${this.mission.enemiesLeft} HOSTILE AGENTS REMAIN`);
      }
    } else if (p.team === "player") {
      // fallen agents drop their kit
      for (const it of p.inv) this.addDrop(p.x + this.rng.float(-0.6, 0.6), p.y + this.rng.float(-0.6, 0.6), it);
      p.inv = [];
      this.notify("AGENT DOWN");
    }
    // mission consequences
    const m = this.mission;
    if (p.id === m.targetId) {
      if (m.kind === "assassinate") { m.done = true; }
      else if (m.kind === "persuade" || m.kind === "escort") { m.failed = true; m.failReason = "The target was killed."; }
    }
  }

  damageCar(c: Car, dmg: number, from: Ped | null): void {
    if (c.state === "wreck") return;
    c.hp -= dmg;
    if (dmg >= 200) {
      // gauss round: obliterate
      c.state = "wreck";
      this.explode(c.x, c.y, from);
      return;
    }
    if (c.state === "drive") {
      c.state = "stopping";
    }
  }

  private explode(x: number, y: number, from: Ped | null): void {
    this.audio.explosion();
    for (let i = 0; i < 26; i++) {
      const a = this.rng.float(0, Math.PI * 2);
      const s = this.rng.float(1, 7);
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.7, maxLife: 0.7, color: this.rng.pick(["#ff9b2f", "#ffdf6b", "#ff4d2f", "#888"]), size: 2 });
    }
    for (const p of this.peds) {
      if (p.state === "dead") continue;
      const d = dist(p.x, p.y, x, y);
      if (d < 3.5) this.damagePed(p, (1 - d / 3.5) * 250, from);
    }
    this.alertArea(x, y, 18, from);
  }

  private bloodBurst(x: number, y: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const a = this.rng.float(0, Math.PI * 2);
      const s = this.rng.float(0.4, 2.4);
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.5, maxLife: 0.5, color: "#a01020", size: 1 });
    }
  }

  addDrop(x: number, y: number, item: ItemStack): void {
    this.drops.push({ id: nextId++, x, y, item });
  }

  private alertArea(x: number, y: number, r: number, source: Ped | null): void {
    const r2 = r * r;
    for (const p of this.peds) {
      if (p.state === "dead" || dist2(p.x, p.y, x, y) > r2) continue;
      if (p.team === "civ" && !p.persuaded && !p.vip && p.state !== "flee") {
        if (this.rng.chance(0.8)) this.startFlee(p, { x, y });
      }
      if (p.team === "cop" && source && source.team === "player") {
        p.hostileCop = true;
        this.heat = Math.max(this.heat, 4);
      }
    }
  }

  private startFlee(p: Ped, from: { x: number; y: number }): void {
    p.state = "flee";
    p.fleeFrom = { ...from };
    p.thinkT = 0;
    p.speed = 3.6;
  }

  // ---------- per-frame update ----------

  private popTimer = 0;

  update(dt: number, viewRadius: number): void {
    this.time += dt;
    this.heat = Math.max(this.mission.kind === "assassinate" ? 10 : 0, this.heat - dt * 0.12);
    this.popTimer -= dt;
    if (this.popTimer <= 0) { this.popTimer = 1.2; this.populate(); }

    this.updateMission(dt, viewRadius);
    for (const p of this.peds) this.updatePed(p, dt);
    for (const c of this.cars) this.updateCar(c, dt);
    this.updateProjectiles(dt);

    for (const b of this.beams) b.life -= dt;
    this.beams = this.beams.filter((b) => b.life > 0);
    for (const f of this.flashes) f.life -= dt;
    this.flashes = this.flashes.filter((f) => f.life > 0);
    for (const pt of this.particles) {
      pt.x += pt.vx * dt; pt.y += pt.vy * dt;
      pt.vx *= 0.92; pt.vy *= 0.92;
      pt.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    // corpse cleanup (not vips - leaving evidence is thematic, but cap the list)
    this.peds = this.peds.filter((p) => !(p.state === "dead" && p.deadT > 30 && p.team !== "player"));

    this.checkEndConditions();
  }

  private updateMission(dt: number, viewRadius: number): void {
    const m = this.mission;
    if (m.done || m.failed) return;
    const vip = this.peds.find((p) => p.id === m.targetId) ?? null;

    if (m.kind === "persuade" || m.kind === "escort") {
      // enemy pressure waves spawning just outside the viewport
      m.waveT -= dt;
      const escortActive = vip !== null && (m.kind === "escort" ? true : vip.persuaded);
      if (m.waveT <= 0) {
        m.waveT = Math.max(8, 20 - this.missionNo) + this.rng.float(0, 6);
        const n = escortActive ? this.rng.int(2, 3) : 1;
        for (let i = 0; i < n; i++) {
          const a = this.rng.float(0, Math.PI * 2);
          const r = viewRadius + this.rng.float(2, 6);
          const x = clamp(this.camX + Math.cos(a) * r, 2, GRID - 3);
          const y = clamp(this.camY + Math.sin(a) * r, 2, GRID - 3);
          const nw = this.pf.nearestWalkable(x | 0, y | 0, 6);
          if (nw) this.spawnEnemy(nw.x + 0.5, nw.y + 0.5);
        }
      }
      if (vip) {
        if (m.kind === "escort" && m.phase === 0) {
          // any living agent close by flips the vip to follower
          for (const a of this.agents) {
            if (a.hp > 0 && dist2(a.x, a.y, vip.x, vip.y) < 2.5 * 2.5) {
              m.phase = 1;
              vip.persuaded = true;
              vip.followId = a.id;
              vip.state = "follow";
              this.audio.objective();
              this.notify("VIP SECURED - RETURN TO INSERTION POINT");
              break;
            }
          }
        }
        if (vip.persuaded && m.zone && dist2(vip.x, vip.y, m.zone.x, m.zone.y) < m.zone.r * m.zone.r) {
          m.done = true;
        }
      }
    }
    if (m.kind === "killall" && m.enemiesLeft <= 0) m.done = true;
  }

  private updatePed(p: Ped, dt: number): void {
    if (p.state === "dead") { p.deadT += dt; p.animT += dt; return; }
    if (p.carId !== null) return; // riding
    p.animT += dt;
    p.fireCd = Math.max(0, p.fireCd - dt);
    p.thinkT -= dt;

    if (p.team === "player") this.updateAgent(p, dt);
    else if (p.team === "civ") this.updateCiv(p, dt);
    else if (p.team === "cop") this.updateCop(p, dt);
    else this.updateEnemy(p, dt);

    this.followPath(p, dt);
  }

  private followPath(p: Ped, dt: number): void {
    if (!p.path || p.pathIdx >= p.path.length) {
      if (p.state === "walk") p.state = "idle";
      return;
    }
    const wp = p.path[p.pathIdx];
    const dx = wp.x - p.x, dy = wp.y - p.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    const step = p.speed * dt * (p.state === "flee" ? 1.15 : 1);
    if (d < Math.max(0.12, step)) {
      p.x = wp.x; p.y = wp.y;
      p.pathIdx++;
      if (p.pathIdx >= p.path.length) {
        p.path = null;
        if (p.state === "walk" || p.state === "flee") p.state = "idle";
        this.onArrive(p);
      }
      return;
    }
    p.x += (dx / d) * step;
    p.y += (dy / d) * step;
    p.dir = this.dirOf(dx, dy);
  }

  private dirOf(dx: number, dy: number): number {
    // world velocity -> screen facing (iso projection folded in)
    const sx = (dx - dy), sy = (dx + dy) * 0.5;
    const a = Math.atan2(sy, sx);
    let i = Math.round((a - Math.PI / 2) / (Math.PI / 4));
    i = ((-i % 8) + 8) % 8;
    return i;
  }

  private onArrive(p: Ped): void {
    if (p.team !== "player") return;
    if (p.dropOrder) {
      const o = p.dropOrder; p.dropOrder = null;
      if (o.invIdx < p.inv.length) {
        const [it] = p.inv.splice(o.invIdx, 1);
        this.addDrop(p.x, p.y, it);
        if (p.sel >= p.inv.length) p.sel = p.inv.length - 1;
        this.audio.drop();
      }
    }
    if (p.pickOrder !== null) {
      const d = this.drops.find((dd) => dd.id === p.pickOrder);
      p.pickOrder = null;
      if (d && dist2(d.x, d.y, p.x, p.y) < 2 * 2 && p.inv.length < 8) {
        this.drops = this.drops.filter((dd) => dd.id !== d.id);
        p.inv.push(d.item);
        if (p.sel < 0) p.sel = p.inv.length - 1;
        this.audio.pickup();
        this.notify(`${ITEMS[d.item.type].name} ACQUIRED`);
      }
    }
    if (p.giveOrder) {
      const o = p.giveOrder;
      const target = this.peds.find((q) => q.id === o.targetId);
      if (!target || target.state === "dead" || target.carId !== null || o.invIdx >= p.inv.length) {
        p.giveOrder = null;
      } else if (dist2(p.x, p.y, target.x, target.y) < 2.5 * 2.5) {
        p.giveOrder = null;
        this.transferItem(p, o.invIdx, target);
      } else {
        // target wandered off - keep following
        const path = this.pf.walkPath(p.x, p.y, target.x, target.y);
        if (path) { p.path = path; p.pathIdx = 0; p.state = "walk"; }
        else p.giveOrder = null;
      }
    }
    if (p.boardOrder !== null) {
      const car = this.cars.find((c) => c.id === p.boardOrder);
      p.boardOrder = null;
      if (car && (car.state === "parked" || car.state === "player") && dist2(car.x, car.y, p.x, p.y) < 2.5 * 2.5 && car.occupants.length < 4) {
        car.occupants.push(p.id);
        car.state = "player";
        p.carId = car.id;
        p.path = null;
        this.audio.carStart();
      }
    }
  }

  private updateAgent(p: Ped, dt: number): void {
    // shield drain
    if (p.shieldOn) {
      const belt = p.inv.find((s) => s.type === "shield");
      if (!belt || belt.charge <= 0) { p.shieldOn = false; }
      else {
        belt.charge = Math.max(0, belt.charge - dt * 3);
        p.shield = belt.charge;
      }
    }
    const weapon = p.sel >= 0 && p.sel < p.inv.length ? p.inv[p.sel] : null;
    const wdef = weapon ? ITEMS[weapon.type] : null;

    // persuadertron: auto-persuade nearby target when selected
    if (weapon && weapon.type === "persuadertron") {
      for (const t of this.peds) {
        if (t.team !== "civ" || t.state === "dead" || t.persuaded) continue;
        if (dist2(t.x, t.y, p.x, p.y) < ITEMS.persuadertron.range ** 2) {
          t.persuaded = true;
          t.followId = p.id;
          t.state = "follow";
          t.speed = 3.0;
          this.audio.persuade();
          if (t.id === this.mission.targetId) {
            this.audio.objective();
            this.notify("TARGET PERSUADED - ESCORT TO EXTRACTION ZONE");
          }
        }
      }
    }

    // manual fire order
    if (p.fireAt && weapon && wdef && wdef.weapon && weapon.charge > 0) {
      if (p.fireCd <= 0) {
        this.fireWeapon(p, weapon, weapon.type, p.fireAt.x, p.fireAt.y);
        if (!p.path) p.dir = this.dirOf(p.fireAt.x - p.x, p.fireAt.y - p.y);
      }
      if (this.time > p.fireAt.until) p.fireAt = null;
    } else if (p.fireAt && this.time > p.fireAt.until) {
      p.fireAt = null;
    }

    // auto-engage hostiles in range (never civilians)
    if (!p.fireAt && weapon && wdef && wdef.weapon && weapon.charge > 0 && p.fireCd <= 0) {
      let best: Ped | null = null; let bd = wdef.range * wdef.range;
      for (const t of this.peds) {
        if (t.state === "dead") continue;
        const hostile = t.team === "enemy" || (t.team === "cop" && (t.hostileCop || this.heat >= 6));
        if (!hostile) continue;
        const d2 = dist2(t.x, t.y, p.x, p.y);
        if (d2 < bd && this.pf.losShot(p.x, p.y, t.x, t.y)) { best = t; bd = d2; }
      }
      if (best) {
        this.fireWeapon(p, weapon, weapon.type, best.x + this.rng.float(-0.2, 0.2), best.y + this.rng.float(-0.2, 0.2));
        if (!p.path) p.dir = this.dirOf(best.x - p.x, best.y - p.y);
      }
    }
  }

  private updateCiv(p: Ped, dt: number): void {
    if (p.persuaded && p.followId !== null) {
      const leader = this.peds.find((q) => q.id === p.followId && q.state !== "dead") ?? this.agents.find((a) => a.hp > 0);
      if (leader && leader.hp > 0) {
        p.followId = leader.id;
        if (p.thinkT <= 0) {
          p.thinkT = 0.5;
          if (dist2(p.x, p.y, leader.x, leader.y) > 2.2 * 2.2) {
            const path = this.pf.walkPath(p.x, p.y, leader.x, leader.y);
            if (path) { p.path = path; p.pathIdx = 0; p.state = "follow"; }
          }
        }
      }
      return;
    }
    if (p.state === "flee") {
      if (p.thinkT <= 0) {
        p.thinkT = this.rng.float(2, 4);
        const away = p.fleeFrom ? Math.atan2(p.y - p.fleeFrom.y, p.x - p.fleeFrom.x) : this.rng.float(0, Math.PI * 2);
        const tx = clamp(p.x + Math.cos(away) * 14 + this.rng.float(-4, 4), 2, GRID - 3);
        const ty = clamp(p.y + Math.sin(away) * 14 + this.rng.float(-4, 4), 2, GRID - 3);
        const path = this.pf.walkPath(p.x, p.y, tx, ty);
        if (path) { p.path = path; p.pathIdx = 0; }
        else { p.state = "idle"; p.speed = this.rng.float(1.6, 2.4); }
        if (this.rng.chance(0.35)) { p.state = "idle"; p.speed = this.rng.float(1.6, 2.4); p.fleeFrom = null; }
      }
      return;
    }
    if (p.thinkT <= 0) {
      p.thinkT = this.rng.float(2, 7);
      if (this.rng.chance(0.75)) {
        const tx = clamp(p.x + this.rng.float(-10, 10), 2, GRID - 3);
        const ty = clamp(p.y + this.rng.float(-10, 10), 2, GRID - 3);
        const path = this.pf.walkPath(p.x, p.y, tx, ty);
        if (path) { p.path = path; p.pathIdx = 0; p.state = "walk"; }
      }
    }
  }

  private updateCop(p: Ped, dt: number): void {
    const hostile = p.hostileCop || this.heat >= 6;
    if (hostile) {
      let best: Ped | null = null; let bd = 1e9;
      for (const a of this.agents) {
        if (a.hp <= 0 || a.carId !== null) continue;
        const d2 = dist2(a.x, a.y, p.x, p.y);
        if (d2 < bd) { best = a; bd = d2; }
      }
      if (best) {
        const d = Math.sqrt(bd);
        if (d < 8 && this.pf.losShot(p.x, p.y, best.x, best.y)) {
          p.path = null; p.state = "idle";
          p.dir = this.dirOf(best.x - p.x, best.y - p.y);
          if (p.fireCd <= 0) {
            this.fireWeapon(p, null, "gun", best.x + this.rng.float(-0.7, 0.7), best.y + this.rng.float(-0.7, 0.7));
            p.fireCd *= NPC_FIRE_MULT;
          }
        } else if (p.thinkT <= 0) {
          p.thinkT = 1.2;
          const path = this.pf.walkPath(p.x, p.y, best.x, best.y);
          if (path) { p.path = path; p.pathIdx = 0; p.state = "walk"; }
        }
        return;
      }
    }
    // patrol
    if (p.thinkT <= 0) {
      p.thinkT = this.rng.float(3, 8);
      const tx = clamp(p.x + this.rng.float(-12, 12), 2, GRID - 3);
      const ty = clamp(p.y + this.rng.float(-12, 12), 2, GRID - 3);
      const path = this.pf.walkPath(p.x, p.y, tx, ty);
      if (path) { p.path = path; p.pathIdx = 0; p.state = "walk"; }
    }
  }

  private updateEnemy(p: Ped, dt: number): void {
    // choose target: the vip (if persuaded/escorted) or nearest agent
    let best: Ped | null = null; let bd = 1e9;
    const m = this.mission;
    const vip = (m.kind === "persuade" || m.kind === "escort") ? this.peds.find((q) => q.id === m.targetId && q.state !== "dead" && q.persuaded) : undefined;
    if (vip) { best = vip; bd = dist2(vip.x, vip.y, p.x, p.y); }
    for (const a of this.agents) {
      if (a.hp <= 0 || a.carId !== null) continue;
      const d2 = dist2(a.x, a.y, p.x, p.y);
      if (d2 < bd) { best = a; bd = d2; }
    }
    if (!best) return;
    const d = Math.sqrt(bd);
    const wdef = ITEMS[p.weapon ?? "gun"];
    const hunting = m.kind === "killall" ? d < 55 || this.rng.chance(0.001) : true;
    if (d < wdef.range * 0.9 && this.pf.losShot(p.x, p.y, best.x, best.y)) {
      p.path = null; p.state = "idle";
      p.dir = this.dirOf(best.x - p.x, best.y - p.y);
      if (p.fireCd <= 0) {
        this.fireWeapon(p, null, p.weapon ?? "gun", best.x + this.rng.float(-0.5, 0.5), best.y + this.rng.float(-0.5, 0.5));
        p.fireCd *= NPC_FIRE_MULT * 0.75; // rival agents shoot faster than cops
      }
    } else if (hunting && p.thinkT <= 0) {
      p.thinkT = this.rng.float(1.0, 2.0);
      const path = this.pf.walkPath(p.x, p.y, best.x, best.y);
      if (path) { p.path = path; p.pathIdx = 0; p.state = "walk"; }
    } else if (!hunting && p.thinkT <= 0) {
      p.thinkT = this.rng.float(3, 7);
      const tx = clamp(p.x + this.rng.float(-8, 8), 2, GRID - 3);
      const ty = clamp(p.y + this.rng.float(-8, 8), 2, GRID - 3);
      const path = this.pf.walkPath(p.x, p.y, tx, ty);
      if (path) { p.path = path; p.pathIdx = 0; p.state = "walk"; }
    }
  }

  private updateCar(c: Car, dt: number): void {
    if (c.state === "wreck" || c.state === "parked") return;
    if (c.state === "stopping") {
      c.speed = Math.max(0, c.speed - dt * 12);
      if (c.speed <= 0.01 && !c.pilotOut) {
        c.pilotOut = true;
        c.state = "parked";
        // pilot dismounts and flees
        const n = this.pf.nearestWalkable((c.x | 0) + 1, (c.y | 0) + 1, 4);
        const pilot = this.spawnCiv(n ? n.x + 0.5 : c.x + 1, n ? n.y + 0.5 : c.y);
        this.startFlee(pilot, { x: c.x, y: c.y });
      }
      this.advanceCarAlongDir(c, dt);
      return;
    }
    if (c.state === "player") {
      if (!c.path || c.pathIdx >= c.path.length) { c.speed = Math.max(0, c.speed - dt * 10); return; }
      c.speed = Math.min(9, c.speed + dt * 8);
      const wp = c.path[c.pathIdx];
      const dx = wp.x - c.x, dy = wp.y - c.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const step = c.speed * dt;
      if (d < Math.max(0.15, step)) {
        c.x = wp.x; c.y = wp.y; c.pathIdx++;
        if (c.pathIdx >= c.path.length) { c.path = null; c.speed = 0; }
      } else {
        c.x += (dx / d) * step; c.y += (dy / d) * step;
        c.angle = Math.atan2((dx + dy) * 0.5, dx - dy);
      }
      // keep the riders with the car
      for (const oid of c.occupants) {
        const p = this.peds.find((q) => q.id === oid);
        if (p) { p.x = c.x; p.y = c.y; }
      }
      return;
    }
    // AI traffic: follow lane field tile to tile
    c.speed = Math.min(6.5, c.speed + dt * 5);
    // brake for cars ahead
    for (const o of this.cars) {
      if (o === c || o.state === "wreck") continue;
      const aheadX = c.x + DX[c.dir] * 2.2, aheadY = c.y + DY[c.dir] * 2.2;
      if (dist2(o.x, o.y, aheadX, aheadY) < 1.4 * 1.4) { c.speed = Math.min(c.speed, Math.max(0, o.speed - 0.5)); }
    }
    this.advanceCarAlongDir(c, dt);
  }

  private advanceCarAlongDir(c: Car, dt: number): void {
    const tx = Math.floor(c.x), ty = Math.floor(c.y);
    const cx = tx + 0.5, cy = ty + 0.5;
    // steer toward tile center line
    const move = c.speed * dt;
    let nx = c.x + DX[c.dir] * move;
    let ny = c.y + DY[c.dir] * move;
    if (DX[c.dir] !== 0) ny += (cy - c.y) * Math.min(1, dt * 6);
    else nx += (cx - c.x) * Math.min(1, dt * 6);
    // when crossing the tile center, decide the next direction
    const passed = DX[c.dir] > 0 ? nx >= cx && c.x < cx : DX[c.dir] < 0 ? nx <= cx && c.x > cx
      : DY[c.dir] > 0 ? ny >= cy && c.y < cy : ny <= cy && c.y > cy;
    if (passed) {
      const bits = this.city.laneDir[idx(tx, ty)] || 0;
      const options: number[] = [];
      for (let d = 0; d < 4; d++) {
        if ((bits & DBIT[d]) === 0) continue;
        if ((d + 2) % 4 === c.dir && bits !== DBIT[d]) continue; // avoid u-turn unless forced
        const fx = tx + DX[d], fy = ty + DY[d];
        if (isRoad(this.city, fx, fy)) options.push(d);
      }
      if (options.length > 0) {
        // prefer going straight
        c.dir = options.includes(c.dir) && this.rng.chance(0.75) ? c.dir : this.rng.pick(options);
      } else {
        // dead end / edge: despawn by wrecking silently at map border
        if (tx <= 1 || ty <= 1 || tx >= GRID - 2 || ty >= GRID - 2) { c.hp = -999; c.state = "wreck"; return; }
        c.dir = (c.dir + 2) % 4;
      }
    }
    c.x = nx; c.y = ny;
    // world-space heading (the renderer projects it; screen-space here made
    // traffic render rotated off its lane)
    const target = Math.atan2(DY[c.dir], DX[c.dir]);
    let da = target - c.angle;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    c.angle += da * Math.min(1, dt * 8);
  }

  private updateProjectiles(dt: number): void {
    for (const pr of this.projectiles) {
      const steps = Math.ceil(Math.max(1, (Math.abs(pr.vx) + Math.abs(pr.vy)) * dt * 2));
      for (let s = 0; s < steps && pr.life > 0; s++) {
        const sdt = dt / steps;
        pr.x += pr.vx * sdt; pr.y += pr.vy * sdt;
        pr.life -= sdt;
        const txi = Math.floor(pr.x), tyi = Math.floor(pr.y);
        if (!inGrid(txi, tyi)) { pr.life = 0; break; }
        const t = this.city.tiles[idx(txi, tyi)];
        if (t === 3 || t === 4) { // wall / building
          pr.life = 0;
          this.particles.push({ x: pr.x, y: pr.y, vx: 0, vy: 0, life: 0.15, maxLife: 0.15, color: "#ccc", size: 1 });
          break;
        }
        // hit peds
        for (const p of this.peds) {
          if (p.state === "dead" || p.team === pr.team || p.carId !== null) continue;
          if (pr.team === "cop" && p.team === "civ") continue;
          if (pr.team === "enemy" && (p.team === "cop")) continue;
          if (dist2(p.x, p.y, pr.x, pr.y) < 0.35) {
            if (pr.type === "gauss") { this.explode(pr.x, pr.y, this.pedByTeamNear(pr.team, pr.x, pr.y)); }
            else this.damagePed(p, pr.dmg, this.pedByTeamNear(pr.team, pr.x, pr.y));
            pr.life = 0;
            break;
          }
        }
        if (pr.life <= 0) break;
        // hit cars
        for (const car of this.cars) {
          if (car.state === "wreck") continue;
          if (dist2(car.x, car.y, pr.x, pr.y) < 0.8) {
            if (pr.type === "gauss") this.explode(pr.x, pr.y, this.pedByTeamNear(pr.team, pr.x, pr.y));
            this.damageCar(car, pr.dmg, null);
            // riders take the hit too
            for (const oid of car.occupants) {
              const rider = this.peds.find((q) => q.id === oid);
              if (rider) this.damagePed(rider, pr.dmg * 0.5, null);
            }
            pr.life = 0;
            break;
          }
        }
      }
      if (pr.life <= 0 && pr.type === "gauss" && inGrid(pr.x | 0, pr.y | 0)) {
        // gauss round detonates at end of flight even without a direct hit
      }
    }
    this.projectiles = this.projectiles.filter((p) => p.life > 0);
  }

  private pedByTeamNear(team: Team, x: number, y: number): Ped | null {
    let best: Ped | null = null; let bd = 1e9;
    for (const p of this.peds) {
      if (p.team !== team || p.state === "dead") continue;
      const d = dist2(p.x, p.y, x, y);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  private checkEndConditions(): void {
    if (this.result) return;
    const m = this.mission;
    const alive = this.agents.filter((a) => a.hp > 0).length;
    if (alive === 0) {
      this.result = { success: false, reason: "All agents were terminated.", kills: this.kills, creditsEarned: 0 };
      this.audio.fail();
      return;
    }
    if (m.failed) {
      this.result = { success: false, reason: m.failReason || "Mission failed.", kills: this.kills, creditsEarned: Math.max(0, this.creditsEarned) };
      this.audio.fail();
      return;
    }
    if (m.done) {
      const bonus = 800 + this.missionNo * 300;
      this.creditsEarned += bonus;
      this.result = { success: true, reason: "Objective complete.", kills: this.kills, creditsEarned: Math.max(0, this.creditsEarned) };
      this.audio.objective();
    }
  }

  // Objective marker for the minimap / hud. Null if nothing to point at.
  objectivePoint(): { x: number; y: number } | null {
    const m = this.mission;
    if (m.done || m.failed) return null;
    if (m.kind === "killall") {
      let best: Ped | null = null; let bd = 1e9;
      for (const p of this.peds) {
        if (p.team !== "enemy" || p.state === "dead") continue;
        const d = dist2(p.x, p.y, this.camX, this.camY);
        if (d < bd) { bd = d; best = p; }
      }
      return best ? { x: best.x, y: best.y } : null;
    }
    const vip = this.peds.find((p) => p.id === m.targetId);
    if (!vip || vip.state === "dead") return null;
    if ((m.kind === "persuade" || m.kind === "escort") && vip.persuaded && m.zone) {
      return { x: m.zone.x, y: m.zone.y };
    }
    return { x: vip.x, y: vip.y };
  }
}
