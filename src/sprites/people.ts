// Procedural pixel-art people. Every model is generated at load time into a
// sprite sheet: 8 directions (rows) x 13 frames (cols):
// col 0 = idle, 1-4 = walk, 5-8 = flee, 9-12 = die.

import { Rng } from "../engine/rng";
import { ctx2d, makeCanvas } from "../engine/util";

export const FW = 16, FH = 24;
export const ANIM_IDLE = 0, ANIM_WALK = 1, ANIM_FLEE = 5, ANIM_DIE = 9;

export interface PersonModel {
  sheet: HTMLCanvasElement;
  armed: boolean;
}

interface Params {
  female: boolean;
  skin: string;
  hair: string;
  hairStyle: number;   // 0 bald/hood, 1 short, 2 long, 3 mohawk, 4 ponytail
  top: string;         // jacket/coat/dress
  topDark: string;
  bottom: string;      // pants / legs
  boots: string;
  accent: string;      // neon trim
  coat: boolean;       // long coat over legs
  dress: boolean;
  shades: boolean;
  cap: boolean;        // police cap
  capColor: string;
  armed: boolean;
}

const SKINS = ["#e8b58c", "#d99e6e", "#b97a4e", "#8a5632", "#6e4225", "#f0c8a8", "#c68a5a"];
const NEON = ["#25e0ff", "#ff2fa0", "#ffe32f", "#7dff3f", "#ff7a1f", "#b06bff", "#2fff9f"];
const CLOTH = ["#20242c", "#2a2e3c", "#3a2e3a", "#1c2a30", "#33222a", "#2e3626", "#26203a", "#40342a", "#1f1f26", "#4a3a44"];
const HAIRC = ["#171314", "#3a2a1c", "#6a4a2a", "#b8b4ac", "#25e0ff", "#ff2fa0", "#7dff3f", "#e8e2d0", "#8a2be2", "#c22"];

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.max(0, Math.round(((n >> 16) & 255) * f)));
  const g = Math.min(255, Math.max(0, Math.round(((n >> 8) & 255) * f)));
  const b = Math.min(255, Math.max(0, Math.round((n & 255) * f)));
  return `rgb(${r},${g},${b})`;
}

function civParams(r: Rng): Params {
  const female = r.chance(0.5);
  const top = r.pick(CLOTH);
  return {
    female,
    skin: r.pick(SKINS),
    hair: r.pick(HAIRC),
    hairStyle: female ? r.pick([1, 2, 2, 3, 4, 4]) : r.pick([0, 1, 1, 1, 3, 4]),
    top,
    topDark: shade(top, 0.7),
    bottom: r.pick(CLOTH),
    boots: r.chance(0.5) ? "#14141a" : "#2c2320",
    accent: r.pick(NEON),
    coat: !female && r.chance(0.35),
    dress: female && r.chance(0.45),
    shades: r.chance(0.25),
    cap: false,
    capColor: "#000",
    armed: false,
  };
}

function copParams(): Params {
  return {
    female: false, skin: "#d99e6e", hair: "#171314", hairStyle: 1,
    top: "#1d2c4e", topDark: "#14203c", bottom: "#18254a",
    boots: "#0e0e14", accent: "#25e0ff", coat: false, dress: false,
    shades: true, cap: true, capColor: "#15203a", armed: true,
  };
}

function enemyParams(): Params {
  return {
    female: false, skin: "#c68a5a", hair: "#171314", hairStyle: 0,
    top: "#3c1420", topDark: "#2a0e18", bottom: "#1c1016",
    boots: "#0e0a0c", accent: "#ff2fa0", coat: true, dress: false,
    shades: true, cap: false, capColor: "#000", armed: true,
  };
}

function playerParams(): Params {
  return {
    female: false, skin: "#e8b58c", hair: "#171314", hairStyle: 1,
    top: "#6b5334", topDark: "#4e3c26", bottom: "#33291c",
    boots: "#181410", accent: "#25e0ff", coat: true, dress: false,
    shades: true, cap: false, capColor: "#000", armed: true,
  };
}

