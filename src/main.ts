// SYND: bootstrap, game state machine, input, camera, and the main loop.

import { City, TRAIN_LEVEL, surfaceNear, T_BUILDING, T_ISLAND, T_PARK, T_PIT, T_ROAD, T_SIDEWALK, T_WALL, generateCity, idx } from "./city/citygen";
import { AudioEngine } from "./engine/audio";
import { GRID, PANEL_FRAC, STORY_H, TILE_H, TILE_W, WEATHERS, Weather, clamp, ctx2d, isRain, isoX, isoY, lerp, makeCanvas } from "./engine/util";
import { ITEMS } from "./game/items";
import { SaveData, clearSave, loadSave, newCampaign, writeSave } from "./game/save";
import { HOLD_NEEDED, HOLD_WINDOW, MissionResult, ObjectiveKind, Ped, Train, World } from "./game/world";
import { Panel } from "./ui/panel";
import { FH, FW } from "./sprites/people";
import { Renderer } from "./ui/render";
import { SectionSlider } from "./ui/slider";
import * as screens from "./ui/screens";
import { PeopleAtlas, buildPeople } from "./sprites/people";
import { TileArt, buildTileArt } from "./sprites/tiles";

type State = "menu" | "briefing" | "armory" | "research" | "implants" | "loading" | "mission" | "paused" | "objectives" | "debrief" | "gameover";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const g = ctx2d(canvas);

let W = 0, H = 0, dpr = 1, panelW = 0;
let state: State = "menu";
let save: SaveData = loadSave() ?? newCampaign();

// pending mission parameters (rolled at briefing time)
let pending: { seed: number; kind: ObjectiveKind; weather: Weather; text: string } | null = null;

// live mission
let city: City | null = null;
let world: World | null = null;
let art: TileArt | null = null;
let people: PeopleAtlas | null = null;
let renderer: Renderer | null = null;
let slider: SectionSlider | null = null;
let sectionLevel = Infinity;   // Infinity = whole city, no cross-section
let levelHeights: number[] = [];   // every distinct standing height, tallest first
let panel: Panel | null = null;
let mapBase: HTMLCanvasElement | null = null;
let endTimer = 0;

const audio = new AudioEngine();
const cam = { x: 256, y: 256, zoom: 2 };
let followCam = true;
let mode: "walk" | "shoot" = "walk";
const PED_HIT_SCALE = 1.2;   // must match the renderer's PED_SCALE
let notices: { text: string; t: number }[] = [];

function resize(): void {
  dpr = Math.min(2.5, window.devicePixelRatio || 1);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  panelW = Math.round(clamp(W * PANEL_FRAC, 110, 300));
  cam.zoom = clamp(H / 300, 1.4, 2.6);
  if (panel) panel.resize(panelW, H);
}
window.addEventListener("resize", resize);
resize();

// ---------- helpers ----------

// Which standing surface does this tap land on? A surface at height h draws
// h*STORY_H higher up the screen, which is the same place the ground tile
// h*STORY_H/TILE_H further from the camera would draw - so walk the sector's
// heights from the top down and take the first that is really there. Nothing
// above the section plane can be picked, which is what lets the slider choose
// the level you are commanding on.
function pickSurface(sx: number, sy: number): { x: number; y: number; surf: number } {
  const g0 = screenToWorld(sx, sy);
  if (city) {
    const L = city.levels;
    for (const h of levelHeights) {
      if (h > sectionLevel + 0.01) continue;
      const k = (h * STORY_H) / TILE_H;
      const rx = Math.floor(g0.x + k), ry = Math.floor(g0.y + k);
      if (rx < 0 || ry < 0 || rx >= GRID || ry >= GRID) continue;
      const s = surfaceNear(city, rx, ry, h, 0.01);
      if (s >= 0 && L.z[s] !== 0) return { x: rx + 0.5, y: ry + 0.5, surf: s };
    }
  }
  const gs = city ? surfaceNear(city, g0.x | 0, g0.y | 0, 0, 0.01) : -1;
  return { x: g0.x, y: g0.y, surf: gs };
}

function screenToWorld(sx: number, sy: number): { x: number; y: number } {
  const vx = panelW, vw = W - panelW;
  const cx = vx + vw / 2, cy = H / 2;
  const px = (sx - cx) / cam.zoom + isoX(cam.x, cam.y);
  const py = (sy - cy) / cam.zoom + isoY(cam.x, cam.y);
  return { x: px / TILE_W + py / TILE_H, y: py / TILE_H - px / TILE_W };
}

