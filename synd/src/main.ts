// SYND: bootstrap, game state machine, input, camera, and the main loop.

import { City, T_BUILDING, T_ISLAND, T_PARK, T_PIT, T_ROAD, T_SIDEWALK, T_WALL, generateCity, idx } from "./city/citygen";
import { AudioEngine } from "./engine/audio";
import { GRID, PANEL_FRAC, TILE_H, TILE_W, WEATHERS, Weather, clamp, ctx2d, isRain, isoX, isoY, lerp, makeCanvas } from "./engine/util";
import { ITEMS } from "./game/items";
import { SaveData, clearSave, loadSave, newCampaign, writeSave } from "./game/save";
import { MissionResult, ObjectiveKind, World } from "./game/world";
import { Panel } from "./ui/panel";
import { Renderer } from "./ui/render";
import * as screens from "./ui/screens";
import { PeopleAtlas, buildPeople } from "./sprites/people";
import { TileArt, buildTileArt } from "./sprites/tiles";

type State = "menu" | "briefing" | "armory" | "loading" | "mission" | "paused" | "objectives" | "debrief" | "gameover";

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
let panel: Panel | null = null;
let mapBase: HTMLCanvasElement | null = null;
let endTimer = 0;

const audio = new AudioEngine();
const cam = { x: 256, y: 256, zoom: 2 };
let followCam = true;
let mode: "walk" | "shoot" = "walk";
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

function screenToWorld(sx: number, sy: number): { x: number; y: number } {
  const vx = panelW, vw = W - panelW;
  const cx = vx + vw / 2, cy = H / 2;
  const px = (sx - cx) / cam.zoom + isoX(cam.x, cam.y);
  const py = (sy - cy) / cam.zoom + isoY(cam.x, cam.y);
  return { x: px / TILE_W + py / TILE_H, y: py / TILE_H - px / TILE_W };
}

function rollMission(): void {
  const kinds: ObjectiveKind[] = ["assassinate", "persuade", "escort", "killall"];
  const q = new URLSearchParams(location.search);
  const kind = (kinds.includes(q.get("kind") as ObjectiveKind) ? q.get("kind") : kinds[Math.floor(Math.random() * kinds.length)]) as ObjectiveKind;
  const weather = (WEATHERS.includes(q.get("weather") as Weather) ? q.get("weather") : WEATHERS[Math.floor(Math.random() * WEATHERS.length)]) as Weather;
  const seed = q.get("seed") ? Number(q.get("seed")) >>> 0 : (Math.random() * 0x7fffffff) | 0;
  const text = {
    assassinate: "Intel has flagged a target in this sector. Locate and eliminate them. Local police are hostile to our operation.",
    persuade: "A key asset must join the syndicate. Get close with the Persuadertron, then walk them to the extraction zone alive.",
    escort: "A defector is waiting deep in the sector. Reach them and escort them back to the insertion point. Rivals will try to stop you.",
    killall: "A rival syndicate is contesting this sector with 30 field agents. Purge them all.",
  }[kind];
  pending = { seed, kind, weather, text };
}

function gotoBriefing(): void {
  if (!pending) rollMission();
  state = "briefing";
  writeSave(save);
  screens.showBriefing(save, pending!.kind, pending!.weather, pending!.text, launchMission, gotoArmory);
}

function gotoArmory(): void {
  state = "armory";
  screens.showArmory(save, gotoBriefing);
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
  panel = new Panel(panelW, H);
  mapBase = buildMapBase(city);
  cam.x = world.camX; cam.y = world.camY;
  followCam = true;
  mode = "walk";
  notices = [{ text: world.mission.text.split(".")[0].toUpperCase(), t: 5 }];
  endTimer = 0;
  world.uiSelected = [true, true, true, true];
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
      sa.hp = Math.min(100, Math.max(40, Math.round(a.hp) + 20)); // medbay patch-up
      sa.inv = a.inv.map((s) => ({ ...s }));
    }
  }
  save.kills += result.kills;
  save.credits += result.creditsEarned;
  if (result.success) save.mission++;
  const wiped = !save.agents.some((a) => a.alive) && save.credits < 1200;
  writeSave(save);
  world = null; city = null; renderer = null; mapBase = null;
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
    panel: ev.clientX < panelW, slot: -1, moved: false,
    camStart: { x: cam.x, y: cam.y },
  };
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
    w.cmdShoot(w.uiSelected, t.x, t.y);
    return;
  }
  // walk mode: pickups and cars take priority
  let bestDrop = -1, bdd = 1.9 * 1.9; // generous tap radius - loot may sit behind a building
  for (const d of w.drops) {
    const dd = (d.x - t.x) ** 2 + (d.y - t.y) ** 2;
    if (dd < bdd) { bdd = dd; bestDrop = d.id; }
  }
  if (bestDrop >= 0) { w.cmdPickup(w.uiSelected, bestDrop); followCam = true; return; }

  const lead = w.selectedAgents(w.uiSelected)[0];
  for (const c of w.cars) {
    const dd = (c.x - t.x) ** 2 + (c.y - t.y) ** 2;
    if (dd < 1.6 * 1.6 && (c.state === "parked" || (c.state === "player" && lead && lead.carId === null))) {
      w.cmdBoardCar(w.uiSelected, c.id);
      followCam = true;
      return;
    }
  }
  if (lead && lead.carId !== null) {
    // driving: tap road to drive, tap nearby off-road to dismount
    const tileIsRoad = city && t.x >= 0 && t.y >= 0 && t.x < GRID && t.y < GRID &&
      city.tiles[idx(t.x | 0, t.y | 0)] === T_ROAD;
    if (tileIsRoad) w.cmdMove(w.uiSelected, t.x, t.y);
    else w.cmdExitCar(w.uiSelected);
    followCam = true;
    return;
  }
  w.cmdMove(w.uiSelected, t.x, t.y);
  followCam = true;
}
canvas.addEventListener("pointerup", pointerEnd);
canvas.addEventListener("pointercancel", pointerEnd);

function handlePanelTap(hit: ReturnType<Panel["hit"]>): void {
  const w = world!;
  audio.click();
  switch (hit.type) {
    case "doll": {
      w.uiSelected = [false, false, false, false];
      if (w.agents[hit.i] && w.agents[hit.i].hp > 0) w.uiSelected[hit.i] = true;
      followCam = true;
      break;
    }
    case "emblem": {
      for (let i = 0; i < 4; i++) w.uiSelected[i] = w.agents[i] ? w.agents[i].hp > 0 : false;
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
      if (n === 0) {
        for (const a of world.selectedAgents(world.uiSelected)) { fx += a.x; fy += a.y; n++; }
      }
      if (n > 0) {
        cam.x = lerp(cam.x, fx / n, Math.min(1, dt * 4));
        cam.y = lerp(cam.y, fy / n, Math.min(1, dt * 4));
      }
    }
    world.camX = cam.x; world.camY = cam.y;

    renderer.draw(g, world, art, people, cam, panelW, 0, vw, vh, world.time);
    panel.draw(g, world, people, mapBase, mode, audio.muted, world.time, save.mission, dragGhost ? dragGhost.overDoll : -1);

    // notices
    let ny = 8;
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
  setFollow(v: boolean) { followCam = v; },
};

// ---------- boot ----------

screens.showMenu(loadSave() !== null, (cont) => {
  if (!cont) { clearSave(); save = newCampaign(); writeSave(save); }
  rollMission();
  gotoBriefing();
});
