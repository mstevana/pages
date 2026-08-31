// Procedural people. Every model is generated at load time into a sprite
// sheet: 8 directions (rows) x 13 frames (cols):
// col 0 = idle, 1-4 = walk, 5-8 = flee, 9-12 = die.
//
// These used to be flat rectangles of colour. They are now built as lit forms:
// every limb is a tapered, rounded body shaded across its width from a key
// light above and to the screen-left, with a cool bounce down its shadow side,
// contact shadow where one part sits against another, and a face that has a
// brow, a nose and a jaw rather than two dots. The sheet is rasterised at
// PED_SS times the logical frame so none of that turns to porridge when the
// camera comes in close.

import { Rng } from "../engine/rng";
import { ctx2d, makeCanvas } from "../engine/util";

export const FW = 16, FH = 24;    // logical frame, in the units drawPose works in
export const PED_SS = 3;          // sheet pixels per logical unit
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

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function shade(hex: string, f: number): string {
  const [r, g, b] = rgb(hex);
  const c = (v: number): number => Math.min(255, Math.max(0, Math.round(v * f)));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}
// A lit body is never just its own colour scaled: the light adds warmth where
// it lands and the sky adds blue to the side it misses. Mixing toward those
// two is what stops a figure looking like a paper cut-out.
function tint(hex: string, f: number, towards: [number, number, number], amt: number): string {
  const [r, g, b] = rgb(hex);
  const mix = (v: number, t: number): number =>
    Math.min(255, Math.max(0, Math.round(v * f + (t - v * f) * amt)));
  return `rgb(${mix(r, towards[0])},${mix(g, towards[1])},${mix(b, towards[2])})`;
}
const KEY: [number, number, number] = [255, 240, 214];    // warm street light
const SKY: [number, number, number] = [78, 104, 150];     // cool bounce

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

// ---------------------------------------------------------------- painting --

// A rounded, tapered body - the shape every limb and the torso are made of.
// Width may differ top and bottom, corners are rounded by `r`, and the fill
// runs across it: highlight where the key light lands, the body colour, then
// the terminator and a thin sky-lit edge on the far side.
// Every limb on every model is filled with the same handful of cross-body
// ramps, so they are built once over 0..1 and stretched onto each shape. The
// alternative - one gradient object per limb per pose per direction per model -
// is tens of thousands of them at load.
const ramps = new Map<string, CanvasGradient>();
function ramp(g: CanvasRenderingContext2D, col: string, lit: number, side: number): CanvasGradient {
  const key = col + "|" + lit.toFixed(2) + "|" + side.toFixed(2);
  let gr = ramps.get(key);
  if (!gr) {
    gr = g.createLinearGradient(0, 0, 1, 0);
    // `side` swings the highlight with the way the body is turned, so a figure
    // walking away is lit down the edge you can actually see.
    const hi = 0.5 - side * 0.22;
    gr.addColorStop(0, tint(col, lit * 0.70, SKY, 0.12));
    gr.addColorStop(Math.max(0.02, hi - 0.18), tint(col, lit * 1.26, KEY, 0.16));
    gr.addColorStop(Math.min(0.90, hi + 0.30), tint(col, lit * 0.90, KEY, 0.02));
    gr.addColorStop(0.93, tint(col, lit * 0.40, SKY, 0.16));
    gr.addColorStop(1, tint(col, lit * 0.86, SKY, 0.34));
    ramps.set(key, gr);
  }
  return gr;
}

// the light that lands on the top of the shoulders, fading down the chest
const caps = new Map<string, CanvasGradient>();
function capRamp(g: CanvasRenderingContext2D, col: string, lit: number): CanvasGradient {
  const key = col + "|" + lit.toFixed(2);
  let gr = caps.get(key);
  if (!gr) {
    gr = g.createLinearGradient(0, 7.05, 0, 9.0);
    gr.addColorStop(0, tint(col, lit * 1.35, KEY, 0.22));
    gr.addColorStop(1, "rgba(0,0,0,0)");
    caps.set(key, gr);
  }
  return gr;
}