// the inverse of screenToWorld, for a point at a given height in storeys
function worldToScreen(x: number, y: number, h = 0): { x: number; y: number } {
  const vx = panelW, vw = W - panelW;
  const cx = vx + vw / 2, cy = H / 2;
  return {
    x: cx + (isoX(x, y) - isoX(cam.x, cam.y)) * cam.zoom,
    y: cy + (isoY(x, y) - isoY(cam.x, cam.y)) * cam.zoom - h * STORY_H * cam.zoom,
  };
}

// Who is under the cursor. A tap on a person is an order to shoot them, so the
// test is against the sprite the player can actually see: its own box, at its
// own level, and only if the section plane is drawing it. Our own squad is not
// a target - tapping an agent is how you walk to where he is standing.
function pedUnder(sx: number, sy: number): Ped | null {
  if (!world) return null;
  const sectioned = renderer ? sectionLevel < renderer.maxStories : false;
  const shown = (ez: number): boolean => ez < -0.01
    ? sectioned && ez <= sectionLevel + 0.01 && sectionLevel < ez + 1
    : !sectioned || ez <= sectionLevel + 0.01;
  const s = PED_HIT_SCALE * cam.zoom;
  let best: Ped | null = null, bestD = Infinity;
  for (const p of world.peds) {
    if (p.state === "dead" || p.carId !== null || p.trainId !== null) continue;
    if (p.team === "player") continue;
    if (!shown(p.z)) continue;
    // The sprite is drawn from (foot - (FH-2)) to (foot + 2), and the figure
    // inside it is a good deal narrower than the frame. The box is that figure
    // with a little room either side, because a finger is not a pixel.
    const q = worldToScreen(p.x, p.y, p.z);
    const cx = q.x, cy = q.y - (FH - 4) * s * 0.5;
    if (Math.abs(sx - cx) > FW * s * 0.34 || Math.abs(sy - cy) > FH * s * 0.52) continue;
    const d = Math.hypot(sx - cx, (sy - cy) * 0.6);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

// Is the selection actually holding something that fires? A squad carrying a
// persuadertron walks up to people rather than shooting them, and a tap on a
// person has to mean what the kit in their hands means.
function selectionArmed(): boolean {
  if (!world) return false;
  for (const a of world.selectedAgents(world.uiSelected)) {
    if (a.carId !== null) continue;
    const it = a.sel >= 0 && a.sel < a.inv.length ? a.inv[a.sel] : null;
    if (it && ITEMS[it.type]?.weapon) return true;
  }
  return false;
}

// Loot under the cursor, with the same generous radius the tap has always
// used - a beacon may stand proud of a building its item is behind.
function dropUnder(sx: number, sy: number): { id: number; x: number; y: number } | null {
  if (!world) return null;
  const t = screenToWorld(sx, sy);
  let best: { id: number; x: number; y: number } | null = null, bd = 1.9 * 1.9;
  for (const d of world.drops) {
    const dd = (d.x - t.x) ** 2 + (d.y - t.y) ** 2;
    if (dd < bd) { bd = dd; best = d; }
  }
  return best;
}

// The world point a screen tap lands on at a given height: a point h storeys
// up draws where the ground h*STORY_H/TILE_H tiles further from the camera
// would, so undo exactly that shift.
function pointAtHeight(sx: number, sy: number, h: number): { x: number; y: number } {
  const g0 = screenToWorld(sx, sy);
  const k = (h * STORY_H) / TILE_H;
  return { x: g0.x + k, y: g0.y + k };
}

// Which train's body is under this tap? Tested at the track's own height and
// again a little above it, so tapping the roof of a car counts as tapping it.
function trainUnder(sx: number, sy: number): Train | null {
  if (!world || !city) return null;
  const levels = new Set(city.skytrains.map((l) => l.level));
  for (const lvl of levels) {
    if (lvl < 0 && lvl < sectionLevel - 0.01) continue;    // only where the section shows it
    for (const rise of [0, 0.45]) {
      const q = pointAtHeight(sx, sy, lvl + rise);
      const tr = world.trainAtPoint(q.x, q.y, lvl);
      if (tr) return tr;
    }
  }
  return null;
}

function rollMission(): void {
  // The harder shapes are held back a few missions: the first jobs a new
  // syndicate takes should be ones a squad with pistols can finish.
  const EARLY: ObjectiveKind[] = ["assassinate", "persuade", "escort", "killall", "steal", "intercept"];
  const LATER: ObjectiveKind[] = ["sabotage", "hold"];
  const kinds: ObjectiveKind[] = save.mission >= 3 ? [...EARLY, ...LATER] : EARLY;
  const q = new URLSearchParams(location.search);
  // an explicit kind in the query string overrides the gate: it is how the
  // tests reach a shape the campaign would not offer yet
  const asked = q.get("kind") as ObjectiveKind | null;
  const kind = (asked && [...EARLY, ...LATER].includes(asked)
    ? asked : kinds[Math.floor(Math.random() * kinds.length)]) as ObjectiveKind;
  const weather = (WEATHERS.includes(q.get("weather") as Weather) ? q.get("weather") : WEATHERS[Math.floor(Math.random() * WEATHERS.length)]) as Weather;
  const seed = q.get("seed") ? Number(q.get("seed")) >>> 0 : (Math.random() * 0x7fffffff) | 0;
  const text = {
    assassinate: "Intel has flagged a target in this sector. Locate and eliminate them. Local police are hostile to our operation.",
    persuade: "A key asset must join the syndicate. Get close with the Persuadertron, then walk them to the extraction zone alive.",
    escort: "A defector is waiting deep in the sector. Reach them and escort them back to the insertion point. Rivals will try to stop you.",
    killall: "A rival syndicate is contesting this sector with 30 field agents. Purge them all.",
    steal: "A courier is walking a data case across this sector under guard. Take it off him and bring it to the extraction zone. He runs the moment he sees you.",
    sabotage: "A rival motor pool is dispersed through this sector. Burn it. The first one you hit warns the rest, and anything on the street will be driven out.",
    hold: "We need an uplink pad held while a transmission runs. Take the pad and keep it. We are paid for the share of the window you hold.",
    intercept: "A defector is crossing this sector on his way out. Reach him before the boundary does. Kill him or turn him - either ends it.",
  }[kind];
  pending = { seed, kind, weather, text };
}

function gotoBriefing(): void {
  if (!pending) rollMission();
  state = "briefing";
  writeSave(save);
  screens.showBriefing(save, pending!.kind, pending!.weather, pending!.text, launchMission, gotoArmory, gotoResearch, gotoImplants);
}

function gotoArmory(): void {
  state = "armory";
  screens.showArmory(save, gotoBriefing);
}

function gotoResearch(): void {
  state = "research";
  screens.showResearch(save, gotoBriefing);
}

function gotoImplants(): void {
  state = "implants";
  screens.showImplants(save, gotoBriefing);
}

function launchMission(): void {
  if (!pending) return;
  if (!save.agents.some((a) => a.alive)) {
    // nobody to deploy — force the armory
    gotoArmory();
    return;
  }
  state = "loading";
  screens.showLoading(`DEPLOYING: ${screens.OBJECTIVE_LABEL[pending.kind]}`);
  setTimeout(buildMission, 60);
}

function buildMission(): void {
  const p = pending!;
  city = generateCity(p.seed);
  art = buildTileArt(p.seed, p.weather);
  people = buildPeople(p.seed);
  world = new World(city, p.weather, save, audio, p.kind, save.mission);
  world.notify = (msg) => notices.push({ text: msg, t: 4 });
  renderer = new Renderer(city);
  slider = new SectionSlider(renderer.maxStories, renderer.minLevel);
  sectionLevel = renderer.maxStories;
  // the heights a tap may land on, gathered once from the level model
  const seen = new Set<number>();
  for (let s2 = 0; s2 < city.levels.count; s2++) seen.add(city.levels.z[s2]);
  levelHeights = [...seen].sort((a, b) => b - a);
  panel = new Panel(panelW, H);
  mapBase = buildMapBase(city);
  cam.x = world.camX; cam.y = world.camY;
  followCam = true;
  mode = "walk";
  notices = [{ text: world.mission.text.split(".")[0].toUpperCase(), t: 5 }];
  endTimer = 0;
  world.uiSelected = [true, true, true, true];
  audio.setTrack(p.seed + save.mission);
  screens.clearScreens();
  audio.rain(isRain(p.weather));
  state = "mission";
}

function buildMapBase(c: City): HTMLCanvasElement {
  const m = makeCanvas(GRID, GRID);
  const mg = ctx2d(m);
  const img = mg.createImageData(GRID, GRID);
  const put = (i: number, r: number, gg: number, b: number) => {
    img.data[i * 4] = r; img.data[i * 4 + 1] = gg; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
  };
  for (let i = 0; i < GRID * GRID; i++) {
    switch (c.tiles[i]) {
      case T_ROAD: put(i, 10, 11, 15); break;
      case T_SIDEWALK: put(i, 52, 54, 64); break;
      case T_WALL: put(i, 70, 74, 88); break;
      case T_BUILDING: put(i, 38, 40, 52); break;
      case T_PARK: put(i, 26, 48, 36); break;
      case T_ISLAND: put(i, 46, 48, 58); break;
      case T_PIT: put(i, 8, 8, 12); break;
      default: put(i, 20, 21, 27);
    }
  }
  mg.putImageData(img, 0, 0);
  // skytrain lines as thin cyan traces
  for (const line of c.skytrains) {
    for (let u = 0; u < GRID; u++) {
      const x = line.axis === "v" ? line.pos + 1 : u;
      const y = line.axis === "v" ? u : line.pos + 1;
      const i = idx(x, y);
      img.data[i * 4] = 40; img.data[i * 4 + 1] = 140; img.data[i * 4 + 2] = 160; img.data[i * 4 + 3] = 255;
    }
  }
  mg.putImageData(img, 0, 0);
  return m;
}

function endMission(result: MissionResult): void {
  audio.rain(false);
  const w = world!;
  // sync roster back into the save
  for (let i = 0; i < 4; i++) {
    const a = w.agents[i];
    const sa = save.agents[i];
    if (!sa) continue;
    if (!sa.alive) continue; // was already dead before the mission
    if (a.hp <= 0) {
      sa.alive = false; sa.hp = 0; sa.inv = [];
    } else {
      sa.hp = 100; // the medbay patches survivors up completely between missions
      sa.inv = a.inv.map((s) => ({ ...s }));
    }
  }
  save.kills += result.kills;
  save.credits += result.creditsEarned;
  if (result.success) save.mission++;
  const wiped = !save.agents.some((a) => a.alive) && save.credits < 1200;
  writeSave(save);
  world = null; city = null; renderer = null; slider = null; mapBase = null;
  if (wiped) {
    state = "gameover";
    screens.showGameOver(save, () => {
      clearSave();
      save = newCampaign();
      writeSave(save);
      rollMission();
      gotoBriefing();
    });
    return;
  }
  state = "debrief";
  screens.showDebrief(save, result, () => {
    rollMission();
    gotoBriefing();
  });
}

// ---------- input ----------

interface PointerInfo {
  id: number;
  x: number; y: number;
  startX: number; startY: number;
  panel: boolean;
  slider: boolean;    // press started on the section slider
  slot: number;       // inventory slot index if the press started there
  moved: boolean;
  camStart: { x: number; y: number };
}
const pointers = new Map<number, PointerInfo>();
let pinchDist = 0, pinchZoom = 1, wasPinch = false;
let dragGhost: { slot: number; x: number; y: number; overDoll: number } | null = null;

canvas.addEventListener("pointerdown", (ev) => {
  audio.unlock();
  if (state !== "mission" || !world || !panel) return;
  canvas.setPointerCapture(ev.pointerId);
  const p: PointerInfo = {
    id: ev.pointerId, x: ev.clientX, y: ev.clientY,
    startX: ev.clientX, startY: ev.clientY,
    panel: ev.clientX < panelW, slot: -1, moved: false, slider: false,
    camStart: { x: cam.x, y: cam.y },
  };
  if (!p.panel && slider) {
    const gm = slider.geom(panelW, 0, canvas.clientWidth - panelW, canvas.clientHeight);
    if (slider.hit(ev.clientX, ev.clientY, gm)) {
      p.slider = true;
      sectionLevel = slider.levelAt(ev.clientY, gm);
      audio.click();
    }
  }
  if (p.panel) {
    const hit = panel.hit(ev.clientX, ev.clientY);
    if (hit.type === "slot") p.slot = hit.i;
  }
  pointers.set(ev.pointerId, p);
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    pinchZoom = cam.zoom;
    wasPinch = true;
  }
});

canvas.addEventListener("pointermove", (ev) => {
  const p = pointers.get(ev.pointerId);
  if (!p || state !== "mission" || !world) return;
  p.x = ev.clientX; p.y = ev.clientY;
  if (Math.hypot(p.x - p.startX, p.y - p.startY) > 12) p.moved = true;

  if (p.slider && slider) {
    sectionLevel = slider.levelAt(p.y, slider.geom(panelW, 0, canvas.clientWidth - panelW, canvas.clientHeight));
    return;
  }

  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist > 0) cam.zoom = clamp(pinchZoom * (d / pinchDist), 1.1, 3.4);
    return;
  }
  if (p.slot >= 0) {
    if (p.moved) {
      let overDoll = -1;
      if (p.x < panelW && panel) {
        const hit = panel.hit(p.x, p.y);
        if (hit.type === "doll") overDoll = hit.i;
      }
      dragGhost = { slot: p.slot, x: p.x, y: p.y, overDoll };
    }
    return;
  }
  if (!p.panel && p.moved) {
    // pan: convert screen delta to world delta (inverse iso, linear)
    followCam = false;
    const dxs = (p.startX - p.x) / cam.zoom, dys = (p.startY - p.y) / cam.zoom;
    cam.x = clamp(p.camStart.x + dxs / TILE_W + dys / TILE_H, 4, GRID - 4);
    cam.y = clamp(p.camStart.y + dys / TILE_H - dxs / TILE_W, 4, GRID - 4);
  }
});