// dir: 0 S,1 SW,2 W,3 NW,4 N,5 NE,6 E,7 SE  (screen space)
function drawPose(
  g: CanvasRenderingContext2D, p: Params, dir: number,
  legPhase: number,   // -1..1 stride
  armPhase: number,   // -1..1 swing
  flee: boolean,
  crouch: number      // 0..2 px sink (dying stagger)
): void {
  const facingFront = dir === 0 || dir === 1 || dir === 7;
  const facingBack = dir === 3 || dir === 4 || dir === 5;
  const profile = dir === 2 || dir === 6;
  const fx = dir === 1 || dir === 2 || dir === 3 ? -1 : dir === 5 || dir === 6 || dir === 7 ? 1 : 0; // screen-x lean of facing

  const cx = 8; // center
  const bob = Math.abs(legPhase) > 0.5 ? 1 : 0;
  const oy = crouch + bob;

  const px = (x: number, y: number, w: number, h: number, col: string) => {
    g.fillStyle = col;
    g.fillRect(x, y + oy, w, h);
  };

  const bw = profile ? 4 : 6; // body width
  const bx = cx - bw / 2 + fx;

  // ---- legs (y 16..23) ----
  const stride = flee ? 3 : 2;
  const lOff = Math.round(legPhase * stride);
  const legY = 16;
  const legCol = p.dress ? p.skin : p.bottom;
  if (profile) {
    px(cx - 1 + fx + lOff, legY, 2, 7, legCol);
    px(cx - 1 + fx - lOff, legY, 2, 7, shade(legCol, 0.8));
    px(cx - 1 + fx + lOff, 22, 2, 2, p.boots);
    px(cx - 1 + fx - lOff, 22, 2, 2, shade(p.boots, 0.8));
  } else {
    px(cx - 3 + fx, legY + Math.max(0, -lOff), 2, 7 - Math.max(0, -lOff), legCol);
    px(cx + 1 + fx, legY + Math.max(0, lOff), 2, 7 - Math.max(0, lOff), shade(legCol, 0.85));
    px(cx - 3 + fx, 22, 2, 2, p.boots);
    px(cx + 1 + fx, 22, 2, 2, shade(p.boots, 0.85));
  }

  // ---- torso (y 8..16) ----
  px(bx, 8, bw, 8, facingBack ? p.topDark : p.top);
  if (p.coat) {
    // long coat flaps over legs
    px(bx, 16, bw, 4, facingBack ? shade(p.topDark, 0.9) : p.topDark);
    if (facingFront) px(cx + fx, 9, 1, 10, shade(p.top, 0.55)); // coat split
  }
  if (p.dress) {
    px(bx - 1, 15, bw + 2, 4, facingBack ? p.topDark : p.top);
  }
  // neon trim
  if (!facingBack) px(bx, 8, bw, 1, p.accent);

  // ---- arms (y 9..15) ----
  const armCol = p.top;
  if (flee) {
    // arms thrown up
    px(bx - 2, 3, 2, 7, armCol);
    px(bx + bw, 3, 2, 7, armCol);
    px(bx - 2, 2, 2, 2, p.skin);
    px(bx + bw, 2, 2, 2, p.skin);
  } else if (p.armed && !facingBack) {
    // weapon arm extended toward facing
    const gx = fx >= 0 ? bx + bw : bx - 4;
    px(gx, 11, 4, 2, armCol);
    px(fx >= 0 ? gx + 3 : gx, 11, 2, 1, "#0c0c10"); // gun
    px(bx - (fx >= 0 ? 2 : 0) + (fx >= 0 ? 0 : bw + 2) - 2, 9 - Math.round(armPhase), 2, 6, shade(armCol, 0.8));
  } else {
    const swing = Math.round(armPhase * 1.5);
    if (!profile) {
      px(bx - 2, 9 + swing, 2, 6, shade(armCol, 0.9));
      px(bx + bw, 9 - swing, 2, 6, shade(armCol, 0.9));
      px(bx - 2, 14 + swing, 2, 1, p.skin);
      px(bx + bw, 14 - swing, 2, 1, p.skin);
    } else {
      px(cx - 1 + fx, 9 + swing, 2, 6, shade(armCol, 0.85));
      px(cx - 1 + fx, 14 + swing, 2, 1, p.skin);
    }
  }

  // ---- head (y 1..7) ----
  const hx = cx - 2 + fx;
  px(hx, 2, 5, 5, p.skin);
  // hair / cap
  if (p.cap) {
    px(hx - 1, 1, 7, 2, p.capColor);
    px(hx + (fx >= 0 ? 4 : -1), 2, 2, 1, p.capColor); // visor
    px(hx + 2, 1, 1, 1, "#ffd700");                    // badge glint
  } else {
    switch (p.hairStyle) {
      case 0: px(hx, 1, 5, 1, shade(p.skin, 0.85)); break; // bald/buzz
      case 1: px(hx, 1, 5, 2, p.hair); if (facingBack) px(hx, 3, 5, 2, p.hair); break;
      case 2: // long
        px(hx, 1, 5, 2, p.hair);
        px(hx - 1, 2, 1, 6, p.hair); px(hx + 5, 2, 1, 6, p.hair);
        if (facingBack) px(hx, 3, 5, 4, p.hair);
        break;
      case 3: px(hx + 1, 0, 3, 2, p.hair === p.accent ? p.hair : p.accent); break; // mohawk
      case 4: px(hx, 1, 5, 2, p.hair); px(hx + (facingBack ? 2 : fx >= 0 ? -1 : 5), 3, 1, 4, p.hair); break; // ponytail
    }
  }
  // face
  if (facingFront || profile) {
    if (p.shades) {
      px(hx + (profile ? (fx > 0 ? 2 : 0) : 0), 3, profile ? 3 : 5, 1, "#0a0a0e");
    } else {
      if (profile) px(hx + (fx > 0 ? 3 : 1), 3, 1, 1, "#101014");
      else { px(hx + 1, 3, 1, 1, "#101014"); px(hx + 3, 3, 1, 1, "#101014"); }
    }
  }
}

