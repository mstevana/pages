// The live mission world: pedestrians, cops, enemy agents, cars, projectiles,
// dropped items, objectives, and all the AI that drives them.

import { City, DBIT, DX, DY, GARAGE_LEVEL, idx, inGrid, isRoad, isWalkable, Kerb, kerbAt, Station, surfaceNear, T_ROAD, trackCentre, TRAIN_LEVEL } from "../city/citygen";
import { AudioEngine } from "../engine/audio";
import { Rng } from "../engine/rng";
import { GRID, Weather, clamp, dist, dist2 } from "../engine/util";
import { ITEMS, ItemStack, ItemType, copDrop, enemyDrop, newItem, weaponDps } from "./items";
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
  z: number;              // standing height in storeys: 0 street, >0 roof or platform
  dir: number;            // 0..7 facing
  hp: number; maxHp: number;
  state: PedState;
  path: { x: number; y: number; z?: number; stair?: boolean }[] | null;
  pathIdx: number;
  speed: number;
  animT: number;
  deadT: number;          // time since death
  thinkT: number;         // AI repath/decide timer
  fleeFrom: { x: number; y: number } | null;
  dodgeT: number;         // cooldown after jumping clear of a car
  dodgeSpeed: number;     // the pace to go back to afterwards, 0 when not dodging
  homeX: number;          // the patch this one patrols, -1 for none
  homeY: number;
  fireCd: number;
  aimT: number;              // reaction delay remaining before the first shot
  aimTargetId: number | null; // who this NPC is currently drawing a bead on
  weapon: ItemType | null; // for cops/enemies
  // player agents only
  agentIdx: number;        // 0..3, -1 otherwise
  inv: ItemStack[];
  sel: number;             // selected inventory index, -1 none
  shieldOn: boolean;
  shield: number;          // shield charge if shieldOn
  fireAt: { x: number; y: number; z: number; until: number } | null;
  dropOrder: { invIdx: number; x: number; y: number } | null;
  pickOrder: number | null; // drop id
  giveOrder: { invIdx: number; targetId: number } | null; // hand item to a squadmate
  carId: number | null;     // inside car
  trainId: number | null;   // riding an elevated train
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
  z: number;              // the level it stands on: 0 street, negative in a garage
  angle: number;          // rendered angle in *screen* space
  dir: number;            // current lane dir 0..3 (N,E,S,W)
  speed: number;
  hp: number;
  state: "drive" | "stopping" | "parked" | "player" | "wreck" | "launching" | "docking";
  model: number;          // which of the 24 chassis designs
  glide: { x: number; y: number; a: number } | null; // kerb <-> lane manoeuvre
  path: { x: number; y: number; z?: number }[] | null;
  pathIdx: number;
  pilotOut: boolean;
  occupants: number[];    // agent ped ids
  waitT: number;          // seconds spent stopped behind another car
  fuse?: number;          // seconds until a neighbouring blast sets this one off
  chainFrom?: Ped | null; // who gets the credit when that fuse runs out
  ringT?: number;         // consecutive roundabout tiles it has circulated
  flash?: number;         // seconds of boarding-feedback flash left
  flashOk?: boolean;      // green when the order took, red when it could not
}

export interface Projectile {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  dmg: number;
  team: Team;
  life: number;
  type: ItemType;
}

export interface Beam { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; life: number; maxLife: number; color: string; w: number; }
export interface Drop { id: number; x: number; y: number; item: ItemStack; }
export type FxKind = "blood" | "fire" | "smoke" | "spark" | "debris";
export interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; maxLife: number; color: string; size: number;
  kind: FxKind; lift: number; liftV: number; grow: number; drag: number;
}
export interface Flash { x: number; y: number; life: number; maxLife: number; r: number; ring: boolean; }
// A tapped destination. The ring holds while anyone ordered there is still on
// their way, so the marker answers "have they got there yet" rather than just
// "the tap registered".
export interface Ping {
  x: number; y: number; z: number;
  age: number;             // seconds since the tap - drives the shockwave
  fade: number;            // 1 while someone is still walking, then down to 0
  ok: boolean;
  movers: number[];        // the agents ordered there
  carId: number | null;    // ...or the car they are riding in
}
const PING_FADE = 0.45;    // seconds to die back once everyone has arrived
const PING_MAX = 45;       // ...and a ceiling, so a stuck agent cannot pin it
const PING_MIN = 0.9;      // every marker is up this long, even a refused one

// How much a car takes before it is written off. A blast still does for one
// outright, whatever this is - that is the `dmg >= 200` rule in damageCar, and
// it is what makes a chain of parked cars go up together.
const CAR_HP = 180;

// Rival agents deploy as fire teams rather than one at a time.
const SQUAD_MIN = 3;
const SQUAD_MAX = 4;
const SQUAD_SPREAD = 2.5;   // tiles they are set down within
const SQUAD_ROAM = 4;       // ...and how far they drift from the team's patch

// Getting out of the way of traffic.
const DODGE_MIN_SPEED = 2.2;   // slower than this and it is not a threat
const DODGE_LOOK = 0.85;       // seconds of the car's travel they look ahead
const DODGE_LOOK_MAX = 11;     // tiles, however fast it is going
const DODGE_WIDE = 0.85;       // tiles either side of its line - runDownPeds kills at 0.6
const DODGE_CLEAR = 2.6;       // tiles they try to put between themselves and it
const DODGE_SPEED = 4.6;       // a sprint, not a jog
const DODGE_COOLDOWN = 1.2;    // seconds before they will jump again

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

// A train on an elevated line. It runs between stations, stands for a while at
// each, and turns round at the end of the line - it never leaves the map.
export interface Train {
  id: number;
  line: number;
  u: number;             // distance along the line, in tiles
  dir: 1 | -1;
  speed: number;
  state: "run" | "dwell";
  dwell: number;         // seconds left standing
  stop: number;          // index into the line's stop list it is heading for
  occupants: number[];
  flash?: number;
  flashOk?: boolean;
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
const BLAST_R = 3.5;      // a wrecked car hurts everyone inside this radius
const KERB_GAP = 3;       // clear length a car needs to itself at the kerb
// How long a vehicle lights up to acknowledge an order to board it.
export const BOARD_FLASH = 0.5;

// A car caught in a blast goes up a beat later, so a row of parked cars cooks
// off one after another instead of all at once.
export const CHAIN_FUSE = 0.5;
export const CHAIN_R = 2.6;     // tiles: touching, or nearly

// Stairs are walked at three quarters of open-ground pace.
export const STAIR_PACE = 0.75;

export const TRAIN_SEG = 1.9;   // length of one car, in tiles
export const TRAIN_CARS = 4;    // cars in a set
// A train's u is the middle of the set, not its nose. Tracking the nose meant
// every car flipped to the far side of it the instant the line reversed, which
// read as the whole train jumping the length of itself at the terminus.
export const TRAIN_HALF = ((TRAIN_CARS - 1) * TRAIN_SEG) / 2;
export const TRAIN_NOSE = TRAIN_HALF + TRAIN_SEG / 2;   // to the very front
const TRAIN_DWELL = 5;    // seconds a train stands at each platform
const TRAIN_CRUISE = 11;  // tiles a second at line speed
const TRAIN_ACCEL = 6;    // tiles a second squared, braking and pulling away
const WARD_CLEAR = 1.5;      // how wide a berth every gun gives the escorted civilian
const WARD_STANDOFF = 0.8;   // how close to the mark he may stand and still be clear
const COP_LIMIT = 4;
const NPC_FIRE_MULT = 2.1;        // NPCs shoot slower than player agents
const NPC_RANGE_MULT = 0.85;      // hostiles engage 15% closer than the weapon's reach
const NPC_ACCURACY = 0.85;        // ...and are 15% less accurate (wider cone)
const NPC_SPREAD_MULT = 1 / NPC_ACCURACY;
const NPC_AIM_MIN = 0.55, NPC_AIM_MAX = 0.95; // reaction time before the first shot

export class World {
  rng: Rng;
  peds: Ped[] = [];
  cars: Car[] = [];
  trains: Train[] = [];
  projectiles: Projectile[] = [];
  beams: Beam[] = [];
  drops: Drop[] = [];
  particles: Particle[] = [];
  flashes: Flash[] = [];
  pings: Ping[] = [];   // feedback markers for tapped destinations
  mission: Mission;
  agents: Ped[] = [];              // the (up to) 4 player agents, index-stable
  time = 0;
  heat = 0;                        // police alert level
  kills = 0;
  creditsEarned = 0;
  // the sector's police force is finite: officers killed never come back
  policeTotal = 0;
  policeLost = 0;
  camX: number; camY: number;      // camera focus in tile coords (set by main)
  uiSelected: boolean[] = [true, true, true, true]; // which agents the UI has selected
  agentNames: string[] = [];
  private wardPed: Ped | null = null;   // the civilian under the squad's protection
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
      p.hp = AGENT_HP; // every agent deploys at full health
      p.maxHp = AGENT_HP;
      p.inv = sa.inv.map((s) => ({ ...s }));
      p.sel = p.inv.findIndex((s) => ITEMS[s.type].weapon && s.charge > 0);
      p.speed = 3.1;
      this.agents.push(p);
      this.peds.push(p);
    }