function pointerEnd(ev: PointerEvent): void {
  const p = pointers.get(ev.pointerId);
  pointers.delete(ev.pointerId);
  if (pointers.size === 0 && wasPinch) { wasPinch = false; dragGhost = null; return; }
  if (!p || state !== "mission" || !world || !panel) { dragGhost = null; return; }
  const w = world;

  if (p.slider) { dragGhost = null; return; }

  // finish an inventory drag: out to the world drops it, onto a doll gives it
  if (p.slot >= 0 && p.moved) {
    dragGhost = null;
    if (p.x >= panelW) {
      const t = screenToWorld(p.x, p.y);
      w.cmdDropItem(w.uiSelected, p.slot, t.x, t.y);
      audio.click();
    } else {
      const hit = panel.hit(p.x, p.y);
      if (hit.type === "doll") {
        w.cmdGiveItem(w.uiSelected, p.slot, hit.i);
        audio.click();
      }
    }
    return;
  }
  if (p.moved || pointers.size > 0) return; // pan or pinch, not a tap

  if (p.panel) {
    handlePanelTap(panel.hit(p.x, p.y));
    return;
  }
  // world tap
  const t = screenToWorld(p.x, p.y);
  if (mode === "shoot") {
    const aim = pickSurface(p.x, p.y);
    w.cmdShoot(w.uiSelected, aim.x, aim.y, aim.surf >= 0 && city ? city.levels.z[aim.surf] : 0);
    return;
  }
  // Auto: the thing under the finger says what the order is. A person is a
  // target, loot is a pickup, a car is a ride, and bare ground is a walk - so
  // the common case never needs the mode switched by hand. SHOOT stays as the
  // override, for firing at a spot with nobody standing on it.
  const target = pedUnder(p.x, p.y);
  if (target && selectionArmed()) {
    w.cmdShoot(w.uiSelected, target.x, target.y, target.z);
    return;
  }
  const hitDrop = dropUnder(p.x, p.y);
  if (hitDrop) { w.cmdPickup(w.uiSelected, hitDrop.id); followCam = true; return; }

  const lead = w.selectedAgents(w.uiSelected)[0];
  // A train is a solid thing on the screen, so hit-test it as one: tap its
  // body to board, tap anywhere else to get off.
  const tappedTrain = trainUnder(p.x, p.y);
  if (lead && lead.trainId !== null) {
    if (tappedTrain && tappedTrain.id === lead.trainId) return;   // tapped the train we are on
    w.cmdExitTrain(w.uiSelected);
    followCam = true;
    return;
  }
  if (tappedTrain && lead) {
    w.cmdBoardTrain(w.uiSelected, tappedTrain.id);
    followCam = true;
    return;
  }
  // Hit-test each car at its own height. A car in a garage draws a storey up
  // the screen, so testing the tap against the ground plane (t) lands a couple
  // of tiles off it and the tap never catches - the same z blind spot that
  // stopped shots reaching the garage. Project the tap to each car's level, and
  // only consider a car the section is actually drawing, by the renderer's own
  // visibility rule - so a street car near a building is never mistaken for
  // hidden, and a garage car is tappable only once the slider reveals its floor.
  const sectioned = renderer ? sectionLevel < renderer.maxStories : false;
  const carShown = (ez: number): boolean => ez < -0.01
    ? sectioned && ez <= sectionLevel + 0.01 && sectionLevel < ez + 1
    : !sectioned || ez <= sectionLevel + 0.01;
  for (const c of w.cars) {
    if (!carShown(c.z)) continue;
    const q = pointAtHeight(p.x, p.y, c.z);
    const dd = (c.x - q.x) ** 2 + (c.y - q.y) ** 2;
    if (dd < 1.6 * 1.6 && (c.state === "parked" || (c.state === "player" && lead && lead.carId === null))) {
      w.cmdBoardCar(w.uiSelected, c.id);
      followCam = true;
      return;
    }
  }
  if (lead && lead.carId !== null) {
    // driving: tap road or garage floor to drive there, tap anywhere else to
    // get out
    const surf = pickSurface(p.x, p.y);
    const onFloor = surf.surf >= 0 && city && city.levels.z[surf.surf] < -0.01;
    const tileIsRoad = city && t.x >= 0 && t.y >= 0 && t.x < GRID && t.y < GRID &&
      city.tiles[idx(t.x | 0, t.y | 0)] === T_ROAD;
    if (onFloor) w.cmdMove(w.uiSelected, surf.x, surf.y, surf.surf);
    else if (tileIsRoad) w.cmdMove(w.uiSelected, t.x, t.y);
    else w.cmdExitCar(w.uiSelected);
    followCam = true;
    return;
  }
  // a bare tap goes to whatever surface it landed on - street, or the roof
  // of a building with a fire stair up its flank
  const surf = pickSurface(p.x, p.y);
  w.cmdMove(w.uiSelected, surf.x, surf.y, surf.surf);
  followCam = true;
}
canvas.addEventListener("pointerup", pointerEnd);
canvas.addEventListener("pointercancel", pointerEnd);