function form(
  g: CanvasRenderingContext2D,
  cx: number, y0: number, y1: number, wTop: number, wBot: number,
  col: string, lit: number, side: number, r = 0.35
): void {
  const w = Math.max(wTop, wBot);
  g.save();
  g.translate(cx - w / 2, 0);
  g.scale(w, 1);
  g.fillStyle = ramp(g, col, lit, side);
  taper(g, 0.5, y0, y1, wTop / w, wBot / w, r / w, r);
  g.fill();
  g.restore();
}

function taper(
  g: CanvasRenderingContext2D,
  cx: number, y0: number, y1: number, wTop: number, wBot: number,
  rx: number, ry = rx
): void {
  const tl = cx - wTop / 2, tr = cx + wTop / 2;
  const bl = cx - wBot / 2, br = cx + wBot / 2;
  const ax = Math.min(rx, wTop / 2, wBot / 2);
  const ay = Math.min(ry, (y1 - y0) / 2);
  g.beginPath();
  g.moveTo(tl + ax, y0);
  g.lineTo(tr - ax, y0);
  g.quadraticCurveTo(tr, y0, tr + (br - tr) * ay / (y1 - y0), y0 + ay);
  g.lineTo(br, y1 - ay);
  g.quadraticCurveTo(br, y1, br - ax, y1);
  g.lineTo(bl + ax, y1);
  g.quadraticCurveTo(bl, y1, bl, y1 - ay);
  g.lineTo(tl - (tl - bl) * ay / (y1 - y0), y0 + ay);
  g.quadraticCurveTo(tl, y0, tl + ax, y0);
  g.closePath();
}

// Contact shadow: what one part of a body casts on the part beneath it. Two
// flat bands rather than a gradient - at this size they are indistinguishable,
// and a gradient object per call, thirty thousand times over, is not.
function occl(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, a: number): void {
  g.fillStyle = `rgba(6,6,10,${a})`;
  g.fillRect(x, y, w, h * 0.45);
  g.fillStyle = `rgba(6,6,10,${a * 0.45})`;
  g.fillRect(x, y + h * 0.45, w, h * 0.55);
}