function buildSheet(p: Params): HTMLCanvasElement {
  const sheet = makeCanvas(FW * 13, FH * 8);
  const g = ctx2d(sheet);
  const tmp = makeCanvas(FW, FH);
  const tg = ctx2d(tmp);

  for (let dir = 0; dir < 8; dir++) {
    const row = dir * FH;
    const cell = (col: number, fn: () => void) => {
      tg.clearRect(0, 0, FW, FH);
      fn();
      g.drawImage(tmp, col * FW, row);
    };
    // idle
    cell(0, () => drawPose(tg, p, dir, 0, 0, false, 0));
    // walk 4
    const phases = [1, 0.2, -1, -0.2];
    for (let f = 0; f < 4; f++) cell(1 + f, () => drawPose(tg, p, dir, phases[f], phases[f], false, 0));
    // flee 4
    for (let f = 0; f < 4; f++) cell(5 + f, () => drawPose(tg, p, dir, phases[f], 0, true, 0));
    // die 4: stagger, crumple, falling, prone
    cell(9, () => drawPose(tg, p, dir, 0.6, -1, false, 1));
    cell(10, () => drawPose(tg, p, dir, 0, 0, false, 3));
    // rotated falls
    for (let f = 0; f < 2; f++) {
      tg.clearRect(0, 0, FW, FH);
      drawPose(tg, p, dir, 0, 0, false, 0);
      const fall = makeCanvas(FW, FH);
      const fg = ctx2d(fall);
      fg.save();
      fg.translate(FW / 2, FH - 2);
      fg.rotate((f === 0 ? 55 : 90) * Math.PI / 180 * (dir >= 4 ? -1 : 1));
      if (f === 1) fg.scale(1, 0.75);
      fg.drawImage(tmp, -FW / 2, -(FH - 2));
      fg.restore();
      if (f === 1) { // blood pool
        fg.fillStyle = "rgba(120,10,18,0.85)";
        fg.fillRect(2, FH - 5, 12, 3);
        fg.fillRect(4, FH - 6, 7, 1);
      }
      g.drawImage(fall, (11 + f) * FW, row);
    }
  }
  return sheet;
}

export interface PeopleAtlas {
  civs: PersonModel[]; // 30 civilian designs
  cop: PersonModel;
  enemy: PersonModel;
  player: PersonModel;
}

export function buildPeople(seed: number): PeopleAtlas {
  const r = new Rng(seed ^ 0x51ca90);
  const civs: PersonModel[] = [];
  for (let i = 0; i < 30; i++) {
    civs.push({ sheet: buildSheet(civParams(r)), armed: false });
  }
  return {
    civs,
    cop: { sheet: buildSheet(copParams()), armed: true },
    enemy: { sheet: buildSheet(enemyParams()), armed: true },
    player: { sheet: buildSheet(playerParams()), armed: true },
  };
}