// A pickup cursor, drawn rather than shipped: two brackets closing on an arrow
// into a tray, outlined dark so it reads on pavement and on tarmac alike.
let pickCursor = "";
function pickupCursor(): string {
  if (pickCursor) return pickCursor;
  const c = makeCanvas(32, 32);
  const q = ctx2d(c);
  q.imageSmoothingEnabled = true;
  q.lineCap = "round";
  q.lineJoin = "round";
  const stroke = (col: string, w: number): void => {
    q.strokeStyle = col; q.lineWidth = w;
    q.beginPath();                                   // corner brackets
    for (const [ox, oy, dx, dy] of [[6, 10, 1, -1], [26, 10, -1, -1], [6, 24, 1, 1], [26, 24, -1, 1]]) {
      q.moveTo(ox, oy + dy * -5 * dy); q.lineTo(ox, oy); q.lineTo(ox + dx * 5, oy);
    }
    q.stroke();
    q.beginPath();                                   // arrow down into the tray
    q.moveTo(16, 5); q.lineTo(16, 17);
    q.moveTo(11, 12); q.lineTo(16, 17); q.lineTo(21, 12);
    q.stroke();
    q.beginPath();                                   // the tray
    q.moveTo(10, 21); q.lineTo(10, 25); q.lineTo(22, 25); q.lineTo(22, 21);
    q.stroke();
  };
  stroke("rgba(8,10,14,0.9)", 5);
  stroke("#ffffff", 2.2);
  pickCursor = `url(${c.toDataURL("image/png")}) 16 16, pointer`;
  return pickCursor;
}