    // the sector is policed by density, not by a flat quota: the avenues carve
    // the city into blocks, and one officer is assigned to every two of them
    const blocks = (city.vRoads.length + 1) * (city.hRoads.length + 1);
    this.policeTotal = Math.max(4, Math.round(blocks / 2));

    // one train per line, standing at the first platform ready to leave
    for (let li = 0; li < city.skytrains.length; li++) {
      const stops = city.skytrains[li].stops;
      if (stops.length < 2) continue;
      this.trains.push({
        id: nextId++, line: li, u: stops[0], dir: 1, speed: 0,
        state: "dwell", dwell: TRAIN_DWELL, stop: 1, occupants: [],
      });
    }

    // The garages are not empty: a few cars stand on each floor, parked in
    // bays. Every car in one garage faces the same way, which makes keeping
    // them apart a matter of two distances - a car's length along that facing,
    // its width across it - rather than a general box-overlap test.
    const BAY_LONG = 3.2;      // a car is 2.7 tiles at its longest
    const BAY_WIDE = 1.5;      // and a shade over one tile across
    for (const gar of city.garages) {
      const n = Math.max(2, Math.min(6, Math.floor((gar.w * gar.h) / 9)));
      const facing = this.rng.chance(0.5) ? 0 : Math.PI / 2;
      const bays: { along: number; across: number }[] = [];
      for (let k = 0, tries = 0; k < n && tries < 80; tries++) {
        const gx = gar.x + 1 + this.rng.int(0, Math.max(0, gar.w - 3));
        const gy = gar.y + 1 + this.rng.int(0, Math.max(0, gar.h - 3));
        if (surfaceNear(city, gx, gy, GARAGE_LEVEL, 0.01) < 0) continue;
        const along = facing === 0 ? gx + 0.5 : gy + 0.5;
        const across = facing === 0 ? gy + 0.5 : gx + 0.5;
        if (bays.some((b) => Math.abs(b.along - along) < BAY_LONG
                          && Math.abs(b.across - across) < BAY_WIDE)) continue;
        bays.push({ along, across });
        const car = this.spawnCar(gx + 0.5, gy + 0.5, facing === 0 ? 1 : 2);
        car.state = "parked";
        car.pilotOut = true;
        car.z = GARAGE_LEVEL;
        car.angle = facing;
        k++;
      }
    }