// dir: 0 S,1 SW,2 W,3 NW,4 N,5 NE,6 E,7 SE  (screen space)
function drawPose(
  g: CanvasRenderingContext2D, p: Params, dir: number,
  legPhase: number,   // -1..1 stride
  armPhase: number,   // -1..1 swing
  flee: boolean,
  crouch: number      // 0..2 units sink (dying stagger)
): void {
  const facingFront = dir === 0 || dir === 1 || dir === 7;
  const facingBack = dir === 3 || dir === 4 || dir === 5;
  const profile = dir === 2 || dir === 6;
  // which way the body is turned across the screen, -1 left .. +1 right
  const fx = dir === 1 || dir === 2 || dir === 3 ? -1 : dir === 5 || dir === 6 || dir === 7 ? 1 : 0;

  const cx = 8;
  const bob = Math.abs(legPhase) > 0.5 ? 0.7 : 0;
  const oy = crouch + bob;
  g.save();
  g.translate(0, oy);

  // A back is turned away from the key light and reads darker as a whole; the
  // side of the body that faces the light picks the highlight up.
  const lit = facingBack ? 0.82 : 1;
  const side = fx * 0.8;
  const skinL = facingBack ? 0.86 : 1;

  // Roughly five heads tall. The old figures were three and a half, which is
  // fine as a pictogram and reads as a balloon on a stick the moment the forms
  // are actually shaded.
  const bw = profile ? 4.4 : p.female ? 5.7 : 6.3;      // shoulder width
  const waist = bw * (p.female ? 0.7 : 0.78);
  const bx = cx + fx * 0.5;                             // body centre line
  const shoulderY = 7.3, waistY = 14.6, hipY = 15.6, ankY = 22.2, soleY = 23.7;

  // ---- legs ------------------------------------------------------------
  const stride = flee ? 2.6 : 1.8;
  const lOff = legPhase * stride;
  const legCol = p.dress ? p.skin : p.bottom;
  const legLit = p.dress ? skinL : lit;
  const leg = (dx: number, lift: number, back: boolean): void => {
    const c = back ? shade(legCol, 0.78) : legCol;
    const l = legLit * (back ? 0.86 : 1);
    // thigh into calf, narrowing to the ankle, with a crease at the knee
    form(g, bx + dx, hipY - lift * 0.25, ankY - lift, 2.15, 1.35, c, l, side, 0.45);
    g.fillStyle = `rgba(8,8,12,${back ? 0.3 : 0.2})`;
    g.fillRect(bx + dx - 1.0, 19.2 - lift * 0.6, 2.0, 0.3);
    // shoe: a sole on the ground and a toe pointing where he does
    const toe = fx === 0 ? (dir === 0 ? 0.45 : -0.45) : fx * 0.85;
    form(g, bx + dx + toe * 0.5, ankY - lift, soleY - lift, 1.7, 2.2, p.boots, l * 1.05, side, 0.45);
    g.fillStyle = `rgba(232,228,220,${0.16 * l})`;
    g.fillRect(bx + dx - 0.85 + toe * 0.5, ankY - lift + 0.05, 1.7, 0.22);   // instep
    g.fillStyle = "rgba(4,4,8,0.6)";
    g.fillRect(bx + dx - 1.2 + toe * 0.5, soleY - lift - 0.42, 2.4, 0.42);
  };
  if (profile) {
    leg(-lOff * 0.5, -Math.min(0, lOff) * 0.5, true);
    leg(lOff * 0.5, Math.max(0, lOff) * 0.5, false);
  } else {
    leg(-1.35, Math.max(0, -lOff) * 0.7, lOff > 0);
    leg(1.35, Math.max(0, lOff) * 0.7, lOff < 0);
    // the dark between the legs: without it a pair of trousers is one block
    g.fillStyle = "rgba(6,6,10,0.55)";
    g.fillRect(bx - 0.32, hipY, 0.64, 5.4);
  }

  // ---- torso -----------------------------------------------------------
  const topCol = facingBack ? p.topDark : p.top;
  form(g, bx, shoulderY, waistY, bw, waist, topCol, lit, side, 1.0);
  // hips, so the trousers do not simply begin in mid-air
  if (!p.dress) form(g, bx, waistY - 0.2, hipY + 0.6, waist, waist * 0.94, p.bottom, lit, side, 0.5);
  // the shoulders are the top of a barrel, not a flat edge
  g.save();
  g.translate(bx - bw / 2, 0);
  g.scale(bw, 1);
  g.fillStyle = capRamp(g, topCol, lit);
  taper(g, 0.5, shoulderY - 0.25, shoulderY + 1.7, 1, 0.98, 1.0 / bw, 1.0);
  g.fill();
  g.restore();

  if (p.coat) {
    // A coat hangs in two panels and swings open over the legs; a single flare
    // of cloth reads as a skirt, which is not what these people are wearing.
    const skirt = facingBack ? shade(p.topDark, 0.92) : p.topDark;
    const flare = waist * 0.52;
    form(g, bx - flare / 2 - 0.05, hipY - 0.6, 19.3, flare, flare + 0.7, skirt, lit * 0.95, side, 0.35);
    form(g, bx + flare / 2 + 0.05, hipY - 0.6, 19.3, flare, flare + 0.7, skirt, lit * 1.02, side, 0.35);
    g.fillStyle = "rgba(6,6,10,0.5)";
    g.fillRect(bx - 0.12, hipY - 0.6, 0.24, 4.5);              // the split between them
    if (!facingBack) {
      // lapels, folded back and catching the key
      g.fillStyle = tint(p.top, lit * 1.3, KEY, 0.2);
      g.beginPath();
      g.moveTo(bx - 1.4, 7.8); g.lineTo(bx - 0.2, 7.6); g.lineTo(bx - 0.35, 10.6); g.closePath();
      g.moveTo(bx + 1.4, 7.8); g.lineTo(bx + 0.2, 7.6); g.lineTo(bx + 0.35, 10.6); g.closePath();
      g.fill();
    }
  }
  if (p.dress) {
    form(g, bx, waistY - 0.5, 18.4, waist, waist + 2.2, topCol, lit, side, 0.4);
    occl(g, bx - (waist + 2.2) / 2, 17.6, waist + 2.2, 0.9, 0.35);
  } else {
    // belt
    g.fillStyle = tint(p.bottom, lit * 0.5, SKY, 0.1);
    g.fillRect(bx - waist / 2, waistY - 0.55, waist, 0.85);
    g.fillStyle = tint(p.accent, lit * 1.1, KEY, 0.1);
    g.fillRect(bx - 0.4, waistY - 0.45, 0.8, 0.65);
  }
  if (!facingBack) {
    g.fillStyle = tint(p.accent, lit, KEY, 0.05);
    g.fillRect(bx - bw / 2 + 0.2, 7.8, bw - 0.4, 0.4);
  }

  // ---- arms ------------------------------------------------------------
  const armCol = facingBack ? p.topDark : p.top;
  const arm = (x: number, yTop: number, len: number, l: number, cuff: boolean): void => {
    // the crease where the sleeve meets the shoulder
    g.fillStyle = "rgba(6,6,10,0.45)";
    g.fillRect(x + (x < bx ? 0.85 : -1.05), yTop + 0.1, 0.2, len * 0.75);
    form(g, x, yTop, yTop + len, 1.85, 1.3, armCol, lit * l, side, 0.5);
    if (cuff) {
      g.fillStyle = tint(armCol, lit * l * 0.6, SKY, 0.12);
      g.fillRect(x - 0.75, yTop + len - 0.6, 1.5, 0.45);
    }
    form(g, x, yTop + len - 0.15, yTop + len + 1.15, 1.35, 1.15, p.skin, skinL * l, side, 0.5);
  };
  if (flee) {
    arm(bx - bw / 2 - 0.4, 2.6, 5.2, 0.95, false);             // thrown over the head
    arm(bx + bw / 2 + 0.4, 2.6, 5.2, 0.85, false);
  } else if (p.armed && !facingBack) {
    const sgn = fx >= 0 ? 1 : -1;
    const gxc = bx + sgn * (bw / 2 + 1.3);
    form(g, gxc, 10.2, 11.9, 1.6, 1.6, armCol, lit, side, 0.45);
    g.save();
    g.translate(gxc + sgn * 0.95, 11.1);
    g.fillStyle = "#15151b";
    g.fillRect(sgn > 0 ? -0.5 : -1.7, -0.45, 2.2, 0.8);        // slide
    g.fillStyle = "#0a0a0e";
    g.fillRect(sgn > 0 ? -0.25 : -0.5, 0.25, 0.75, 1.1);       // grip
    g.fillStyle = "rgba(196,206,220,0.5)";
    g.fillRect(sgn > 0 ? -0.5 : -1.7, -0.45, 2.2, 0.18);
    g.restore();
    arm(bx - sgn * (bw / 2 + 0.4), 8.4 - armPhase * 0.6, 5.0, 0.86, true);
  } else {
    const swing = armPhase * 1.2;
    if (!profile) {
      arm(bx - bw / 2 - 0.4, 8.1 + swing, 5.0, 0.92, true);
      arm(bx + bw / 2 + 0.4, 8.1 - swing, 5.0, 0.8, true);
    } else {
      arm(bx + fx * 0.35, 8.1 + swing, 5.0, 1.02, true);
    }
  }
  occl(g, bx - bw / 2 - 1.0, 7.7, bw + 2.0, 1.1, 0.28);        // under the shoulders

  // ---- head ------------------------------------------------------------
  const hcx = cx + fx * 0.8;
  const crown = 1.2, brow = 3.35, cheek = 4.95, chin = 6.15;
  const HW = 1.72, JW = 1.16;                                   // cranium / jaw half-widths
  // neck, sunk in the shadow the jaw throws
  form(g, hcx - fx * 0.25, 5.4, 7.8, 1.5, 1.9, p.skin, skinL * 0.7, side, 0.3);
  // One path for the whole head - cranium over the brow, cheeks tapering to a
  // chin. A clip and a knocked-out jaw cost a compositing layer per pose, and
  // there are three thousand poses.
  g.save();
  g.translate(hcx - HW, 0);
  g.scale(HW * 2, 1);
  g.fillStyle = ramp(g, p.skin, skinL, side);
  g.beginPath();
  g.moveTo(0, brow);
  g.bezierCurveTo(0, crown - 0.35, 1, crown - 0.35, 1, brow);
  g.lineTo(0.5 + JW / (HW * 2), cheek);
  g.quadraticCurveTo(0.5, chin, 0.5 - JW / (HW * 2), cheek);
  g.closePath();
  g.fill();
  g.restore();
  // forehead: the one place a head really catches the sky
  g.fillStyle = `rgba(255,246,228,${0.16 * skinL})`;
  g.beginPath();
  g.ellipse(hcx - 0.5 - side * 0.35, brow - 0.55, 0.85, 0.5, -0.2, 0, Math.PI * 2);
  g.fill();
  if (!facingFront || fx !== 0) {                               // ear
    g.fillStyle = tint(p.skin, skinL * 0.84, SKY, 0.06);
    g.beginPath();
    g.ellipse(hcx - (fx >= 0 ? 1.62 : -1.62), 3.9, 0.34, 0.55, 0, 0, Math.PI * 2);
    g.fill();
  }

  // ---- hair / cap ------------------------------------------------------
  if (p.cap) {
    g.save();
    g.translate(hcx - 1.85, 0);
    g.scale(3.7, 1);
    g.fillStyle = ramp(g, p.capColor, 1.5, side);
    g.beginPath(); g.ellipse(0.5, 2.5, 0.5, 1.35, 0, Math.PI, 0); g.fill();
    g.restore();
    g.fillStyle = tint(p.capColor, 0.55, SKY, 0.1);
    g.beginPath();
    g.ellipse(hcx + (fx >= 0 ? 0.8 : -0.8), 2.75, 1.7, 0.5, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#ffd24a";
    g.fillRect(hcx - 0.3, 1.55, 0.6, 0.55);
  } else {
    const hcol = p.hairStyle === 3 && p.hair !== p.accent ? p.accent : p.hair;
    const hd = tint(hcol, 0.6, SKY, 0.16);
    // a cap of hair that follows the skull rather than sitting on it like felt
    const mass = (w: number, top: number, bot: number): void => {
      g.save();
      g.translate(hcx - w, 0);
      g.scale(w * 2, 1);
      g.fillStyle = ramp(g, hcol, 1.35, side);
      g.beginPath(); g.ellipse(0.5, (top + bot) / 2, 0.5, (bot - top) / 2, 0, 0, Math.PI * 2); g.fill();
      g.restore();
    };
    switch (p.hairStyle) {
      case 0:
        g.fillStyle = tint(p.skin, skinL * 0.9, SKY, 0.1);
        g.beginPath(); g.ellipse(hcx, 2.3, 1.6, 1.0, 0, Math.PI, 0); g.fill();
        break;
      case 1:
        mass(1.78, crown - 0.2, 3.05);
        g.fillStyle = tint(hcol, 0.85, SKY, 0.1);
        g.fillRect(hcx - 1.7, 2.7, 0.42, 1.5);                  // sideburns
        g.fillRect(hcx + 1.28, 2.7, 0.42, 1.5);
        break;
      case 2:
        mass(1.95, crown - 0.2, 3.25);
        g.fillStyle = hd;
        g.beginPath();
        g.ellipse(hcx - 1.6, 3.9, 0.5, 2.0, 0, 0, Math.PI * 2);
        g.ellipse(hcx + 1.6, 3.9, 0.5, 2.0, 0, 0, Math.PI * 2);
        g.fill();
        if (facingBack) mass(1.95, crown - 0.2, 6.2);
        break;
      case 3:
        g.fillStyle = tint(hcol, 1.6, KEY, 0.2);
        g.beginPath();
        g.moveTo(hcx - 0.55, 2.1); g.quadraticCurveTo(hcx, -0.3, hcx + 0.55, 2.1);
        g.closePath(); g.fill();
        g.fillStyle = hd;
        g.beginPath(); g.ellipse(hcx, 2.2, 1.6, 0.8, 0, Math.PI, 0); g.fill();
        break;
      case 4:
        mass(1.78, crown - 0.2, 3.0);
        g.fillStyle = hd;
        g.beginPath();
        g.ellipse(hcx + (facingBack ? 0 : fx >= 0 ? -1.7 : 1.7), 4.2, 0.5, 1.6, 0, 0, Math.PI * 2);
        g.fill();
        break;
    }
    if (p.hairStyle !== 0 && p.hairStyle !== 3) {
      g.fillStyle = "rgba(255,250,235,0.30)";                   // gleam along the top
      g.beginPath();
      g.ellipse(hcx - 0.6 - side * 0.4, crown + 0.5, 0.7, 0.26, -0.25, 0, Math.PI * 2);
      g.fill();
    }
  }

  // ---- face ------------------------------------------------------------
  if (facingFront || profile) {
    // the brow casts the shadow the eyes sit in
    g.fillStyle = "rgba(26,16,18,0.42)";
    g.fillRect(hcx - 1.45, brow + 0.1, 2.9, 0.85);
    if (p.shades) {
      const sg = g.createLinearGradient(hcx - 1.5, 0, hcx + 1.5, 0);
      sg.addColorStop(0, "#191b23");
      sg.addColorStop(0.42, "#06060a");
      sg.addColorStop(0.56, "#39404e");
      sg.addColorStop(1, "#08080c");
      g.fillStyle = sg;
      if (profile) g.fillRect(hcx + (fx > 0 ? 0.1 : -1.6), brow + 0.25, 1.5, 0.7);
      else {
        g.fillRect(hcx - 1.5, brow + 0.25, 3.0, 0.72);
        g.fillStyle = "rgba(180,200,225,0.5)";
        g.fillRect(hcx - 1.3, brow + 0.32, 0.55, 0.18);
      }
    } else if (profile) {
      g.fillStyle = "rgba(20,16,20,0.75)";
      g.fillRect(hcx + (fx > 0 ? 0.55 : -1.0), brow + 0.4, 0.45, 0.5);
    } else {
      g.fillStyle = "rgba(232,230,222,0.9)";
      g.fillRect(hcx - 1.08, brow + 0.5, 0.9, 0.55);
      g.fillRect(hcx + 0.18, brow + 0.5, 0.9, 0.55);
      g.fillStyle = "rgba(14,11,14,0.95)";
      g.fillRect(hcx - 0.86, brow + 0.52, 0.55, 0.52);
      g.fillRect(hcx + 0.32, brow + 0.52, 0.55, 0.52);
      g.fillStyle = "rgba(28,18,18,0.55)";                      // brows
      g.fillRect(hcx - 1.1, brow + 0.18, 0.94, 0.24);
      g.fillRect(hcx + 0.16, brow + 0.18, 0.94, 0.24);
    }
    // nose: a shadow down one side face on, a silhouette in profile
    if (profile) {
      g.fillStyle = tint(p.skin, skinL * 1.12, KEY, 0.1);
      const nx = hcx + (fx > 0 ? 1.5 : -1.5), nd = fx > 0 ? 1 : -1;
      g.beginPath();
      g.moveTo(nx, brow + 0.6); g.lineTo(nx + nd * 0.6, cheek - 0.2); g.lineTo(nx, cheek + 0.05);
      g.closePath(); g.fill();
    } else {
      g.fillStyle = "rgba(54,28,26,0.42)";
      g.fillRect(hcx + 0.12 + side * 0.22, brow + 1.05, 0.4, 0.8);
    }
    g.fillStyle = "rgba(50,22,26,0.62)";                        // mouth
    g.fillRect(hcx - (profile ? 0.3 : 0.62) + (profile ? fx * 0.75 : 0), cheek + 0.35, profile ? 0.7 : 1.24, 0.3);
    g.fillStyle = "rgba(255,236,210,0.16)";                     // cheekbone
    g.fillRect(hcx - 1.35 - side * 0.3, brow + 1.15, 0.8, 0.7);
  }
  occl(g, hcx - 1.1, 5.7, 2.2, 1.1, 0.45);                      // jaw onto the neck
  g.restore();
}

// One scratch cell for every model, so the cached ramps all belong to the one
// context that made them.
let scratch: { c: HTMLCanvasElement; g: CanvasRenderingContext2D } | null = null;
function cellCtx(): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  if (!scratch) {
    const c = makeCanvas(FW * PED_SS, FH * PED_SS);
    const g = ctx2d(c);
    g.scale(PED_SS, PED_SS);
    scratch = { c, g };
  }
  return scratch;
}