// Playing with a mouse, the pointer answers "what would a click do here?"
// before the click is spent. Touch has no hover, so it never runs.
let cursorNow = "";
function setCursor(css: string): void {
  if (css === cursorNow) return;
  cursorNow = css;
  canvas.style.cursor = css;
}
canvas.addEventListener("pointermove", (ev) => {
  if (ev.pointerType !== "mouse") return;
  if (pointers.size > 0 || state !== "mission" || !world) { setCursor("default"); return; }
  if (ev.clientX < panelW) { setCursor("default"); return; }
  if (mode === "shoot") { setCursor("crosshair"); return; }
  if (pedUnder(ev.clientX, ev.clientY) && selectionArmed()) { setCursor("crosshair"); return; }
  if (dropUnder(ev.clientX, ev.clientY)) { setCursor(pickupCursor()); return; }
  setCursor("default");
});
canvas.addEventListener("pointerleave", () => setCursor("default"));

// Cut the section to the storey something actually stands on. The plane has
// to be at or above a height to show it, and a level below the street also
// needs the floor over its head taken away, so the storey that shows a height
// is the one it reaches up into - the ceiling of it, not the floor.
function sectionTo(z: number): void {
  const want = Math.ceil(z - 1e-6);
  const lo = slider ? slider.minLevel : 0;
  const hi = renderer ? renderer.maxStories : want;
  sectionLevel = Math.max(lo, Math.min(hi, want));
}