    // a car or two per block starts the mission standing at the kerb, on
    // whichever stretch of pavement the block happens to offer
    for (const k of this.pickKerbs(2)) this.parkCarAt(k);

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
        const ry = this.rng.chance(0.5) ? this.rng.int(12, 44) : this.rng.int(GRID - 44, GRID - 12);
        const sx = this.rng.chance(0.5) ? rx - 1 : rx + 2;
        if (isWalkable(c, sx, ry)) return { x: sx + 0.5, y: ry + 0.5 };
      } else if (c.hRoads.length > 0) {
        const ry = this.rng.pick(c.hRoads);
        const rx = this.rng.chance(0.5) ? this.rng.int(12, 44) : this.rng.int(GRID - 44, GRID - 12);
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
        const p = this.farPoint(start, GRID * 0.62);
        const vip = this.spawnCiv(p.x, p.y, true);
        vip.vip = true; vip.maxHp = vip.hp = 70;
        m.targetId = vip.id;
        m.text = "ASSASSINATE the marked individual. Local police are on syndicate payroll: they WILL shoot on sight.";
        this.heat = 10; // cops hostile from the start
        break;
      }
      case "persuade": {
        const p = this.farPoint(start, GRID * 0.62);
        const vip = this.spawnCiv(p.x, p.y, true);
        vip.vip = true; vip.maxHp = vip.hp = 60;
        m.targetId = vip.id;
        m.zone = { x: start.x, y: start.y, r: 5 };
        m.text = "PERSUADE the target with the Persuadertron, then escort them to the extraction zone. Rival agents will intervene.";
        break;
      }
      case "escort": {
        const p = this.farPoint(start, GRID * 0.62);
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
        // Rivals work in fire teams, not as thirty lone gunmen. Break the
        // roster into threes and fours - the sizes are chosen so the last
        // team is never left short - and set each team down together on its
        // own corner of the sector.
        const sizes: number[] = [];
        for (let left = count; left > 0;) {
          const opts = [SQUAD_MIN, SQUAD_MAX].filter((n) => n <= left && (left - n === 0 || left - n >= SQUAD_MIN));
          const n = opts.length > 0 ? this.rng.pick(opts) : left;
          sizes.push(n); left -= n;
        }
        for (const n of sizes) {
          const c = this.farPoint(start, 40 + this.rng.int(0, 110));
          for (let k = 0; k < n; k++) {
            const nw = this.pf.nearestWalkable(
              (c.x + this.rng.float(-SQUAD_SPREAD, SQUAD_SPREAD)) | 0,
              (c.y + this.rng.float(-SQUAD_SPREAD, SQUAD_SPREAD)) | 0, 5);
            const e = this.spawnEnemy(nw ? nw.x + 0.5 : c.x, nw ? nw.y + 0.5 : c.y);
            // they wander about the team's patch, not about wherever the last
            // wander left them: thirty random walks pull the teams apart
            e.homeX = c.x; e.homeY = c.y;
          }
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
      id: nextId++, team, model: 0, x, y, z: 0, dir: 0,
      hp: 30, maxHp: 30, state: "idle", path: null, pathIdx: 0,
      speed: 2.2, animT: 0, deadT: 0, thinkT: this.rng.float(0, 2),
      fleeFrom: null, dodgeT: 0, dodgeSpeed: 0, homeX: -1, homeY: -1, fireCd: 0, aimT: 0, aimTargetId: null, weapon: null,
      agentIdx: -1, inv: [], sel: -1, shieldOn: false, shield: 0,
      fireAt: null, dropOrder: null, pickOrder: null, giveOrder: null, carId: null, boardOrder: null,
      trainId: null, vip: false, persuaded: false, followId: null, hostileCop: false,
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
      id: nextId++, x, y, z: 0, angle: Math.atan2(DY[dir], DX[dir]), dir, speed: 0,
      model: this.rng.int(0, 23), glide: null,
      hp: CAR_HP, state: "drive", path: null, pathIdx: 0, pilotOut: false, occupants: [], waitT: 0,
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
    // never field more officers than the roster still holds
    const forceLeft = Math.max(0, this.policeTotal - this.policeLost);
    const copTarget = Math.min(COP_LIMIT, 2 + Math.floor(this.heat / 4), forceLeft);
    for (let i = nCop; i < copTarget; i++) {
      const s = this.ringSpawn(cx, cy, 16, 38);
      if (s) this.spawnCop(s.x, s.y);
    }
    // cars on roads
    const activeCars = this.cars.filter((c) => c.state === "drive").length;
    for (let i = activeCars; i < CAR_LIMIT; i++) {
      const s = this.ringSpawnRoad(cx, cy, 18, 45);
      if (s) {
        let clear = true;
        // kerbside cars sit off the carriageway, so they never veto a spawn
        for (const o of this.cars) {
          if (o.state === "parked" && !isRoad(this.city, o.x | 0, o.y | 0)) continue;
          if (dist2(o.x, o.y, s.x, s.y) < 7 * 7) { clear = false; break; }
        }
        if (!clear) continue;
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

  // which standing surface is this ped on right now?
  surfaceOf(p: Ped): number { return surfaceNear(this.city, p.x | 0, p.y | 0, p.z); }

  // the same height as the ordered surface, one tile over, so a squad spreads
  // out on arrival instead of stacking on one spot
  private spreadSurface(tSurf: number, x: number, y: number): number {
    if (tSurf < 0) return -1;
    const near = surfaceNear(this.city, x | 0, y | 0, this.city.levels.z[tSurf], 0.01);
    return near >= 0 ? near : tSurf;
  }

  cmdMove(sel: boolean[], tx: number, ty: number, tSurf = -1): void {
    const group = this.selectedAgents(sel);
    let n = 0;
    let anyMoved = false;
    // a fresh order supersedes the last one: the old marker is no longer
    // waiting on anybody, so it goes rather than sitting on a dead destination
    const ids = new Set(group.map((a) => a.id));
    this.pings = this.pings.filter((pg) => !pg.movers.some((m) => ids.has(m)));
    const riding: number[] = [];
    for (const a of group) {
      a.fireAt = null; a.dropOrder = null; a.pickOrder = null; a.giveOrder = null; a.boardOrder = null;
      if (a.carId !== null) {
        const car = this.cars.find((c) => c.id === a.carId);
        if (car && car.state === "player" && car.occupants[0] === a.id) {
          // A tap on a garage floor, or a car already down one, needs the route
          // that knows about ramps; on the street the flat road search is both
          // cheaper and better at holding the lane.
          const here = surfaceNear(this.city, car.x | 0, car.y | 0, car.z, 0.01);
          const wantsLevels = car.z < -0.01 || (tSurf >= 0 && this.city.levels.z[tSurf] < -0.01);
          const p = wantsLevels && here >= 0 && tSurf >= 0
            ? this.pf.carPath(car.x, car.y, here, tx, ty, tSurf)
            : this.pf.drivePath(car.x, car.y, tx, ty);
          if (p) { car.path = p; car.pathIdx = 0; anyMoved = true; riding.push(car.id); }
        }
        continue;
      }
      const ox = (n % 2) * 1.4 - 0.7, oy = Math.floor(n / 2) * 1.4 - 0.7;
      const here = this.surfaceOf(a);
      // Anything off the street - starting on one, or heading for one - goes
      // through the level search; a walk along the pavement keeps the cheaper
      // two-dimensional one.
      const offStreet = (tSurf >= 0 && this.city.levels.z[tSurf] !== 0) || (here >= 0 && a.z !== 0);
      const p = offStreet
        ? (this.pf.climbPath(a.x, a.y, here, tx + ox, ty + oy, this.spreadSurface(tSurf, tx + ox, ty + oy))
           ?? this.pf.climbPath(a.x, a.y, here, tx, ty, tSurf))
        : (this.pf.walkPath(a.x, a.y, tx + ox, ty + oy) ?? this.pf.walkPath(a.x, a.y, tx, ty));
      if (p) { a.path = p; a.pathIdx = 0; a.state = "walk"; anyMoved = true; }
      n++;
    }
    // the marker belongs at the height that was tapped, not on the street
    this.addPing(tx, ty, anyMoved, tSurf >= 0 ? this.city.levels.z[tSurf] : 0,
                 group.filter((a) => a.carId === null).map((a) => a.id), riding[0] ?? null);
  }

  // a marker at a tapped destination: green when someone is on their way,
  // red when nothing could path there. It holds until they get there.
  addPing(x: number, y: number, ok: boolean, z = 0, movers: number[] = [], carId: number | null = null): void {
    this.pings.push({ x, y, z, age: 0, fade: 1, ok, movers, carId });
  }

  cmdShoot(sel: boolean[], tx: number, ty: number, tz = 0): void {
    for (const a of this.selectedAgents(sel)) {
      if (a.carId !== null) continue;
      a.fireAt = { x: tx, y: ty, z: tz, until: this.time + 0.6 };
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
    const d = this.drops.find((dd) => dd.id === dropId);
    if (!d) return;
    // the nearest selected agent with somewhere to put it goes to fetch it
    const group = this.selectedAgents(sel).filter((g) => g.carId === null);
    let a: Ped | undefined;
    let best = Infinity;
    for (const g of group) {
      if (g.inv.length >= 8) continue;
      const d2 = dist2(g.x, g.y, d.x, d.y) + Math.abs(g.z) * 40;   // a storey is a long way
      if (d2 < best) { best = d2; a = g; }
    }
    if (!a) {
      if (group.length > 0) this.notify("NO FREE INVENTORY SLOTS");
      return;
    }
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
    if (!car) return;
    if (car.state === "wreck" || car.state === "drive" || car.state === "stopping") {
      this.flashVehicle(car, false);
      return;
    }
    let ordered = false;
    for (const a of this.selectedAgents(sel)) {
      if (a.carId !== null) continue;
      a.boardOrder = carId; a.dropOrder = null; a.pickOrder = null; a.giveOrder = null;
      const p = this.pf.walkPath(a.x, a.y, car.x, car.y);
      if (p) { a.path = p; a.pathIdx = 0; a.state = "walk"; ordered = true; }
    }
    this.flashVehicle(car, ordered);
  }

  // Acknowledge a tap on a vehicle by lighting it up: green when the order
  // took, red when nothing could act on it. Without this a tap that fails --
  // the wrong side of the platform, no way through to the car -- looks
  // identical to a tap that missed the vehicle altogether.
  private flashVehicle(v: { flash?: number; flashOk?: boolean }, ok: boolean): void {
    v.flash = BOARD_FLASH;
    v.flashOk = ok;
  }

  // Is this stretch of kerb spoken for? Only cars at the kerb count - traffic
  // passing on the carriageway does not - and a car already gliding toward a
  // berth has claimed it, so several dismounting at once do not pile up.
  private kerbTaken(k: Kerb, selfId: number): boolean {
    const R2 = KERB_GAP * KERB_GAP;
    for (const o of this.cars) {
      if (o.id === selfId || o.state === "wreck" || o.z !== 0) continue;
      if ((o.state === "parked" || o.state === "docking")
          && dist2(o.x, o.y, k.px, k.py) < R2) return true;
      if (o.glide && dist2(o.glide.x, o.glide.y, k.px, k.py) < R2) return true;
    }
    return false;
  }

  // The nearest free kerb, searched outward a ring at a time so the first one
  // found is the closest. Any pavement fronting a road will do.
  private freeParkingNear(x: number, y: number, selfId: number): Kerb | null {
    const cx = x | 0, cy = y | 0;
    for (let r = 0; r <= 14; r++) {
      let best: Kerb | null = null, bd = 1e9;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;  // this ring only
          const k = kerbAt(this.city, cx + dx, cy + dy);
          if (!k || this.kerbTaken(k, selfId)) continue;
          const d = dist2(k.px, k.py, x, y);
          if (d < bd) { bd = d; best = k; }
        }
      }
      if (best) return best;
    }
    return null;
  }

  // A scatter of kerbs, up to `perBlock` in each block the avenues carve out,
  // never two close enough to crowd one another.
  private pickKerbs(perBlock: number): Kerb[] {
    const c = this.city;
    const vEdges = [0, ...c.vRoads, GRID];
    const hEdges = [0, ...c.hRoads, GRID];
    const out: Kerb[] = [];
    const taken = new Set<number>();
    for (let bi = 0; bi < vEdges.length - 1; bi++) {
      for (let bj = 0; bj < hEdges.length - 1; bj++) {
        const kerbs: Kerb[] = [];
        for (let y = hEdges[bj]; y <= hEdges[bj + 1] && y < GRID; y++) {
          for (let x = vEdges[bi]; x <= vEdges[bi + 1] && x < GRID; x++) {
            const k = kerbAt(c, x, y);
            if (k) kerbs.push(k);
          }
        }
        if (kerbs.length === 0) continue;
        this.rng.shuffle(kerbs);
        let placed = 0;
        for (const k of kerbs) {
          if (placed >= this.rng.int(1, perBlock)) break;
          let clash = false;
          const g = KERB_GAP - 1;
          for (let dy = -g; dy <= g && !clash; dy++) {
            for (let dx = -g; dx <= g; dx++) if (taken.has(idx(k.x + dx, k.y + dy))) { clash = true; break; }
          }
          if (clash) continue;
          taken.add(idx(k.x, k.y));
          out.push(k);
          placed++;
        }
      }
    }
    return out;
  }

  // stand a car at the kerb, facing either way along the street
  private parkCarAt(k: Kerb): Car {
    const car = this.spawnCar(k.px, k.py, k.axis === 1 ? 2 : 1);
    car.state = "parked";
    car.pilotOut = true;
    car.angle = k.axis === 1 ? Math.PI / 2 : 0;
    if (this.rng.chance(0.5)) car.angle += Math.PI;
    return car;
  }

  // Step aboard a train standing at a platform. There is no driving it: it
  // keeps its own timetable, and the only choice is where to get off.
  cmdBoardTrain(sel: boolean[], trainId: number): void {
    const t = this.trains.find((q) => q.id === trainId);
    if (!t) return;
    if (t.state !== "dwell") { this.notify("TRAIN IN MOTION"); this.flashVehicle(t, false); return; }
    let ordered = false;
    for (const a of this.selectedAgents(sel)) {
      if (a.carId !== null || a.trainId !== null) continue;
      const lvl = this.city.skytrains[t.line].level;
      if (Math.abs(a.z - lvl) > 0.2) { this.notify("REACH THE PLATFORM FIRST"); continue; }
      if (!this.besideTrain(t, a.x, a.y)) { this.notify("STAND BESIDE THE TRAIN"); continue; }
      t.occupants.push(a.id);
      a.trainId = t.id;
      a.path = null;
      ordered = true;
      this.audio.carStart();
    }
    this.flashVehicle(t, ordered);
  }

  cmdExitTrain(sel: boolean[]): void {
    for (const a of this.selectedAgents(sel)) {
      if (a.trainId === null) continue;
      const t = this.trains.find((q) => q.id === a.trainId);
      if (!t) { a.trainId = null; continue; }
      if (t.state !== "dwell") { this.notify("WAIT FOR THE NEXT STOP"); continue; }
      t.occupants = t.occupants.filter((o) => o !== a.id);
      a.trainId = null;
      // step out onto the platform beside the train
      const line = this.city.skytrains[t.line];
      // step out sideways onto the platform, taking the nearest bit of deck
      const at = this.trainPos(t);
      for (const [across, along] of this.stepOffOrder()) {
        const px = (line.axis === "v" ? at.x + across : at.x + along) | 0;
        const py = (line.axis === "v" ? at.y + along : at.y + across) | 0;
        if (px < 0 || py < 0 || px >= GRID || py >= GRID) continue;
        if (surfaceNear(this.city, px, py, line.level, 0.01) < 0) continue;
        a.x = px + 0.5; a.y = py + 0.5; a.z = line.level;
        break;
      }
    }
  }

  // is this point alongside any car of the train, close enough to step across?
  private besideTrain(t: Train, x: number, y: number): boolean {
    const line = this.city.skytrains[t.line];
    const across = Math.abs((line.axis === "v" ? x : y) - trackCentre(line));
    if (across > 3.2) return false;
    const along = (line.axis === "v" ? y : x) - 0.5;
    return Math.abs(along - t.u) < TRAIN_NOSE + 1.6;
  }

  // tiles to try when stepping off a train, nearest first: sideways onto the
  // platform before anywhere else
  private stepOffOrder(): [number, number][] {
    const out: [number, number][] = [];
    for (let across = 1; across <= 3; across++) {
      for (let along = -3; along <= 3; along++) {
        for (const sgn of [1, -1]) out.push([sgn * across, along]);
      }
    }
    out.sort((p, q) => (p[0] * p[0] + p[1] * p[1]) - (q[0] * q[0] + q[1] * q[1]));
    return out;
  }

  cmdExitCar(sel: boolean[]): void {
    for (const a of this.selectedAgents(sel)) {
      if (a.carId === null) continue;
      const car = this.cars.find((c) => c.id === a.carId);
      if (!car) { a.carId = null; continue; }
      car.occupants = car.occupants.filter((o) => o !== a.id);
      if (car.occupants.length === 0) {
        car.path = null; car.speed = 0;
        const bay = this.freeParkingNear(car.x, car.y, car.id);
        if (bay) {
          // park facing whichever way along the street needs the smaller turn
          const along = bay.axis === 1 ? Math.PI / 2 : 0;
          let da = along - car.angle;
          while (da > Math.PI) da -= Math.PI * 2;
          while (da < -Math.PI) da += Math.PI * 2;
          car.glide = { x: bay.px, y: bay.py, a: Math.abs(da) > Math.PI / 2 ? along + Math.PI : along };
          car.state = "docking";
        } else {
          car.state = "parked";
        }
      }
      a.carId = null;
      const n = this.pf.nearestWalkable((car.x | 0) - 1, (car.y | 0) - 1, 4);
      if (n) { a.x = n.x + 0.5; a.y = n.y + 0.5; } else { a.x = car.x; a.y = car.y; }
    }
  }

  // index of the highest-DPS weapon that still has charge, or -1
  private bestWeaponIdx(p: Ped): number {
    let best = -1, bestScore = -1;
    for (let i = 0; i < p.inv.length; i++) {
      const it = p.inv[i];
      if (!ITEMS[it.type].weapon || it.charge <= 0) continue;
      const s = weaponDps(it.type);
      if (s > bestScore) { bestScore = s; best = i; }
    }
    return best;
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

  private fireWeapon(
    shooter: Ped, item: ItemStack | null, wType: ItemType, tx: number, ty: number,
    spreadMult = 1, rangeMult = 1, tz = 0
  ): void {
    const def = ITEMS[wType];
    if (item && item.charge <= 0) return;
    if (item) item.charge--;
    shooter.fireCd = def.cooldown;
    const dx = tx - shooter.x, dy = ty - shooter.y, dz = tz - shooter.z;
    const flat = Math.max(0.001, Math.sqrt(dx * dx + dy * dy));
    const len = Math.max(0.001, Math.sqrt(dx * dx + dy * dy + dz * dz));
    const baseA = Math.atan2(dy, dx);
    const pitch = dz / len;                    // storeys gained per tile of travel
    this.audio.shoot(wType);
    this.flashes.push({ x: shooter.x, y: shooter.y, life: 0.06, maxLife: 0.06, r: 10, ring: false });
    this.alertArea(shooter.x, shooter.y, 14, shooter);
    if (wType === "laser") {
      // hitscan beam, pierces peds, stops at walls
      const maxR = def.range * rangeMult;
      let ex = shooter.x + (dx / len) * maxR, ey = shooter.y + (dy / len) * maxR;
      let ez = shooter.z + pitch * maxR;
      const steps = Math.ceil(maxR * 3);
      for (let i = 1; i <= steps; i++) {
        const f = maxR * i / steps;
        const px = shooter.x + (dx / len) * f;
        const py = shooter.y + (dy / len) * f;
        const pz = shooter.z + pitch * f;
        if (!this.pf.losShot3(shooter.x, shooter.y, shooter.z, px, py, pz)) { ex = px; ey = py; ez = pz; break; }
      }
      this.beams.push({ x0: shooter.x, y0: shooter.y, z0: shooter.z, x1: ex, y1: ey, z1: ez,
                        life: 0.12, maxLife: 0.12, color: def.color, w: 2 });
      for (const p of this.peds) {
        if (p === shooter || p.state === "dead" || p.carId !== null) continue;
        // The beam passes through its own side. Every other weapon fires a
        // projectile, and those have always skipped the shooter's team; the
        // laser was checking only the shooter himself, so a squad standing in
        // a line had one agent cutting down the other three.
        if (p.team === shooter.team) continue;
        if (shooter.team === "cop" && p.team === "civ") continue;
        if (shooter.team === "enemy" && p.team === "cop") continue;
        if (this.pointSegDist(p.x, p.y, shooter.x, shooter.y, ex, ey) < 0.5
            && Math.abs(p.z - this.zAlong(shooter, p.x, p.y, ex, ey, ez)) < 0.8) {
          this.damagePed(p, def.damage, shooter);
        }
      }
      for (const c of this.cars) {
        if (this.ownSideAboard(c, shooter.team)) continue;
        if (this.pointSegDist(c.x, c.y, shooter.x, shooter.y, ex, ey) < 0.9) this.damageCar(c, def.damage, shooter);
      }
      return;
    }
    for (let i = 0; i < def.pellets; i++) {
      const a = baseA + (this.rng.next() - 0.5) * def.spread * spreadMult * 2;
      const flatSpeed = def.speed * (flat / len);
      this.projectiles.push({
        x: shooter.x, y: shooter.y, z: shooter.z,
        vx: Math.cos(a) * flatSpeed, vy: Math.sin(a) * flatSpeed, vz: pitch * def.speed,
        dmg: def.damage, team: shooter.team, life: (def.range * rangeMult) / def.speed, type: wType,
      });
    }
  }

  // the height of a shot where it passes closest to (px,py)
  private zAlong(shooter: Ped, px: number, py: number, ex: number, ey: number, ez: number): number {
    const dx = ex - shooter.x, dy = ey - shooter.y;
    const l2 = dx * dx + dy * dy;
    if (l2 < 1e-6) return shooter.z;
    const t = clamp(((px - shooter.x) * dx + (py - shooter.y) * dy) / l2, 0, 1);
    return shooter.z + (ez - shooter.z) * t;
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
    if (p.team === "cop") {
      this.policeLost++;
      if (this.policeLost >= this.policeTotal) this.notify("SECTOR POLICE ELIMINATED");
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

  // is another car in this car's path? (cars never overlap: they stop and wait)
  private carBlocked(c: Car, range: number): Car | null {
    const fx = Math.cos(c.angle), fy = Math.sin(c.angle);
    let near: Car | null = null;
    for (const o of this.cars) {
      if (o === c || o.state === "wreck" || o.z !== 0) continue;
      // a car sitting on the kerb is scenery, not an obstacle in the lane
      if (!isRoad(this.city, o.x | 0, o.y | 0)) continue;
      const relx = o.x - c.x, rely = o.y - c.y;
      const along = relx * fx + rely * fy;
      const lat = Math.abs(relx * -fy + rely * fx);
      if (along >= 0.2 && along <= range && lat < 0.95) return o;
      // merging traffic: at a junction two cars close on each other from
      // outside the forward cone. Whoever holds the higher id gives way -
      // and everyone gives way to the player - so a pair never deadlocks.
      const d2o = relx * relx + rely * rely;
      if (!near && along > -0.6 && d2o < 1.5 * 1.5 && d2o > 0.9 * 0.9
          && (o.state === "player" || (c.state !== "player" && o.id < c.id))) near = o;
    }
    return near;
  }

  // Range and accuracy are reckoned in three dimensions, a storey of height
  // costing exactly what a tile of ground does.
  private dist3(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // Would this shot go through a car? A car standing between the shooter and
  // the target eats the burst, and a car that brews up takes everyone inside
  // BLAST_R with it - so anything close gets a wider berth than the rest.
  private carInLine(shooter: Ped, tx: number, ty: number): boolean {
    const dx = tx - shooter.x, dy = ty - shooter.y;
    const td = Math.hypot(dx, dy);
    if (td < 0.01) return false;
    for (const c of this.cars) {
      if (c.state === "wreck") continue;
      if (c.occupants.includes(shooter.id)) continue;   // our own ride
      const along = ((c.x - shooter.x) * dx + (c.y - shooter.y) * dy) / td;
      if (along <= 0 || along >= td) continue;          // behind us, or past the target
      const margin = along < BLAST_R + 1 ? 1.8 : 1.1;   // shy of anything near enough to hurt
      if (this.pointSegDist(c.x, c.y, shooter.x, shooter.y, tx, ty) < margin) return true;
    }
    return false;
  }

  // The civilian the squad is escorting. Losing them loses the mission, so
  // for the whole run - before the persuasion, after the pickup - they are
  // nobody's backstop.
  private findWard(): Ped | null {
    const m = this.mission;
    if (m.kind !== "escort" && m.kind !== "persuade") return null;
    const w = this.peds.find((q) => q.id === m.targetId);
    return w && w.state !== "dead" ? w : null;
  }

  // Is the escorted civilian between this shooter and the mark? Only the
  // stretch short of the target counts: someone level with the muzzle, behind
  // it, or standing beside the mark is not being fired through, and treating
  // them as if they were would leave every gun in the sector silent - the
  // escortee spends the mission at an agent's shoulder. This governs only the
  // shots a gun chooses for itself: a stray can still find them, and so can an
  // order from the player.
  private wardInLine(shooter: Ped, tx: number, ty: number): boolean {
    const w = this.wardPed;
    if (!w || w === shooter) return false;
    const dx = tx - shooter.x, dy = ty - shooter.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.01) return false;
    const ux = dx / d, uy = dy / d;
    const along = (w.x - shooter.x) * ux + (w.y - shooter.y) * uy;
    if (along <= 0 || along >= d - WARD_STANDOFF) return false;
    return Math.abs((w.x - shooter.x) * -uy + (w.y - shooter.y) * ux) < WARD_CLEAR;
  }

  // anyone on foot standing in this car's path (NPC traffic yields to them)
  private pedAhead(c: Car, range: number): Ped | null {
    const fx = Math.cos(c.angle), fy = Math.sin(c.angle);
    for (const p of this.peds) {
      if (p.state === "dead" || p.carId !== null) continue;
      const relx = p.x - c.x, rely = p.y - c.y;
      const along = relx * fx + rely * fy;
      if (along < 0.2 || along > range) continue;
      if (Math.abs(relx * -fy + rely * fx) < 0.85) return p;
    }
    return null;
  }

  // Anyone on foot with a car bearing down on them gets out of its way. The
  // ordinary flee runs directly away from what scared it, which for a car in
  // the road means running down the road in front of it - the pedestrian keeps
  // pace with the bumper until it catches them. What saves them is a step to
  // the side, so this picks a target square across the car's line, on whichever
  // side they are already nearer, and sprints for it.
  private dodgeTraffic(dt: number): void {
    for (const p of this.peds) {
      if (p.dodgeT <= 0) continue;
      p.dodgeT -= dt;
      // the sprint is for the step aside, not for good: hand the pace back
      if (p.dodgeT <= 0 && p.dodgeSpeed > 0 && p.state !== "flee") {
        p.speed = p.dodgeSpeed;
        p.dodgeSpeed = 0;
      }
    }
    for (const c of this.cars) {
      // Only the squad's own car. Traffic yields to anyone in front of it, so
      // an NPC car is never actually about to hit anybody - and having the
      // pavement scatter every time a taxi went past was the whole complaint.
      if (c.state !== "player" || c.speed < DODGE_MIN_SPEED) continue;
      const fx = Math.cos(c.angle), fy = Math.sin(c.angle);
      // the faster it comes, the earlier they see it
      const look = Math.min(DODGE_LOOK_MAX, 2 + c.speed * DODGE_LOOK);
      for (const p of this.peds) {
        if (p.state === "dead" || p.carId !== null || p.team === "player") continue;
        if (p.dodgeT > 0 || Math.abs(p.z - c.z) > 0.6) continue;
        // Standing in the road is what makes it their problem. Someone on the
        // pavement is not about to be hit, however close the car passes.
        if (!isRoad(this.city, p.x | 0, p.y | 0)) continue;
        const relx = p.x - c.x, rely = p.y - c.y;
        const along = relx * fx + rely * fy;
        if (along < 0 || along > look) continue;
        // ...and only if the car is coming at them rather than past them: the
        // corridor is barely wider than the one it actually runs people down in
        const side = relx * -fy + rely * fx;
        if (Math.abs(side) > DODGE_WIDE) continue;
        this.dodge(p, c, fx, fy, side);
      }
    }
  }

  private dodge(p: Ped, c: Car, fx: number, fy: number, side: number): void {
    // out the near way first, and the other way if that is a wall
    const first = side >= 0 ? 1 : -1;
    for (const sgn of [first, -first]) {
      const tx = p.x + -fy * sgn * DODGE_CLEAR, ty = p.y + fx * sgn * DODGE_CLEAR;
      const path = this.pf.walkPath(p.x, p.y, tx, ty);
      if (!path) continue;
      p.path = path; p.pathIdx = 0;
      // A civilian who has had to jump for it stays rattled and keeps running.
      // An officer steps aside and gets back to the beat: police do not flee.
      if (p.team === "civ") { p.state = "flee"; p.fleeFrom = { x: c.x, y: c.y }; }
      else p.state = "walk";
      if (p.dodgeSpeed === 0) p.dodgeSpeed = p.speed;
      p.speed = DODGE_SPEED;
      p.thinkT = 1.4;          // long enough to finish the step before rethinking
      p.dodgeT = DODGE_COOLDOWN;
      return;
    }
    // nowhere to go sideways: at least stop walking further into it
    p.dodgeT = DODGE_COOLDOWN;
  }

  // a car driven at speed runs down whoever is under its nose
  private runDownPeds(c: Car): void {
    if (c.speed < 2.5) return;
    const driver = c.occupants.length > 0
      ? this.peds.find((q) => q.id === c.occupants[0]) ?? null
      : null;
    const fx = Math.cos(c.angle), fy = Math.sin(c.angle);
    for (const p of this.peds) {
      if (p.state === "dead" || p.carId !== null) continue;
      if (p.team === "player") continue; // never our own agents
      const relx = p.x - c.x, rely = p.y - c.y;
      const along = relx * fx + rely * fy;
      if (Math.abs(along) > 1.25) continue;
      if (Math.abs(relx * -fy + rely * fx) > 0.6) continue;
      this.audio.hit();
      this.damagePed(p, 500, driver);
      for (let i = 0; i < 6; i++) {
        const a = this.rng.float(0, Math.PI * 2), s = this.rng.float(1, 4);
        this.fx(p.x, p.y, Math.cos(a) * s, Math.sin(a) * s, 0.5, "#a01020", 1, "blood");
      }
    }
  }

  // A shot never damages a car with one of the shooter's own side aboard.
  // Rounds are stopped by the first thing they touch, and the ped loop skips
  // anyone riding, so without this an agent on foot firing at something past
  // the squad car wrecked it and killed everyone in it. An empty car is fair
  // game whoever owns it - blowing one up is half the point of them.
  private ownSideAboard(c: Car, team: Team | null): boolean {
    if (team === null || c.occupants.length === 0) return false;
    for (const oid of c.occupants) {
      const rider = this.peds.find((q) => q.id === oid);
      if (rider && rider.team === team) return true;
    }
    return false;
  }

  damageCar(c: Car, dmg: number, from: Ped | null): void {
    if (c.state === "wreck") return;
    c.hp -= dmg;
    if (c.hp <= 0 || dmg >= 200) {
      this.destroyCar(c, from);
      return;
    }
    if (c.state === "drive") {
      c.state = "stopping";
    }
  }

  // too much damage: the car goes up in a fireball
  private destroyCar(c: Car, from: Ped | null): void {
    c.state = "wreck";
    c.speed = 0;
    c.path = null;
    for (const oid of c.occupants) {
      const rider = this.peds.find((q) => q.id === oid);
      if (rider) {
        rider.carId = null;
        const n = this.pf.nearestWalkable((c.x | 0) + 1, (c.y | 0) + 1, 4);
        rider.x = n ? n.x + 0.5 : c.x + 1;
        rider.y = n ? n.y + 0.5 : c.y;
      }
    }
    c.occupants = [];
    this.explode(c.x, c.y, from);
    // light the fuse on anything standing alongside
    for (const o of this.cars) {
      if (o.id === c.id || o.state === "wreck" || o.z !== c.z) continue;
      if (o.fuse !== undefined && o.fuse > 0) continue;      // already counting down
      if (dist2(o.x, o.y, c.x, c.y) > CHAIN_R * CHAIN_R) continue;
      o.fuse = CHAIN_FUSE;
      o.chainFrom = from;
    }
  }

  private explode(x: number, y: number, from: Ped | null): void {
    this.audio.explosion();
    // white-hot flash and a shockwave ring
    this.flashes.push({ x, y, life: 0.22, maxLife: 0.22, r: 34, ring: false });
    this.flashes.push({ x, y, life: 0.5, maxLife: 0.5, r: 46, ring: true });
    // fireball: fast, short-lived, rising and swelling
    for (let i = 0; i < 26; i++) {
      const a = this.rng.float(0, Math.PI * 2);
      const s = this.rng.float(1.5, 8);
      this.fx(x, y, Math.cos(a) * s, Math.sin(a) * s,
        this.rng.float(0.35, 0.7), "#fff0b0", this.rng.float(2.5, 5), "fire",
        this.rng.float(6, 18), this.rng.float(8, 20), 0.86);
    }
    // smoke: slow, long-lived, climbing and spreading
    for (let i = 0; i < 18; i++) {
      const a = this.rng.float(0, Math.PI * 2);
      const s = this.rng.float(0.3, 2.2);
      this.fx(x, y, Math.cos(a) * s, Math.sin(a) * s,
        this.rng.float(1.1, 2.2), "#4a4a52", this.rng.float(3, 6), "smoke",
        this.rng.float(10, 22), this.rng.float(6, 14), 0.94);
    }
    // sparks and debris thrown clear
    for (let i = 0; i < 16; i++) {
      const a = this.rng.float(0, Math.PI * 2);
      const s = this.rng.float(6, 15);
      this.fx(x, y, Math.cos(a) * s, Math.sin(a) * s, this.rng.float(0.3, 0.8), "#ffd27a", 1.2, "spark", this.rng.float(4, 14), 0, 0.9);
    }
    for (let i = 0; i < 8; i++) {
      const a = this.rng.float(0, Math.PI * 2);
      const s = this.rng.float(2, 7);
      this.fx(x, y, Math.cos(a) * s, Math.sin(a) * s, this.rng.float(0.5, 1.0), "#26262c", 2, "debris", this.rng.float(8, 20), 0, 0.9);
    }
    for (const p of this.peds) {
      if (p.state === "dead") continue;
      const d = dist(p.x, p.y, x, y);
      if (d < BLAST_R) this.damagePed(p, (1 - d / BLAST_R) * 250, from);
    }
    this.alertArea(x, y, 18, from);
  }

  private fx(
    x: number, y: number, vx: number, vy: number, life: number,
    color: string, size: number, kind: FxKind, liftV = 0, grow = 0, drag = 0.92
  ): void {
    this.particles.push({ x, y, vx, vy, life, maxLife: life, color, size, kind, lift: 0, liftV, grow, drag });
  }

  private bloodBurst(x: number, y: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const a = this.rng.float(0, Math.PI * 2);
      const s = this.rng.float(0.4, 2.4);
      this.fx(x, y, Math.cos(a) * s, Math.sin(a) * s, 0.5, "#a01020", 1, "blood");
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
        // unaware policemen stay neutral: they react only with a clear line
        // of sight to the disturbance (the shooter or the victim)
        if (this.pf.losShot(p.x, p.y, x, y)) {
          p.hostileCop = true;
          this.heat = Math.max(this.heat, 4);
        }
      }
    }
  }

  private startFlee(p: Ped, from: { x: number; y: number }): void {
    if (p.team === "cop") return;      // an officer does not run from us
    p.state = "flee";
    p.fleeFrom = { ...from };
    p.thinkT = 0;
    p.speed = 3.6;
  }

  // ---------- per-frame update ----------

  private popTimer = 0;

  update(dt: number, viewRadius: number): void {
    this.time += dt;
    this.wardPed = this.findWard();
    this.heat = Math.max(this.mission.kind === "assassinate" ? 10 : 0, this.heat - dt * 0.12);
    this.popTimer -= dt;
    if (this.popTimer <= 0) { this.popTimer = 1.2; this.populate(); }

    this.updateMission(dt, viewRadius);
    this.dodgeTraffic(dt);
    for (const p of this.peds) this.updatePed(p, dt);
    for (const t of this.trains) this.updateTrain(t, dt);
    for (const c of this.cars) this.updateCar(c, dt);
    this.separateCars(dt);
    this.cars = this.cars.filter((c) => c.waitT < 1e8);
    this.updateProjectiles(dt);

    for (const b of this.beams) b.life -= dt;
    this.beams = this.beams.filter((b) => b.life > 0);
    for (const f of this.flashes) f.life -= dt;
    this.flashes = this.flashes.filter((f) => f.life > 0);
    for (const c of this.cars) if (c.flash) c.flash = Math.max(0, c.flash - dt);
    for (const c of this.cars) {
      if (c.fuse === undefined || c.fuse <= 0 || c.state === "wreck") continue;
      c.fuse -= dt;
      if (c.fuse <= 0) { c.fuse = 0; this.destroyCar(c, c.chainFrom ?? null); }
    }
    for (const t of this.trains) if (t.flash) t.flash = Math.max(0, t.flash - dt);
    for (const pg of this.pings) {
      pg.age += dt;
      // still on the way if anyone ordered there has a path left to walk, or
      // the car they are riding in still has one to drive
      let waiting = false;
      for (const id of pg.movers) {
        const a = this.agents.find((q) => q.id === id);
        if (a && a.hp > 0 && a.path !== null) { waiting = true; break; }
      }
      if (!waiting && pg.carId !== null) {
        const c = this.cars.find((q) => q.id === pg.carId);
        if (c && c.state !== "wreck" && c.path !== null && c.path.length > 0) waiting = true;
      }
      const hold = pg.age < PING_MIN || (waiting && pg.age < PING_MAX);
      pg.fade = hold ? 1 : Math.max(0, pg.fade - dt / PING_FADE);
    }
    this.pings = this.pings.filter((pg) => pg.fade > 0);
    for (const pt of this.particles) {
      pt.x += pt.vx * dt; pt.y += pt.vy * dt;
      pt.vx *= pt.drag; pt.vy *= pt.drag;
      pt.lift += pt.liftV * dt;
      pt.liftV *= 0.96;
      pt.size += pt.grow * dt;
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
    p.aimT = Math.max(0, p.aimT - dt);
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
    const wz = wp.z ?? 0;
    const dz = wz - p.z;
    const d = Math.sqrt(dx * dx + dy * dy);
    // On a staircase the path already traces the flights, so the walk is a
    // walk: just a slower one. Anywhere else a step that also climbs is paced
    // by the climb, which is what keeps a ladder from being taken at a run.
    const pace = wp.stair ? STAIR_PACE : 1 / (1 + Math.abs(dz) * 1.5);
    const step = p.speed * dt * (p.state === "flee" ? 1.15 : 1) * pace;
    // Stair waypoints come every half tile or so, and the ordinary arrival
    // radius would hand back a good fraction of each segment for free, which
    // shows up as a climb noticeably faster than the pace asks for.
    if (d < Math.max(wp.stair ? 0.02 : 0.12, step)) {
      p.x = wp.x; p.y = wp.y; p.z = wz;
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
    if (dz !== 0) p.z += dz * Math.min(1, step / d);   // rise in step with the walk
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
        this.notify(`${this.agentNames[p.agentIdx] ?? "AGENT"}: ${ITEMS[d.item.type].name}`);
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
      if (car && car.state !== "wreck" && car.state !== "drive" && car.state !== "stopping"
          && dist2(car.x, car.y, p.x, p.y) < 2.5 * 2.5 && car.occupants.length < 4) {
        car.occupants.push(p.id);
        p.carId = car.id;
        p.path = null;
        this.audio.carStart();
        if (car.state === "parked" || car.state === "docking") {
          // pull out of the bay and settle into the nearest lane
          const lane = this.pf.nearestRoad(car.x | 0, car.y | 0, 6);
          if (lane) {
            const bits = this.city.laneDir[idx(lane.x, lane.y)];
            let d = car.dir;
            for (let k = 0; k < 4; k++) if (bits & DBIT[k]) { d = k; break; }
            car.dir = d;
            car.glide = { x: lane.x + 0.5, y: lane.y + 0.5, a: Math.atan2(DY[d], DX[d]) };
            car.state = "launching";
          } else {
            car.state = "player";
          }
        }
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
    // a weapon that has run dry is swapped for the next best one in the pack
    if (p.sel >= 0 && p.sel < p.inv.length) {
      const cur = p.inv[p.sel];
      if (ITEMS[cur.type].weapon && cur.charge <= 0) {
        const nxt = this.bestWeaponIdx(p);
        if (nxt >= 0) {
          p.sel = nxt;
          const who = this.agentNames[p.agentIdx] ?? "AGENT";
          this.notify(`${who}: ${ITEMS[cur.type].short} DRY > ${ITEMS[p.inv[nxt].type].short}`);
          this.audio.click();
        }
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

    // Manual fire order. An order is an order: it is carried out wherever it
    // points, the escortee included. The care taken of them governs the shots
    // an agent chooses for itself, not the ones it is given.
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
        const hostile = t.team === "enemy" || (t.team === "cop" && (t.hostileCop || this.mission.kind === "assassinate"));
        if (!hostile) continue;
        // height counts toward the reach exactly as ground distance does
        const d3 = this.dist3(p.x, p.y, p.z, t.x, t.y, t.z);
        const d2 = d3 * d3;
        if (d2 >= bd || !this.pf.losShot3(p.x, p.y, p.z, t.x, t.y, t.z)) continue;
        if (this.carInLine(p, t.x, t.y)) continue;      // not through a car
        if (this.wardInLine(p, t.x, t.y)) continue;  // nor past the escortee
        best = t; bd = d2;
      }
      if (best) {
        this.fireWeapon(p, weapon, weapon.type, best.x + this.rng.float(-0.2, 0.2),
                        best.y + this.rng.float(-0.2, 0.2), 1, 1, best.z);
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
    // An officer we have actually provoked hunts us down. One merely on alert
    // because a hit has been called stays on his beat: he opens fire on what
    // he can see, but never goes looking.
    const provoked = p.hostileCop;
    const hostile = provoked || this.mission.kind === "assassinate";
    if (hostile) {
      let best: Ped | null = null; let bd = 1e9;
      const reach = ITEMS.gun.range * NPC_RANGE_MULT;
      for (const a of this.agents) {
        if (a.hp <= 0 || a.carId !== null) continue;
        const d3 = this.dist3(p.x, p.y, p.z, a.x, a.y, a.z);
        const d2 = d3 * d3;
        if (d2 >= bd) continue;
        if (this.wardInLine(p, a.x, a.y)) continue;  // never down the escortee's line
        best = a; bd = d2;
      }
      if (best) {
        const d = Math.sqrt(bd);
        const canShoot = d < reach && this.pf.losShot3(p.x, p.y, p.z, best.x, best.y, best.z)
          && !this.carInLine(p, best.x, best.y);
        if (!canShoot) p.aimTargetId = null; // breaking the shot forfeits the draw
        // the escortee crossing the line stays the trigger's business: it must
        // not keep resetting the draw, or the shot never comes at all
        const safe = !this.wardInLine(p, best.x, best.y);
        if (canShoot) {
          p.path = null; p.state = "idle";
          p.dir = this.dirOf(best.x - p.x, best.y - p.y);
          // freshly acquired target: take a beat to draw before firing
          if (p.aimTargetId !== best.id) { p.aimTargetId = best.id; p.aimT = this.rng.float(NPC_AIM_MIN, NPC_AIM_MAX); }
          if (p.aimT <= 0 && p.fireCd <= 0 && safe) {
            const j = 0.7 * NPC_SPREAD_MULT;
            this.fireWeapon(p, null, "gun", best.x + this.rng.float(-j, j), best.y + this.rng.float(-j, j),
                            NPC_SPREAD_MULT, NPC_RANGE_MULT, best.z);
            p.fireCd *= NPC_FIRE_MULT;
          }
          return;
        }
        if (provoked && p.thinkT <= 0) {
          p.thinkT = 1.2;
          const path = this.pf.walkPath(p.x, p.y, best.x, best.y);
          if (path) { p.path = path; p.pathIdx = 0; p.state = "walk"; }
          return;
        }
        if (provoked) return; // closing in - hold the current route
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
    // Rivals come for the squad, never for the civilian in its care, and they
    // pick whichever agent they can engage without the escortee downrange.
    let best: Ped | null = null; let bd = 1e9;
    const m = this.mission;
    const wdef = ITEMS[p.weapon ?? "gun"];
    const reach = wdef.range * NPC_RANGE_MULT;
    let blocked: Ped | null = null; let bbd = 1e9;
    for (const a of this.agents) {
      if (a.hp <= 0 || a.carId !== null) continue;
      const d3 = this.dist3(p.x, p.y, p.z, a.x, a.y, a.z);
      const d2 = d3 * d3;
      if (this.wardInLine(p, a.x, a.y)) {
        if (d2 < bbd) { blocked = a; bbd = d2; }   // still worth closing on
        continue;
      }
      if (d2 < bd) { best = a; bd = d2; }
    }
    if (!best && blocked) { best = blocked; bd = bbd; }   // move up, hold fire
    if (!best) return;
    const d = Math.sqrt(bd);
    const hunting = m.kind === "killall" ? d < 55 || this.rng.chance(0.001) : true;
    const canShoot = d < reach && this.pf.losShot3(p.x, p.y, p.z, best.x, best.y, best.z)
      && !this.carInLine(p, best.x, best.y);
    if (!canShoot) p.aimTargetId = null; // breaking the shot forfeits the draw
    // the escortee crossing the line stays the trigger's business: it must not
    // keep resetting the draw, or the shot never comes at all
    const safe = !this.wardInLine(p, best.x, best.y);
    if (canShoot) {
      p.path = null; p.state = "idle";
      p.dir = this.dirOf(best.x - p.x, best.y - p.y);
      // freshly acquired target: take a beat to draw before firing
      if (p.aimTargetId !== best.id) { p.aimTargetId = best.id; p.aimT = this.rng.float(NPC_AIM_MIN, NPC_AIM_MAX); }
      if (p.aimT <= 0 && p.fireCd <= 0 && safe) {
        const j = 0.5 * NPC_SPREAD_MULT;
        this.fireWeapon(p, null, p.weapon ?? "gun", best.x + this.rng.float(-j, j), best.y + this.rng.float(-j, j),
                        NPC_SPREAD_MULT, NPC_RANGE_MULT, best.z);
        p.fireCd *= NPC_FIRE_MULT * 0.75; // rival agents shoot faster than cops
      }
    } else if (hunting && p.thinkT <= 0) {
      p.thinkT = this.rng.float(1.0, 2.0);
      const path = this.pf.walkPath(p.x, p.y, best.x, best.y);
      if (path) { p.path = path; p.pathIdx = 0; p.state = "walk"; }
    } else if (!hunting && p.thinkT <= 0) {
      p.thinkT = this.rng.float(3, 7);
      const ax = p.homeX >= 0 ? p.homeX : p.x, ay = p.homeY >= 0 ? p.homeY : p.y;
      const roam = p.homeX >= 0 ? SQUAD_ROAM : 8;
      const tx = clamp(ax + this.rng.float(-roam, roam), 2, GRID - 3);
      const ty = clamp(ay + this.rng.float(-roam, roam), 2, GRID - 3);
      const path = this.pf.walkPath(p.x, p.y, tx, ty);
      if (path) { p.path = path; p.pathIdx = 0; p.state = "walk"; }
    }
  }

  // Two cars that have already ended up on top of one another - merging at a
  // junction, or shoved by a collision - would sit there forever if both were
  // waiting for the other. Ease them apart instead.
  private separateCars(dt: number): void {
    const live = this.cars.filter((c) => c.state === "drive" || c.state === "player" || c.state === "stopping");
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i], b = live[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d >= 1.05) continue;
        if (d < 1e-3) { dx = 0.01; dy = 0; }
        const push = (1.05 - d) * Math.min(1, dt * 6) * 0.5;
        const ux = dx / (d || 1), uy = dy / (d || 1);
        for (const [car, sgn] of [[a, -1], [b, 1]] as [Car, number][]) {
          const nx = car.x + ux * push * sgn, ny = car.y + uy * push * sgn;
          if (!isRoad(this.city, nx | 0, ny | 0)) continue;
          // never shove a car into oncoming traffic to make room
          const bits = this.city.laneDir[idx(nx | 0, ny | 0)];
          if (bits !== 0 && !(bits & DBIT[car.dir])) continue;
          car.x = nx; car.y = ny;
        }
      }
    }
  }

  // where a train is in the world right now
  // the middle of the train, on the track it runs on - one tile clear of the
  // platform beside it
  trainPos(t: Train): { x: number; y: number } {
    const line = this.city.skytrains[t.line];
    const across = trackCentre(line);
    return line.axis === "v" ? { x: across, y: t.u + 0.5 } : { x: t.u + 0.5, y: across };
  }

  // Which train, if any, stands over this point at this height? Used to turn a
  // tap on a train's body into an order to board it, and a tap anywhere else
  // into an order to get off.
  trainAtPoint(x: number, y: number, z: number): Train | null {
    for (const t of this.trains) {
      const line = this.city.skytrains[t.line];
      if (Math.abs(line.level - z) > 0.3) continue;
      const across = (line.axis === "v" ? x : y) - trackCentre(line);
      if (Math.abs(across) > 0.6) continue;
      const along = (line.axis === "v" ? y : x) - 0.5;
      if (Math.abs(along - t.u) > TRAIN_NOSE) continue;
      return t;
    }
    return null;
  }

  private updateTrain(t: Train, dt: number): void {
    const stops = this.city.skytrains[t.line].stops;
    if (stops.length < 2) return;
    if (t.state === "dwell") {
      t.speed = 0;
      t.dwell -= dt;
      if (t.dwell <= 0) {
        // pull away toward the next platform, turning back at the end of the line
        let next = t.stop;
        if (next < 0 || next >= stops.length) { t.dir = (t.dir === 1 ? -1 : 1) as 1 | -1; next = t.stop + t.dir; }
        if (next < 0 || next >= stops.length) return;
        t.stop = next;
        t.state = "run";
      }
    } else {
      const target = stops[t.stop];
      const left = Math.abs(target - t.u);
      // The fastest it could be going and still come to rest exactly at the
      // platform. Following that curve down brakes it smoothly to a standstill;
      // a fixed floor instead left it crawling the last stretch at a constant
      // speed and then stopping dead.
      const limit = Math.sqrt(2 * TRAIN_ACCEL * Math.max(0, left));
      t.speed = Math.min(TRAIN_CRUISE, limit, t.speed + TRAIN_ACCEL * dt);
      const step = t.speed * dt;
      if (left <= step) {
        t.u = target;
        t.speed = 0;
        t.state = "dwell";
        t.dwell = TRAIN_DWELL;
        const ahead = t.stop + t.dir;
        if (ahead < 0 || ahead >= stops.length) t.dir = (t.dir === 1 ? -1 : 1) as 1 | -1;
        t.stop = Math.max(0, Math.min(stops.length - 1, t.stop + t.dir));
      } else {
        t.u += Math.sign(target - t.u) * step;
      }
    }
    // carry the passengers
    if (t.occupants.length > 0) {
      const at = this.trainPos(t);
      for (const oid of t.occupants) {
        const rider = this.peds.find((q) => q.id === oid);
        if (rider) { rider.x = at.x; rider.y = at.y; rider.z = this.city.skytrains[t.line].level; rider.path = null; }
      }
    }
  }

  private updateCar(c: Car, dt: number): void {
    if (c.state === "wreck" || c.state === "parked") return;
    if (c.state === "launching" || c.state === "docking") {
      const g = c.glide;
      if (!g) { c.state = c.state === "launching" ? "player" : "parked"; return; }
      const dx = g.x - c.x, dy = g.y - c.y;
      const d = Math.hypot(dx, dy);
      const step = 3.2 * dt;
      if (d > 0.04) {
        c.x += (dx / d) * Math.min(step, d);
        c.y += (dy / d) * Math.min(step, d);
      }
      let da = g.a - c.angle;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      c.angle += da * Math.min(1, dt * 5);
      c.speed = Math.min(2, d * 2);
      for (const oid of c.occupants) {
        const rider = this.peds.find((q) => q.id === oid);
        if (rider) { rider.x = c.x; rider.y = c.y; }
      }
      if (d <= 0.04 && Math.abs(da) < 0.08) {
        c.x = g.x; c.y = g.y; c.angle = g.a; c.glide = null; c.speed = 0;
        c.state = c.state === "launching" ? "player" : "parked";
      }
      return;
    }
    if (c.state === "stopping") {
      c.speed = Math.max(0, c.speed - dt * 12);
      if (c.speed <= 0.01 && !c.pilotOut) {
        c.pilotOut = true;
        c.state = "parked";
        // never rest diagonally mid-turn - that reads as a sideways car
        c.angle = Math.round(c.angle / (Math.PI / 2)) * (Math.PI / 2);
        // pilot dismounts and flees
        const n = this.pf.nearestWalkable((c.x | 0) + 1, (c.y | 0) + 1, 4);
        const pilot = this.spawnCiv(n ? n.x + 0.5 : c.x + 1, n ? n.y + 0.5 : c.y);
        this.startFlee(pilot, { x: c.x, y: c.y });
      }
      this.advanceCarAlongDir(c, dt);
      return;
    }
    if (c.state === "player") {
      this.runDownPeds(c); // a coasting car still kills, path or no path
      if (!c.path || c.pathIdx >= c.path.length) { c.speed = Math.max(0, c.speed - dt * 10); return; }
      const blocker = this.carBlocked(c, 2.0 + c.speed * 0.7);
      if (blocker) {
        c.speed = Math.max(0, c.speed - dt * 14);
        if (c.speed <= 0.02) return; // hold position until the road clears
      } else {
        c.speed = Math.min(9, c.speed + dt * 8);
      }
      const wp = c.path[c.pathIdx];
      const dx = wp.x - c.x, dy = wp.y - c.y;
      const wz = wp.z ?? 0;
      const d = Math.sqrt(dx * dx + dy * dy);
      const step = c.speed * dt;
      if (d < Math.max(0.15, step)) {
        c.x = wp.x; c.y = wp.y; c.z = wz; c.pathIdx++;
        if (c.pathIdx >= c.path.length) { c.path = null; c.speed = 0; }
      } else {
        c.x += (dx / d) * step; c.y += (dy / d) * step;
        c.z += (wz - c.z) * Math.min(1, step / d);      // ride the ramp down
        // world-space heading, smoothed so path corners do not snap
        if (d > 0.2) {
          const target = Math.atan2(dy, dx);
          let da = target - c.angle;
          while (da > Math.PI) da -= Math.PI * 2;
          while (da < -Math.PI) da += Math.PI * 2;
          c.angle += da * Math.min(1, dt * 10);
        }
      }
      // keep the riders with the car, height included: without it a squad that
      // drives down a ramp is left standing at street level, and steps out of
      // the car a storey above the floor it parked on
      for (const oid of c.occupants) {
        const p = this.peds.find((q) => q.id === oid);
        if (p) { p.x = c.x; p.y = c.y; p.z = c.z; }
      }
      return;
    }
    // AI traffic: follow lane field tile to tile. Cars never overlap: a
    // blocked car stops dead and waits (for the player too); if it has
    // waited a long time out of sight, it is quietly recycled.
    const blocker = this.carBlocked(c, 2.4 + c.speed * 0.7)
      || this.pedAhead(c, 1.8 + c.speed * 0.55);
    if (blocker) {
      c.speed = Math.max(0, c.speed - dt * 16);
      c.waitT += dt;
      if (c.waitT > 9 && dist2(c.x, c.y, this.camX, this.camY) > 45 * 45) {
        c.waitT = 1e9; // culled after the update loop
        return;
      }
      if (c.speed <= 0.02) return;
    } else {
      c.waitT = 0;
      c.speed = Math.min(6.5, c.speed + dt * 5);
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
        // A ring always offers a way round, so a car that keeps choosing it can
        // circulate for ever - one was measured going round for forty seconds.
        // After half a lap it takes the next exit offered, whatever else is on
        // the table.
        const onRing = this.city.ring[idx(tx, ty)] === 1;
        c.ringT = onRing ? (c.ringT ?? 0) + 1 : 0;
        const leaving = onRing && c.ringT > 6
          ? options.filter((d) => this.city.ring[idx(tx + DX[d], ty + DY[d])] !== 1)
          : [];
        if (leaving.length > 0) c.dir = this.rng.pick(leaving);
        // otherwise prefer going straight
        else c.dir = options.includes(c.dir) && this.rng.chance(0.75) ? c.dir : this.rng.pick(options);
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
      const tx0 = pr.x, ty0 = pr.y, tz0 = pr.z;
      const steps = Math.ceil(Math.max(1, (Math.abs(pr.vx) + Math.abs(pr.vy)) * dt * 2));
      for (let s = 0; s < steps && pr.life > 0; s++) {
        const sdt = dt / steps;
        pr.x += pr.vx * sdt; pr.y += pr.vy * sdt; pr.z += pr.vz * sdt;
        pr.life -= sdt;
        const txi = Math.floor(pr.x), tyi = Math.floor(pr.y);
        if (!inGrid(txi, tyi)) { pr.life = 0; break; }
        if (pr.z < -0.2) { pr.life = 0; break; }        // spent itself in the road
        const t = this.city.tiles[idx(txi, tyi)];
        // a building only stops a round travelling at or below its roofline
        if ((t === 3 || t === 4) && this.city.height[idx(txi, tyi)] > pr.z + 0.1) {
          pr.life = 0;
          this.fx(pr.x, pr.y, 0, 0, 0.15, "#ccc", 1, "spark");
          break;
        }
        // hit peds
        for (const p of this.peds) {
          if (p.state === "dead" || p.team === pr.team || p.carId !== null) continue;
          if (pr.team === "cop" && p.team === "civ") continue;
          if (pr.team === "enemy" && (p.team === "cop")) continue;
          if (dist2(p.x, p.y, pr.x, pr.y) < 0.35 && Math.abs(p.z - pr.z) < 0.8) {
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
          if (this.ownSideAboard(car, pr.team)) continue;
          if (dist2(car.x, car.y, pr.x, pr.y) < 0.8 && Math.abs(pr.z) < 0.8) {
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
      if (pr.type === "gauss" && (pr.x !== tx0 || pr.y !== ty0)) {
        // the slug leaves a bright wake that fades in a fraction of a second
        this.beams.push({ x0: tx0, y0: ty0, z0: tz0, x1: pr.x, y1: pr.y, z1: pr.z,
                          life: 0.28, maxLife: 0.28, color: "#9fe8ff", w: 2.6 });
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