let faller: { c: HTMLCanvasElement; g: CanvasRenderingContext2D } | null = null;
function fallCtx(): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  if (!faller) {
    const c = makeCanvas(FW * PED_SS, FH * PED_SS);
    faller = { c, g: ctx2d(c) };
  }
  return faller;
}

function buildSheet(p: Params): HTMLCanvasElement {
  const sheet = makeCanvas(FW * 13 * PED_SS, FH * 8 * PED_SS);
  const g = ctx2d(sheet);
  const { c: tmp, g: tg } = cellCtx();

  for (let dir = 0; dir < 8; dir++) {
    const row = dir * FH * PED_SS;
    const cell = (col: number, fn: () => void): void => {
      tg.save();
      tg.setTransform(1, 0, 0, 1, 0, 0);
      tg.clearRect(0, 0, FW * PED_SS, FH * PED_SS);
      tg.restore();
      fn();
      g.drawImage(tmp, col * FW * PED_SS, row);
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
      tg.save();
      tg.setTransform(1, 0, 0, 1, 0, 0);
      tg.clearRect(0, 0, FW * PED_SS, FH * PED_SS);
      tg.restore();
      drawPose(tg, p, dir, 0, 0, false, 0);
      const { c: fall, g: fg } = fallCtx();
      fg.setTransform(1, 0, 0, 1, 0, 0);
      fg.clearRect(0, 0, FW * PED_SS, FH * PED_SS);
      fg.imageSmoothingEnabled = true;
      // A body laid out flat is longer than the cell is wide, so it turns
      // about the middle of the cell rather than about its feet, and shortens
      // along its own length - which is what looking down at someone lying on
      // the ground does to them anyway.
      fg.save();
      fg.scale(PED_SS, PED_SS);
      fg.translate(FW / 2, 20);
      fg.rotate((f === 0 ? 55 : 90) * Math.PI / 180 * (dir >= 4 ? -1 : 1));
      fg.scale(f === 0 ? 0.98 : 0.95, f === 0 ? 0.78 : 0.66);
      fg.drawImage(tmp, -FW / 2, -FH / 2, FW, FH);   // the context is already in logical units
      fg.restore();
      if (f === 1) {   // blood, soaking outward from under him
        fg.save();
        fg.globalCompositeOperation = "destination-over";
        fg.scale(PED_SS, PED_SS);
        const bg = fg.createRadialGradient(8, 21, 0.5, 8, 21, 7);
        bg.addColorStop(0, "rgba(150,14,22,0.88)");
        bg.addColorStop(0.5, "rgba(104,8,16,0.7)");
        bg.addColorStop(1, "rgba(70,4,10,0)");
        fg.fillStyle = bg;
        fg.beginPath(); fg.ellipse(8, 21, 7, 2.3, 0, 0, Math.PI * 2); fg.fill();
        fg.restore();
      }
      g.drawImage(fall, (11 + f) * FW * PED_SS, row);
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

// The designs are anonymous crowd, and building thirty of them is the most
// expensive thing that happens at a mission launch, so they are built once and
// kept: pressing LAUNCH a second time should not pay for them again. They are
// also built a sheet at a time against a frame budget while the menu is up, so
// the work is off the launch path without freezing the menu to do it.
const CIVS = 30;
const built: PersonModel[] = [];
const warmRng = new Rng(0x51ca90);
let cop: PersonModel | null = null;
let enemy: PersonModel | null = null;
let player: PersonModel | null = null;

// one sheet per call; true once there is nothing left to build
function step(): boolean {
  if (built.length < CIVS) { built.push({ sheet: buildSheet(civParams(warmRng)), armed: false }); return false; }
  if (!cop) { cop = { sheet: buildSheet(copParams()), armed: true }; return false; }
  if (!enemy) { enemy = { sheet: buildSheet(enemyParams()), armed: true }; return false; }
  if (!player) { player = { sheet: buildSheet(playerParams()), armed: true }; return false; }
  return true;
}

// Build for at most `budget` ms. Call it every frame from a screen that is not
// the mission; it returns true when there is no more to do.
export function warmPeople(budget = 7): boolean {
  const t0 = performance.now();
  do { if (step()) return true; } while (performance.now() - t0 < budget);
  return false;
}

export function peopleAtlas(): PeopleAtlas {
  while (!step()) { /* whatever the warm did not get to, finish now */ }
  return { civs: built, cop: cop!, enemy: enemy!, player: player! };
}