function handlePanelTap(hit: ReturnType<Panel["hit"]>): void {
  const w = world!;
  audio.click();
  switch (hit.type) {
    case "doll": {
      w.uiSelected = [false, false, false, false];
      if (w.agents[hit.i] && w.agents[hit.i].hp > 0) {
        w.uiSelected[hit.i] = true;
        sectionTo(w.agents[hit.i].z);
      }
      followCam = true;
      break;
    }
    case "emblem": {
      for (let i = 0; i < 4; i++) w.uiSelected[i] = w.agents[i] ? w.agents[i].hp > 0 : false;
      const first = w.selectedAgents(w.uiSelected)[0];
      if (first) sectionTo(first.z);
      followCam = true;
      break;
    }
    case "slot": {
      const a = panel!.invAgent(w);
      if (a) w.selectItem(a, hit.i);
      break;
    }
    case "toggle": mode = hit.mode; break;
    case "obj": {
      state = "objectives";
      const m = w.mission;
      let status = "";
      if (m.kind === "killall") status = `${m.enemiesLeft} HOSTILE AGENTS REMAIN`;
      else if (m.kind === "persuade") status = w.peds.find((q) => q.id === m.targetId)?.persuaded ? "TARGET PERSUADED - REACH EXTRACTION" : "TARGET NOT YET PERSUADED";
      else if (m.kind === "escort") status = m.phase === 1 ? "VIP SECURED - RETURN TO INSERTION POINT" : "VIP NOT YET REACHED";
      else if (m.kind === "steal") {
        status = m.phase === 0 ? (m.alerted ? "COURIER RUNNING FOR THE BOUNDARY" : "COURIER HAS NOT SEEN YOU")
          : w.agents.some((a) => a.hp > 0 && a.inv.some((it) => it.type === "case"))
            ? "CASE IN HAND - REACH EXTRACTION" : "CASE ON THE GROUND - PICK IT UP";
      } else if (m.kind === "sabotage") {
        status = `${m.wrecked}/${m.marks.length} DESTROYED` + (m.escaped > 0 ? ` - ${m.escaped} DRIVEN OUT` : "");
      } else if (m.kind === "hold") {
        status = m.phase === 0 ? "REACH THE UPLINK PAD"
          : `UPLINK ${Math.min(100, (m.held / HOLD_NEEDED) * 100) | 0}% - ${Math.max(0, m.window) | 0}s OF WINDOW LEFT`;
      } else if (m.kind === "intercept") {
        status = m.alerted ? "DEFECTOR RUNNING FOR THE BOUNDARY" : "DEFECTOR HAS NOT SEEN YOU";
      }
      else status = "TARGET AT LARGE";
      status += `<br>POLICE IN SECTOR: ${Math.max(0, w.policeTotal - w.policeLost)} / ${w.policeTotal}`;
      screens.showObjectives(save.mission, m.kind, m.text, status, () => {
        screens.clearScreens();
        state = "mission";
      });
      break;
    }
    case "sound": audio.setMuted(!audio.muted); break;
    case "pause": {
      state = "paused";
      screens.showPause(
        () => { screens.clearScreens(); state = "mission"; },
        () => {
          endMission({ success: false, reason: "Mission aborted by command.", kills: world?.kills ?? 0, creditsEarned: 0 });
        }
      );
      break;
    }
    default: break;
  }
}

// ---------- main loop ----------

let last = performance.now();
function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (state === "mission" && world && city && art && people && renderer && panel && mapBase) {
    const vw = W - panelW, vh = H;
    const viewRadius = Math.max(vw / (TILE_W * cam.zoom), vh / (TILE_H * cam.zoom)) * 1.1 + 4;

    world.update(dt, viewRadius);
    audio.ambient(dt);

    // camera follow
    if (followCam) {
      let fx = 0, fy = 0, n = 0;
      const lead = world.selectedAgents(world.uiSelected)[0];
      if (lead && lead.carId !== null) {
        const car = world.cars.find((c) => c.id === lead.carId);
        if (car) { fx = car.x; fy = car.y; n = 1; }
      }
      let fz = 0;
      if (n === 0) {
        for (const a of world.selectedAgents(world.uiSelected)) { fx += a.x; fy += a.y; fz += a.z; n++; }
      }
      // A squad up on a roof draws STORY_H per storey higher up the screen, so
      // the focus point has to come the same distance toward the camera for it
      // to stay centred - and a squad down in a garage or a concourse draws
      // that much lower, so it needs the same correction the other way.
      if (n > 0 && fz !== 0) {
        const lift = (fz / n) * STORY_H / TILE_H;
        fx -= lift * n; fy -= lift * n;
      }
      if (n > 0) {
        cam.x = lerp(cam.x, fx / n, Math.min(1, dt * 4));
        cam.y = lerp(cam.y, fy / n, Math.min(1, dt * 4));
      }
    }
    world.camX = cam.x; world.camY = cam.y;

    renderer.draw(g, world, art, people, cam, panelW, 0, vw, vh, world.time, sectionLevel);
    panel.draw(g, world, people, mapBase, mode, audio.muted, world.time, save.mission, dragGhost ? dragGhost.overDoll : -1);
    if (slider) slider.draw(g, slider.geom(panelW, 0, vw, vh), sectionLevel);

    // The uplink runs on a clock whether anyone is standing on the pad or not,
    // and what is banked is what gets paid. That is worth knowing at a glance
    // rather than through a menu, so it sits at the top of the view for as
    // long as the transmission lasts.
    let ny = 8;
    if (state === "mission" && world && world.mission.kind === "hold" && !world.mission.done) {
      const m = world.mission;
      const bw = Math.min(260, vw - 24), bh = 22;
      const bx = panelW + (vw - bw) / 2, by = ny;
      g.fillStyle = "rgba(10,12,16,0.78)";
      g.fillRect(bx, by, bw, bh);
      if (m.phase === 0) {
        g.strokeStyle = "rgba(255,155,47,0.7)";
        g.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
        g.fillStyle = "#ff9b2f";
        g.font = "bold 11px monospace";
        g.textAlign = "center";
        g.fillText("REACH THE UPLINK PAD", bx + bw / 2, by + 15);
      } else {
        const frac = Math.max(0, Math.min(1, m.held / HOLD_NEEDED));
        const left = Math.max(0, m.window);
        // what is still winnable: the rest of the window, if all of it is held
        const cap = Math.min(1, frac + left / HOLD_NEEDED);
        g.fillStyle = "rgba(120,255,190,0.14)";
        g.fillRect(bx + 2, by + 2, (bw - 4) * cap, bh - 4);
        g.fillStyle = frac >= 1 ? "#4fdc6a" : "#7affc8";
        g.fillRect(bx + 2, by + 2, (bw - 4) * frac, bh - 4);
        g.strokeStyle = "rgba(122,255,200,0.65)";
        g.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
        g.font = "bold 11px monospace";
        g.textAlign = "center";
        g.fillStyle = "#04120c";
        const label = `UPLINK ${(frac * 100) | 0}%   ${left | 0}s LEFT`;
        g.fillText(label, bx + bw / 2, by + 15);
        // legible where the bar has not reached yet
        g.save();
        g.beginPath();
        g.rect(bx + 2 + (bw - 4) * frac, by, bw, bh);
        g.clip();
        g.fillStyle = "#cfeee0";
        g.fillText(label, bx + bw / 2, by + 15);
        g.restore();
      }
      ny += bh + 6;
    }

    // notices
    g.textAlign = "center";
    for (const nn of notices) {
      nn.t -= dt;
      g.globalAlpha = clamp(nn.t, 0, 1);
      g.font = "bold 13px monospace";
      g.fillStyle = "#ffe32f";
      g.fillText(nn.text, panelW + vw / 2, ny + 12);
      ny += 18;
      g.globalAlpha = 1;
    }
    g.textAlign = "left";
    notices = notices.filter((x) => x.t > 0);

    // drag ghost
    if (dragGhost) {
      const a = panel.invAgent(world);
      const item = a && dragGhost.slot < a.inv.length ? a.inv[dragGhost.slot] : null;
      if (item) {
        g.fillStyle = ITEMS[item.type].color;
        g.globalAlpha = 0.85;
        g.fillRect(dragGhost.x - 12, dragGhost.y - 8, 24, 16);
        g.globalAlpha = 1;
        g.fillStyle = "#000";
        g.font = "bold 8px monospace";
        g.textAlign = "center";
        g.fillText(ITEMS[item.type].short, dragGhost.x, dragGhost.y + 2);
        g.textAlign = "left";
      }
    }

    // mission end (small delay so deaths/pings resolve visually)
    if (world.result) {
      endTimer += dt;
      g.textAlign = "center";
      g.font = "bold 26px monospace";
      g.fillStyle = world.result.success ? "#4fdc6a" : "#e04040";
      g.fillText(world.result.success ? "MISSION ACCOMPLISHED" : "MISSION FAILED", panelW + vw / 2, vh / 2);
      g.textAlign = "left";
      if (endTimer > 2.2) endMission(world.result);
    }
  } else if (state === "paused" || state === "objectives") {
    // keep last frame beneath the overlay
  }
}
requestAnimationFrame(frame);

// debug/testing handle
(window as unknown as Record<string, unknown>).SYND = {
  cam,
  get world() { return world; },
  get city() { return city; },
  get panel() { return panel; },
  get renderer() { return renderer; },
  setFollow(v: boolean) { followCam = v; },
  screenToWorld,
  worldToScreen,
  get section() { return sectionLevel; },
  get sliderMin() { return slider ? slider.minLevel : 0; },
  setSection(v: number) { sectionLevel = v; },
  audio,
};

// ---------- boot ----------

screens.showMenu(loadSave() !== null, (cont) => {
  if (!cont) { clearSave(); save = newCampaign(); writeSave(save); }
  rollMission();
  gotoBriefing();
});
