// Procedural tile art: ground tiles, extruded building blocks with windows,
// animated ad videowalls and neon signs. Everything is baked per-weather.

import { Rng } from "../engine/rng";
import { buildBenchArt, buildStallArt, buildTreeArt } from "./props";
import { STORY_H, TILE_H, TILE_W, Weather, ctx2d, isNight, isRain, makeCanvas } from "../engine/util";

export interface TileArt {
  weather: Weather;
  ground: HTMLCanvasElement;
  sidewalk: HTMLCanvasElement;
  road: HTMLCanvasElement;
  roadDashV: HTMLCanvasElement; // centerline along grid +y
  roadDashH: HTMLCanvasElement; // centerline along grid +x
  roadPuddle: HTMLCanvasElement;
  park: HTMLCanvasElement;
  island: HTMLCanvasElement;
  // building column sprite for (stories, facade style, hue variant, pattern variant)
  block: (stories: number, style: number, hue: number, variant: number) => HTMLCanvasElement;
  pitFloor: HTMLCanvasElement;
  pitWallNW: HTMLCanvasElement;
  pitWallNE: HTMLCanvasElement;
  lamp: HTMLCanvasElement;
  ads: HTMLCanvasElement[][];    // [variant][frame]
  neons: HTMLCanvasElement[];
  megawalls: HTMLCanvasElement[][];
  billboards: HTMLCanvasElement[];
  shops: HTMLCanvasElement[];
  trees: HTMLCanvasElement[];
  benches: HTMLCanvasElement[];
  stalls: HTMLCanvasElement[];
  crossV: HTMLCanvasElement;     // zebra stripes on a north-south road
  crossH: HTMLCanvasElement;     // zebra stripes on an east-west road
  cutCap: string;                // slab colour where a cut-away wall is sliced
  cutFloor: string;              // interior floor revealed by the cut
  adColors: string[];            // dominant color per ad variant (neon = variant+3)
  ambient: number;               // 0..1 light level
  night: boolean;
}

function tint(hex: string, mult: number, blue: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = ((n >> 16) & 255) * mult;
  let g = ((n >> 8) & 255) * mult;
  let b = (n & 255) * (mult + blue);
  r = Math.min(255, r); g = Math.min(255, g); b = Math.min(255, b);
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function diamond(g: CanvasRenderingContext2D, col: string): void {
  g.fillStyle = col;
  g.beginPath();
  g.moveTo(TILE_W / 2, 0);
  g.lineTo(TILE_W, TILE_H / 2);
  g.lineTo(TILE_W / 2, TILE_H);
  g.lineTo(0, TILE_H / 2);
  g.closePath();
  g.fill();
}

function speckle(g: CanvasRenderingContext2D, r: Rng, col: string, n: number): void {
  g.fillStyle = col;
  for (let i = 0; i < n; i++) {
    const x = r.int(4, TILE_W - 5), y = r.int(2, TILE_H - 3);
    // keep speckles inside the diamond
    if (Math.abs(x - TILE_W / 2) / (TILE_W / 2) + Math.abs(y - TILE_H / 2) / (TILE_H / 2) < 0.9) {
      g.fillRect(x, y, 1, 1);
    }
  }
}

function groundTile(r: Rng, base: string, spek: string, mult: number, blue: number): HTMLCanvasElement {
  const c = makeCanvas(TILE_W, TILE_H);
  const g = ctx2d(c);
  diamond(g, tint(base, mult, blue));
  speckle(g, r, tint(spek, mult, blue), 6);
  return c;
}

export function buildTileArt(seed: number, weather: Weather): TileArt {
  const r = new Rng(seed ^ 0x7a11e5);
  const night = isNight(weather);
  const rain = isRain(weather);
  const ambient = night ? 0.52 : rain ? 0.75 : 1;
  const blue = night ? 0.12 : rain ? 0.05 : 0;

  const ground = groundTile(r, "#3a3a40", "#2c2c31", ambient, blue);
  const sidewalk = groundTile(r, "#55555e", "#46464e", ambient, blue);
  const park = groundTile(r, "#26382e", "#1e2f25", ambient, blue);
  const island = groundTile(r, "#4a4a55", "#3a3a44", ambient, blue);
  const road = groundTile(r, "#26262c", "#1e1e23", ambient, blue);

  const mkDash = (vertical: boolean): HTMLCanvasElement => {
    const c = makeCanvas(TILE_W, TILE_H);
    const g = ctx2d(c);
    g.drawImage(road, 0, 0);
    g.strokeStyle = tint("#8a8654", ambient, blue);
    g.lineWidth = 1;
    g.setLineDash([3, 3]);
    g.beginPath();
    if (vertical) { g.moveTo(TILE_W - 2, TILE_H / 2 - 1); g.lineTo(TILE_W / 2 + 2, TILE_H - 1); }
    else { g.moveTo(TILE_W / 2 + 2, TILE_H - 1); g.lineTo(2, TILE_H / 2 + 1); }
    g.stroke();
    return c;
  };
  const roadDashV = mkDash(true);
  const roadDashH = mkDash(false);

  const roadPuddle = makeCanvas(TILE_W, TILE_H);
  {
    const g = ctx2d(roadPuddle);
    g.drawImage(road, 0, 0);
    if (rain) {
      g.fillStyle = night ? "rgba(90,140,190,0.35)" : "rgba(150,170,200,0.30)";
      g.beginPath();
      g.ellipse(TILE_W / 2, TILE_H / 2, 8, 3.5, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "rgba(230,240,255,0.25)";
      g.fillRect(TILE_W / 2 - 3, TILE_H / 2 - 1, 5, 1);
    }
  }

  // ---- building blocks: styled facades, lazily built & cached ----
  const litCols = ["#ffd76a", "#8fe8ff", "#ff9ec8", "#c0ffa0"];
  // wall hues per style x hue-variant
  const STYLE_HUES: string[][] = [
    ["#5a565e", "#5e584e", "#4e565e"], // concrete
    ["#46586a", "#3e6058", "#4e4868"], // glass tower frame
    ["#5e4a3a", "#56504a", "#4c4c42"], // industrial
    ["#3e3a46", "#463640", "#364046"], // commercial
    ["#565046", "#4e5252", "#565060"], // residential w/ balconies
    ["#6a6458", "#62666a", "#665e66"], // columned
  ];
  const GLASS_COLS = ["#274458", "#22504a", "#343054"];
  const ACCENTS = ["#25e0ff", "#ff2fa0", "#ffe32f", "#ff7a1f", "#7dff3f", "#b06bff"];
  const FACE_W = TILE_W / 2; // 16px: width of one face in the block sprite

  // draw one flat facade (FACE_W x H), later sheared onto the block
  const drawFace = (stories: number, style: number, hue: number, variant: number, sideMult: number): HTMLCanvasElement => {
    const H = stories * STORY_H;
    const c = makeCanvas(FACE_W, H);
    const g = ctx2d(c);
    const fr = new Rng((stories * 131 + style * 37 + hue * 17 + variant * 7 + (sideMult > 0.7 ? 1 : 0)) ^ seed);
    const hueHex = STYLE_HUES[style][hue];
    const wall = tint(hueHex, ambient * sideMult, blue);
    const wallDark = tint(hueHex, ambient * sideMult * 0.7, blue);
    const wallLight = tint(hueHex, ambient * sideMult * 1.3, blue);
    const glassDark = tint(GLASS_COLS[hue], ambient * 0.9 + 0.1, blue + 0.05);
    // accent is stable per building (no per-tile variant) so bands line up
    const accent = ACCENTS[(hue * 2 + style) % ACCENTS.length];
    const h32 = (a: number): number => {
      let x = a | 0;
      x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
      x = Math.imul(x ^ (x >>> 12), 0x297a2d39);
      return (x ^ (x >>> 15)) >>> 0;
    };
    g.fillStyle = wall;
    g.fillRect(0, 0, FACE_W, H);

    const win = (x: number, y: number, w: number, h: number, litChance: number) => {
      g.fillStyle = wallDark;
      g.fillRect(x - 1, y - 1, w + 2, h + 2); // frame
      const lit = night && fr.chance(litChance);
      g.fillStyle = lit ? litCols[fr.int(0, litCols.length - 1)] : glassDark;
      g.fillRect(x, y, w, h);
      if (!lit) { // sky reflection stripe
        g.fillStyle = "rgba(200,225,255,0.10)";
        g.fillRect(x, y, w, 2);
      }
    };

    for (let st = 0; st < stories; st++) {
      const yTop = H - (st + 1) * STORY_H;
      const ground = st === 0;
      switch (style) {
        case 1: { // glass curtain wall
          // floor lighting is hashed per story (not per tile) so whole floors light up coherently
          const litFloor = night && h32(st * 97 + stories * 13 + hue * 7) % 100 < 38;
          g.fillStyle = litFloor ? tint(litCols[h32(st * 31 + hue) % 2], 0.8, 0) : glassDark;
          g.fillRect(0, yTop + 3, FACE_W, STORY_H - 3);
          g.fillStyle = "rgba(210,235,255,0.08)";
          g.fillRect(0, yTop + 4, FACE_W, 3);
          g.fillStyle = wallDark; // mullions
          for (let mx = 3; mx < FACE_W; mx += 4) g.fillRect(mx, yTop + 3, 1, STORY_H - 3);
          g.fillStyle = wall; // floor slab
          g.fillRect(0, yTop, FACE_W, 3);
          break;
        }
        case 2: { // industrial
          g.fillStyle = wallDark;
          g.fillRect(0, yTop, FACE_W, 2);
          if (ground) {
            g.fillStyle = wallDark; // roller shutter
            g.fillRect(2, yTop + 8, 10, STORY_H - 10);
            g.fillStyle = wallLight;
            for (let ly = yTop + 10; ly < yTop + STORY_H - 3; ly += 3) g.fillRect(2, ly, 10, 1);
          } else if (st % 2 === 1 || fr.chance(0.5)) {
            win(2, yTop + 9, 9, 8, 0.3);
            g.fillStyle = wallDark;
            g.fillRect(6, yTop + 9, 1, 8); // pane split
          } else {
            g.fillStyle = wallDark; // vent grill
            g.fillRect(3, yTop + 12, 6, 5);
            g.fillStyle = wallLight;
            for (let ly = yTop + 13; ly < yTop + 17; ly += 2) g.fillRect(3, ly, 6, 1);
          }
          if (variant === 2 && !ground) { // fire-escape stairs zigzagging down
            g.strokeStyle = wallLight;
            g.lineWidth = 1;
            g.beginPath();
            if (st % 2 === 0) { g.moveTo(2, yTop + 4); g.lineTo(13, yTop + STORY_H - 4); }
            else { g.moveTo(13, yTop + 4); g.lineTo(2, yTop + STORY_H - 4); }
            g.stroke();
            g.fillStyle = wallLight; // landing platform
            g.fillRect(1, yTop + STORY_H - 4, 14, 1);
            g.fillStyle = wallDark;
            for (let px = 2; px < 14; px += 4) g.fillRect(px, yTop + STORY_H - 7, 1, 3); // railing posts
          }
          break;
        }
        case 3: { // commercial
          if (ground) {
            g.fillStyle = night ? litCols[fr.int(0, litCols.length - 1)] : glassDark; // storefront
            g.fillRect(1, yTop + 10, FACE_W - 2, STORY_H - 12);
            g.fillStyle = wallDark;
            g.fillRect(8, yTop + 10, 1, STORY_H - 12);
            g.fillStyle = accent; // awning / fascia band
            g.fillRect(0, yTop + 6, FACE_W, 3);
          } else {
            win(3, yTop + 8, 7, 13, 0.55);
            g.fillStyle = accent;
            g.globalAlpha = night ? 0.9 : 0.5;
            g.fillRect(0, yTop + 1, FACE_W, 1); // neon floor strip
            g.globalAlpha = 1;
          }
          break;
        }
        case 4: { // residential with balconies
          win(4, yTop + 6, 8, 13, 0.5);
          const by = yTop + STORY_H - 8; // balcony
          g.fillStyle = wallLight;
          g.fillRect(0, by - 6, FACE_W, 1); // handrail
          for (let px = 1; px < FACE_W; px += 3) g.fillRect(px, by - 5, 1, 5); // balusters
          g.fillStyle = wallDark;
          g.fillRect(0, by, FACE_W, 2); // slab
          break;
        }
        case 5: { // columned
          g.fillStyle = wallDark; // recessed bay
          g.fillRect(3, yTop + 2, FACE_W - 6, STORY_H - 2);
          win(5, yTop + 6, 6, 17, 0.45);
          g.fillStyle = wallLight; // pilasters
          g.fillRect(0, yTop, 3, STORY_H);
          g.fillRect(FACE_W - 3, yTop, 3, STORY_H);
          g.fillStyle = wall;
          g.fillRect(1, yTop, 1, STORY_H);
          g.fillRect(FACE_W - 2, yTop, 1, STORY_H);
          g.fillStyle = wallLight; // capital band
          g.fillRect(0, yTop + 1, FACE_W, 1);
          break;
        }
        default: { // concrete slab
          g.fillStyle = wallDark;
          g.fillRect(0, yTop, FACE_W, 2);
          win(4, yTop + 8, 8, 14, 0.45);
          g.fillStyle = wallLight;
          g.fillRect(3, yTop + 23, 10, 1); // sill
        }
      }
    }
    // grime at street level
    g.fillStyle = "rgba(0,0,0,0.22)";
    g.fillRect(0, H - 3, FACE_W, 3);
    return c;
  };

  const blockCache = new Map<string, HTMLCanvasElement>();
  const block = (stories: number, style: number, hue: number, variant: number): HTMLCanvasElement => {
    stories = Math.max(1, Math.min(8, stories));
    style = style % STYLE_HUES.length;
    hue = hue % 3;
    variant = variant % 3;
    const key = `${stories}|${style}|${hue}|${variant}`;
    let c = blockCache.get(key);
    if (c) return c;
    const H = stories * STORY_H;
    c = makeCanvas(TILE_W, TILE_H + H);
    const g = ctx2d(c);
    const hueHex = STYLE_HUES[style][hue];
    const roofC = tint(hueHex, ambient * 0.48, blue);
    // faces (SW darker, SE lighter), sheared into place
    const swFace = drawFace(stories, style, hue, variant, 0.62);
    const seFace = drawFace(stories, style, hue, variant, 0.88);
    g.save();
    g.transform(1, 0.5, 0, 1, 0, TILE_H / 2);
    g.drawImage(swFace, 0, 0);
    g.restore();
    g.save();
    g.transform(1, -0.5, 0, 1, TILE_W / 2, TILE_H);
    g.drawImage(seFace, 0, 0);
    g.restore();
    // roof
    diamond(g, roofC);
    g.strokeStyle = tint(hueHex, ambient * 0.85, blue);
    g.beginPath();
    g.moveTo(0, TILE_H / 2); g.lineTo(TILE_W / 2, TILE_H); g.lineTo(TILE_W, TILE_H / 2);
    g.stroke();
    // (roof furniture is drawn per-tile at render time so it doesn't repeat
    // on every tile of a building - the sprite here stays clean)
    blockCache.set(key, c);
    return c;
  };

  // ---- pit pieces (sunken shafts) ----
  const PIT_D = 10;
  const pitFloor = makeCanvas(TILE_W, TILE_H + PIT_D);
  {
    const g = ctx2d(pitFloor);
    g.translate(0, PIT_D);
    diamond(g, tint("#141418", ambient + 0.1, blue));
    if (((seed >> 3) & 3) === 0) {
      g.fillStyle = night ? "rgba(255,122,31,0.5)" : "rgba(255,122,31,0.25)";
      g.fillRect(TILE_W / 2 - 1, TILE_H / 2 - 1, 2, 2); // vent glow
    }
  }
  const pitWallNW = makeCanvas(TILE_W, TILE_H + PIT_D);
  {
    const g = ctx2d(pitWallNW); // inner face along the NW edge, descending PIT_D
    g.fillStyle = tint("#3a3a42", ambient * 0.9, blue);
    g.beginPath();
    g.moveTo(0, TILE_H / 2); g.lineTo(TILE_W / 2, 0);
    g.lineTo(TILE_W / 2, PIT_D); g.lineTo(0, TILE_H / 2 + PIT_D);
    g.closePath(); g.fill();
    g.fillStyle = tint("#55555e", ambient, blue);
    g.beginPath();
    g.moveTo(0, TILE_H / 2); g.lineTo(TILE_W / 2, 0);
    g.lineTo(TILE_W / 2, 1.5); g.lineTo(0, TILE_H / 2 + 1.5);
    g.closePath(); g.fill();
  }
  const pitWallNE = makeCanvas(TILE_W, TILE_H + PIT_D);
  {
    const g = ctx2d(pitWallNE); // inner face along the NE edge
    g.fillStyle = tint("#2e2e36", ambient * 0.9, blue);
    g.beginPath();
    g.moveTo(TILE_W / 2, 0); g.lineTo(TILE_W, TILE_H / 2);
    g.lineTo(TILE_W, TILE_H / 2 + PIT_D); g.lineTo(TILE_W / 2, PIT_D);
    g.closePath(); g.fill();
    g.fillStyle = tint("#4a4a54", ambient, blue);
    g.beginPath();
    g.moveTo(TILE_W / 2, 0); g.lineTo(TILE_W, TILE_H / 2);
    g.lineTo(TILE_W, TILE_H / 2 + 1.5); g.lineTo(TILE_W / 2, 1.5);
    g.closePath(); g.fill();
  }

  // ---- street lamp (arm reaches right; renderer mirrors it toward the road) ----
  const lamp = makeCanvas(20, 42);
  {
    const g = ctx2d(lamp);
    const metal = tint("#3a3a44", ambient + 0.2, blue);
    const metalLight = tint("#55555f", ambient + 0.2, blue);
    // base pedestal
    g.fillStyle = metal;
    g.fillRect(5, 38, 6, 2);
    // pole with a lit edge
    g.fillStyle = metal;
    g.fillRect(7, 6, 2, 33);
    g.fillStyle = metalLight;
    g.fillRect(7, 6, 1, 33);
    // arm curving out over the street
    g.fillStyle = metal;
    g.fillRect(8, 4, 6, 2);
    g.fillRect(13, 5, 2, 2);
    // hanging lamp head: shade on top, lens pointing DOWN
    g.fillStyle = tint("#2c2c34", ambient + 0.25, blue);
    g.fillRect(12, 6, 5, 2);
    if (night) {
      g.fillStyle = "#ffe9a8";
      g.fillRect(13, 8, 3, 2); // lens
      // downward cone of light onto the pavement
      const cone = g.createLinearGradient(0, 9, 0, 40);
      cone.addColorStop(0, "rgba(255,230,160,0.34)");
      cone.addColorStop(1, "rgba(255,230,160,0.02)");
      g.fillStyle = cone;
      g.beginPath();
      g.moveTo(13, 9); g.lineTo(16, 9);
      g.lineTo(20, 38); g.lineTo(9, 38);
      g.closePath();
      g.fill();
      // pool of light on the ground under the head
      g.fillStyle = "rgba(255,230,160,0.12)";
      g.beginPath();
      g.ellipse(14.5, 38.5, 5.5, 2.2, 0, 0, Math.PI * 2);
      g.fill();
      // halo around the lens
      const grad = g.createRadialGradient(14.5, 9, 1, 14.5, 9, 7);
      grad.addColorStop(0, "rgba(255,230,160,0.25)"); // most glow now comes from the emissive pass
      grad.addColorStop(1, "rgba(255,230,160,0)");
      g.fillStyle = grad;
      g.fillRect(7, 2, 15, 15);
    } else {
      g.fillStyle = "#c8c8d0";
      g.fillRect(13, 8, 3, 2); // unlit lens still points down
    }
  }

  // ---- animated ad videowalls (8 designs x 4 frames, 24x14) ----
  const AD_W = 24, AD_H = 14;
  const ads: HTMLCanvasElement[][] = [];
  const adTexts = [
    "SYND CORP", "GRID CAB", "RAMEN 24H", "SOMA+", "OBEY", "VOLT BAR", "NEO AIR", "EYE-X",
    "KIRO GEN", "NULL-7", "HAZE", "TOKAI OIL", "PACIFICA", "DERM LAB", "ZERO CAL", "MAG-LEV",
    "ARC TRUST", "BLUE MILE", "OSSUARY", "SILK ROW", "HYPNOS", "TERRA-9", "GLASS EYE", "REBOOT",
    "VITA-SYN", "KRONE", "FATHOM", "IRON MOTH", "SUNSET CO", "LUMEN", "BASALT", "ECHO WARE",
  ];
  const adCols = [
    "#25e0ff", "#ffe32f", "#ff7a1f", "#7dff3f", "#ff2fa0", "#b06bff", "#8fe8ff", "#ff4d6d",
    "#3affc8", "#ffd0e8", "#c2ff2f", "#ff9f45", "#6ea8ff", "#ff5ecb", "#a0ffd8", "#ffb3b3",
  ];
  const AD_STYLES = 8;
  for (let v = 0; v < 32; v++) {
    const frames: HTMLCanvasElement[] = [];
    for (let f = 0; f < 4; f++) {
      const c = makeCanvas(AD_W, AD_H);
      const g = ctx2d(c);
      g.fillStyle = "#06070c";
      g.fillRect(0, 0, AD_W, AD_H);
      const col = adCols[v % adCols.length];
      const ad = adTexts[v % adTexts.length];
      switch (v % AD_STYLES) {
        case 0: { // scrolling text
          g.fillStyle = col;
          g.font = "bold 7px monospace";
          const t = ad + "  " + ad;
          g.fillText(t, 2 - f * 6, 9);
          break;
        }
        case 1: { // blinking brand
          if (f !== 3) {
            g.fillStyle = col;
            g.font = "bold 6px monospace";
            g.fillText(ad.slice(0, 8), 1, 9);
          }
          g.strokeStyle = col;
          g.strokeRect(0.5, 0.5, AD_W - 1, AD_H - 1);
          break;
        }
        case 2: { // eye
          g.fillStyle = col;
          g.beginPath();
          g.ellipse(AD_W / 2, AD_H / 2, 9, 5, 0, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = "#06070c";
          g.beginPath();
          g.arc(AD_W / 2 + (f - 1.5) * 2.5, AD_H / 2, 2.6, 0, Math.PI * 2);
          g.fill();
          break;
        }
        case 3: { // glitch color bars
          for (let b = 0; b < 6; b++) {
            g.fillStyle = adCols[(v + b + f) % adCols.length];
            g.fillRect(b * 4, (b + f) % 2 === 0 ? 0 : 3, 4, AD_H);
          }
          g.fillStyle = "#06070c";
          g.fillRect(0, 10, AD_W, 1);
          g.fillStyle = "#fff";
          g.font = "bold 6px monospace";
          g.fillText(ad.slice(0, 6), 2, 8 + (f % 2));
          break;
        }
        case 4: { // a wipe of colour crossing the panel
          g.fillStyle = col;
          g.fillRect(0, 0, AD_W * ((f + 1) / 4), AD_H);
          g.fillStyle = "#06070c";
          g.font = "bold 6px monospace";
          g.fillText(ad.slice(0, 7), 2, 9);
          break;
        }
        case 5: { // rings pulsing outward
          g.strokeStyle = col;
          for (let k = 0; k < 3; k++) {
            g.globalAlpha = 1 - ((f + k) % 4) / 4;
            g.beginPath();
            g.ellipse(AD_W / 2, AD_H / 2, 2 + ((f + k) % 4) * 3, 1.5 + ((f + k) % 4) * 1.8, 0, 0, Math.PI * 2);
            g.stroke();
          }
          g.globalAlpha = 1;
          break;
        }
        case 6: { // a logo block beside a ticker
          g.fillStyle = col;
          g.fillRect(1, 2, 9, AD_H - 4);
          g.fillStyle = "#06070c";
          g.fillRect(3, 5, 5, 2);
          g.fillStyle = col;
          g.font = "bold 5px monospace";
          g.fillText(ad.slice(0, 9), 12 - f * 3, 9);
          break;
        }
        default: { // a level meter climbing and falling
          for (let b = 0; b < 8; b++) {
            const on = ((b + f) % 8) < 5;
            g.fillStyle = on ? adCols[(v + b) % adCols.length] : "#141821";
            g.fillRect(1 + b * 3, AD_H - 2 - (b % 4) * 2 - (on ? 4 : 0), 2, 3 + (b % 4) * 2);
          }
          g.fillStyle = col;
          g.font = "bold 5px monospace";
          g.fillText(ad.slice(0, 8), 1, 5);
          break;
        }
      }
      // scanlines
      g.fillStyle = "rgba(0,0,0,0.28)";
      for (let y = 0; y < AD_H; y += 2) g.fillRect(0, y, AD_W, 1);
      frames.push(c);
    }
    ads.push(frames);
  }

  // ---- the big ones: advertisement walls three storeys tall and two wide,
  // animated like the small panels but at a scale you see from down the street
  const MW_W = 48, MW_H = 52;
  const megawalls: HTMLCanvasElement[][] = [];
  for (let v = 0; v < 6; v++) {
    const frames: HTMLCanvasElement[] = [];
    const a1 = adCols[(v * 3) % adCols.length];
    const a2 = adCols[(v * 3 + 5) % adCols.length];
    const name = adTexts[(v * 5) % adTexts.length];
    for (let f = 0; f < 6; f++) {
      const c = makeCanvas(MW_W, MW_H);
      const g = ctx2d(c);
      g.fillStyle = "#05060a";
      g.fillRect(0, 0, MW_W, MW_H);
      switch (v % 3) {
        case 0: {                       // a face on a colour field, blinking
          g.fillStyle = a1; g.fillRect(2, 2, MW_W - 4, MW_H - 16);
          g.fillStyle = "#05060a";
          g.beginPath(); g.arc(MW_W / 2, 20, 13, 0, Math.PI * 2); g.fill();
          g.fillStyle = a2;
          const open = f % 6 !== 4;
          g.fillRect(MW_W / 2 - 8, open ? 16 : 18, 5, open ? 3 : 1);
          g.fillRect(MW_W / 2 + 3, open ? 16 : 18, 5, open ? 3 : 1);
          break;
        }
        case 1: {                       // a skyline with searchlights sweeping
          g.fillStyle = a2; g.fillRect(2, 2, MW_W - 4, MW_H - 16);
          g.fillStyle = "#05060a";
          for (let b = 0; b < 8; b++) g.fillRect(3 + b * 6, 14 + ((b * 5 + v) % 14), 5, 30);
          g.strokeStyle = a1; g.lineWidth = 2; g.globalAlpha = 0.8;
          g.beginPath();
          g.moveTo(6 + f * 7, MW_H - 16); g.lineTo(20 + f * 4, 4);
          g.stroke();
          g.globalAlpha = 1; g.lineWidth = 1;
          break;
        }
        default: {                      // a grid of tiles flipping over
          for (let gy = 0; gy < 6; gy++) for (let gx = 0; gx < 6; gx++) {
            const on = ((gx * 3 + gy * 5 + f * 7) % 11) < 5;
            g.fillStyle = on ? a1 : a2;
            g.fillRect(3 + gx * 7.4, 3 + gy * 5.4, 6.4, 4.4);
          }
          break;
        }
      }
      // the brand plate along the bottom, the same on every frame
      g.fillStyle = "#05060a"; g.fillRect(2, MW_H - 14, MW_W - 4, 12);
      g.fillStyle = a1;
      g.font = "bold 9px monospace"; g.textAlign = "center";
      g.fillText(name.slice(0, 10), MW_W / 2, MW_H - 5);
      g.textAlign = "left";
      g.strokeStyle = "rgba(0,0,0,0.55)"; g.strokeRect(0.5, 0.5, MW_W - 1, MW_H - 1);
      g.fillStyle = "rgba(0,0,0,0.22)";
      for (let y = 0; y < MW_H; y += 3) g.fillRect(0, y, MW_W, 1);
      if (!night) { g.fillStyle = "rgba(0,0,0,0.12)"; g.fillRect(0, 0, MW_W, MW_H); }
      frames.push(c);
    }
    megawalls.push(frames);
  }

  // ---- neon signs ----
  const neonTexts = [
    "BAR", "GUNS", "HOTEL", "CLUB", "XXX", "NOODLE", "CLINIC", "PAWN",
    "SAKE", "MOTEL", "TATTOO", "LOANS", "KARAOKE", "DINER", "CHEMS", "ARCADE",
    "ODEON", "BATHS", "GRILL", "CHOP", "DICE", "VAULT", "SALON", "TAXI",
    "OYSTER", "RELAY", "MOTH", "AMP", "KIOSK", "LOTUS", "STEAM", "ORBIT",
  ];
  const neons: HTMLCanvasElement[] = [];
  for (let v = 0; v < 32; v++) {
    const c = makeCanvas(26, 10);
    const g = ctx2d(c);
    const col = adCols[(v + 3) % adCols.length];
    const name = neonTexts[v % neonTexts.length];
    g.shadowColor = col;
    g.shadowBlur = night ? 5 : 2;
    g.strokeStyle = col;
    g.fillStyle = col;
    g.lineWidth = 1;
    switch (v % 4) {
      case 0:                                   // boxed
        g.strokeRect(1.5, 1.5, 23, 7);
        break;
      case 1:                                   // a lozenge
        g.beginPath();
        g.ellipse(13, 5, 11.5, 4, 0, 0, Math.PI * 2);
        g.stroke();
        break;
      case 2:                                   // underscored, with a tick
        g.beginPath();
        g.moveTo(2, 8.5); g.lineTo(24, 8.5);
        g.moveTo(24, 8.5); g.lineTo(24, 4);
        g.stroke();
        break;
      default:                                  // an arrow pointing the way in
        g.beginPath();
        g.moveTo(2, 1.5); g.lineTo(20, 1.5); g.lineTo(24.5, 5); g.lineTo(20, 8.5); g.lineTo(2, 8.5);
        g.closePath();
        g.stroke();
        break;
    }
    g.font = "bold 6px monospace";
    g.fillText(name.slice(0, 7), 3, 7);
    neons.push(c);
  }

  // ---- zebra crossings: bars run parallel to the traffic they interrupt ----
  const mkCross = (alongY: boolean): HTMLCanvasElement => {
    const c = makeCanvas(TILE_W, TILE_H);
    const g = ctx2d(c);
    g.drawImage(road, 0, 0);
    g.save();
    // unit tile space -> the iso diamond
    g.transform(TILE_W / 2, TILE_H / 2, -TILE_W / 2, TILE_H / 2, TILE_W / 2, 0);
    g.fillStyle = tint("#d8d8cc", ambient, blue);
    for (const s of [0.08, 0.33, 0.58, 0.83]) {
      if (alongY) g.fillRect(s, 0, 0.13, 1);
      else g.fillRect(0, s, 1, 0.13);
    }
    g.restore();
    return c;
  };
  const crossV = mkCross(true);
  const crossH = mkCross(false);

  // ---- big facade billboards (24 x 26, spans two storeys) ----
  const BB_W = 24, BB_H = 26;
  const bbTexts = [
    "EUROCORP", "ZEN-X", "NEW YOU", "SYNTH", "OBEY", "V-COLA", "ARM+", "DREAM",
    "HALCYON", "MIRRORS", "NULL CO", "SAFE-T", "ELYSIA", "GENE-9", "OUTLOOK", "VELVET",
    "MERIDIAN", "PALE SUN", "CIVIX", "AURA", "TITAN OIL", "SOFT WAR", "KIN", "LATTICE",
    "ORPHEUS", "DUSTLINE", "HOLLOW", "PRIME CUT", "NOVA MED", "BRASS", "QUIET", "SIGNAL",
  ];
  const billboards: HTMLCanvasElement[] = [];
  for (let v = 0; v < 32; v++) {
    const c = makeCanvas(BB_W, BB_H);
    const g = ctx2d(c);
    const a1 = adCols[v % adCols.length];
    const a2 = adCols[(v + 3) % adCols.length];
    g.fillStyle = "#0a0b10";
    g.fillRect(0, 0, BB_W, BB_H);
    switch (v % 8) {
      case 0: // colour field with a headline
        g.fillStyle = a1; g.fillRect(1, 1, BB_W - 2, BB_H - 2);
        g.fillStyle = "#0a0b10"; g.fillRect(2, BB_H - 11, BB_W - 4, 9);
        g.fillStyle = a1; g.font = "bold 6px monospace"; g.textAlign = "center";
        g.fillText(bbTexts[v % bbTexts.length], BB_W / 2, BB_H - 4);
        break;
      case 1: { // portrait silhouette
        g.fillStyle = a2; g.fillRect(1, 1, BB_W - 2, BB_H - 2);
        g.fillStyle = "#0a0b10";
        g.beginPath(); g.arc(BB_W / 2, 11, 6, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.ellipse(BB_W / 2, 25, 10, 8, 0, Math.PI, 0); g.fill();
        g.fillStyle = "#0a0b10"; g.fillRect(1, BB_H - 8, BB_W - 2, 7);
        g.fillStyle = a1; g.font = "bold 5px monospace"; g.textAlign = "center";
        g.fillText(bbTexts[v % bbTexts.length], BB_W / 2, BB_H - 2.5);
        break;
      }
      case 2: // diagonal split
        g.fillStyle = a1; g.fillRect(1, 1, BB_W - 2, BB_H - 2);
        g.fillStyle = a2;
        g.beginPath(); g.moveTo(1, BB_H - 1); g.lineTo(BB_W - 1, 1); g.lineTo(BB_W - 1, BB_H - 1); g.closePath(); g.fill();
        g.fillStyle = "#0a0b10"; g.font = "bold 6px monospace"; g.textAlign = "center";
        g.fillText(bbTexts[v % bbTexts.length], BB_W / 2, BB_H / 2 + 2);
        break;
      case 3: { // a horizon band with a sun over it
        g.fillStyle = a2; g.fillRect(1, 1, BB_W - 2, BB_H - 2);
        g.fillStyle = a1;
        g.beginPath(); g.arc(BB_W / 2, 12, 7, 0, Math.PI * 2); g.fill();
        g.fillStyle = a2;
        for (let k = 0; k < 4; k++) g.fillRect(2, 9 + k * 3, BB_W - 4, 1.4);
        g.fillStyle = "#0a0b10"; g.fillRect(1, BB_H - 9, BB_W - 2, 8);
        g.fillStyle = a1; g.font = "bold 6px monospace"; g.textAlign = "center";
        g.fillText(bbTexts[v % bbTexts.length], BB_W / 2, BB_H - 3);
        break;
      }
      case 4: { // stacked type, no image at all
        g.fillStyle = "#0a0b10"; g.fillRect(1, 1, BB_W - 2, BB_H - 2);
        g.strokeStyle = a1; g.strokeRect(2.5, 2.5, BB_W - 5, BB_H - 5);
        g.fillStyle = a1; g.font = "bold 7px monospace"; g.textAlign = "center";
        const w = bbTexts[v % bbTexts.length].split(/[ -]/);
        g.fillText(w[0].slice(0, 7), BB_W / 2, 12);
        g.fillStyle = a2; g.font = "bold 5px monospace";
        g.fillText((w[1] ?? "NOW").slice(0, 8), BB_W / 2, 20);
        break;
      }
      case 5: { // a bottle silhouette
        g.fillStyle = a1; g.fillRect(1, 1, BB_W - 2, BB_H - 2);
        g.fillStyle = "#0a0b10";
        g.fillRect(BB_W / 2 - 2, 3, 4, 5);
        g.fillRect(BB_W / 2 - 5, 8, 10, 12);
        g.fillStyle = a2; g.fillRect(BB_W / 2 - 4, 12, 8, 4);
        g.fillStyle = "#0a0b10"; g.fillRect(1, BB_H - 8, BB_W - 2, 7);
        g.fillStyle = a1; g.font = "bold 5px monospace"; g.textAlign = "center";
        g.fillText(bbTexts[v % bbTexts.length], BB_W / 2, BB_H - 2.5);
        break;
      }
      case 6: { // chevrons marching up the board
        g.fillStyle = "#0a0b10"; g.fillRect(1, 1, BB_W - 2, BB_H - 2);
        for (let k = 0; k < 5; k++) {
          g.strokeStyle = k % 2 === 0 ? a1 : a2;
          g.lineWidth = 2;
          g.beginPath();
          g.moveTo(3, BB_H - 4 - k * 4); g.lineTo(BB_W / 2, BB_H - 8 - k * 4); g.lineTo(BB_W - 3, BB_H - 4 - k * 4);
          g.stroke();
        }
        g.lineWidth = 1;
        g.fillStyle = a1; g.font = "bold 6px monospace"; g.textAlign = "center";
        g.fillText(bbTexts[v % bbTexts.length].slice(0, 8), BB_W / 2, 7);
        break;
      }
      default: { // product block with a data grid
        g.fillStyle = a2; g.fillRect(1, 1, BB_W - 2, BB_H - 2);
        g.fillStyle = "#0a0b10";
        for (let gy = 0; gy < 4; gy++) for (let gx = 0; gx < 5; gx++) {
          if ((gx + gy + v) % 3 === 0) g.fillRect(3 + gx * 4, 3 + gy * 4, 3, 3);
        }
        g.fillStyle = "#0a0b10"; g.fillRect(1, BB_H - 9, BB_W - 2, 8);
        g.fillStyle = a1; g.font = "bold 6px monospace"; g.textAlign = "center";
        g.fillText(bbTexts[v % bbTexts.length], BB_W / 2, BB_H - 3);
        break;
      }
    }
    g.textAlign = "left";
    g.strokeStyle = "rgba(0,0,0,0.6)";
    g.strokeRect(0.5, 0.5, BB_W - 1, BB_H - 1);
    if (!night) { g.fillStyle = "rgba(0,0,0,0.12)"; g.fillRect(0, 0, BB_W, BB_H); }
    billboards.push(c);
  }

  // ---- shop windows: 24 designs - three sign styles x four shopfronts,
  // each with its own trade name and neon colour (24 x 22) ----
  const SH_W = 24, SH_H = 22;
  const shopNames = ["RAMEN", "TECH", "AMMO", "MEDS", "BAR", "CHIP", "WEAR", "CASH",
                     "SUSHI", "INK", "PAWN", "CLINIC", "VR", "GRILL", "PARTS", "SOY",
                     "NOIR", "CYBER", "TEA", "ARMS", "LOAN", "DYE", "FUEL", "MASK",
                     "BAO", "OPTIC", "SCRAP", "BREW", "KELP", "WIRE", "SALT", "GLASS",
                     "FERRY", "CROW", "ASH", "PLUM", "RIVET", "MOSS", "COIN", "PIPE",
                     "LANTERN", "CINDER", "HUSK", "TALLOW", "SPINE", "QUILL", "ONYX", "FLINT"];
  const shops: HTMLCanvasElement[] = [];
  for (let v = 0; v < 96; v++) {
    const c = makeCanvas(SH_W, SH_H);
    const g = ctx2d(c);
    const sign = adCols[(v + 5) % adCols.length];
    const signStyle = v % 6;
    const winStyle = Math.floor(v / 6) % 4;
    const name = shopNames[v % shopNames.length];
    const frame = tint("#20242c", ambient, blue);
    const trim = tint("#3a3f47", ambient, blue);
    const glow = night ? "#ffe9b0" : "#cfe4ee";

    // --- sign board ---
    g.shadowColor = sign;
    g.shadowBlur = night ? 4 : 0;
    g.strokeStyle = sign;
    g.fillStyle = sign;
    g.lineWidth = 1;
    if (signStyle === 3) {            // a pair of stacked bars
      g.fillRect(1, 1, SH_W - 2, 2);
      g.strokeRect(1.5, 4.5, SH_W - 3, 4);
      g.font = "bold 4px monospace"; g.textAlign = "center";
      g.fillText(name.slice(0, 9), SH_W / 2, 8);
    } else if (signStyle === 4) {     // a hanging blade sign
      g.strokeRect(2.5, 0.5, 5, 11);
      g.beginPath(); g.moveTo(7.5, 3); g.lineTo(SH_W - 2, 3); g.stroke();
      g.font = "bold 4px monospace"; g.textAlign = "left";
      g.fillText(name.slice(0, 6), 9, 8);
    } else if (signStyle === 5) {     // a bare tube over the glass
      g.beginPath(); g.moveTo(2, 3.5); g.lineTo(SH_W - 2, 3.5); g.stroke();
      g.font = "bold 5px monospace"; g.textAlign = "center";
      g.fillText(name.slice(0, 7), SH_W / 2, 9);
    } else if (signStyle === 0) {     // boxed fascia
      g.strokeRect(1.5, 1.5, SH_W - 3, 7);
      g.font = "bold 5px monospace"; g.textAlign = "center";
      g.fillText(name.slice(0, 7), SH_W / 2, 7);
    } else if (signStyle === 1) {     // rounded lozenge
      g.beginPath();
      g.ellipse(SH_W / 2, 5, SH_W / 2 - 2, 4.2, 0, 0, Math.PI * 2);
      g.stroke();
      g.font = "bold 5px monospace"; g.textAlign = "center";
      g.fillText(name.slice(0, 6), SH_W / 2, 7);
    } else {                          // vertical banner down one side
      g.strokeRect(SH_W - 7.5, 1.5, 6, SH_H - 5);
      g.font = "bold 4px monospace"; g.textAlign = "center";
      for (let k = 0; k < Math.min(4, name.length); k++) g.fillText(name[k], SH_W - 4.5, 6 + k * 4.2);
    }
    g.textAlign = "left";
    g.shadowBlur = 0;

    // --- shopfront ---
    const wx = 1, ww = signStyle === 2 ? SH_W - 9 : SH_W - 2;
    const wy = signStyle === 2 ? 2 : 10;
    const wh = SH_H - wy - 2;
    g.fillStyle = frame;
    g.fillRect(wx - 1, wy - 1, ww + 2, wh + 2);
    if (winStyle === 2) {             // roller shutter, shop closed
      g.fillStyle = tint("#4a4e57", ambient, blue);
      g.fillRect(wx, wy, ww, wh);
      g.fillStyle = tint("#33373f", ambient, blue);
      for (let ly = wy + 1; ly < wy + wh; ly += 3) g.fillRect(wx, ly, ww, 1);
      g.fillStyle = sign;             // small tag light stays on
      g.fillRect(wx + 1, wy + wh - 3, 2, 2);
    } else {
      g.fillStyle = glow;
      g.fillRect(wx, wy, ww, wh);
      g.fillStyle = "rgba(20,22,30,0.85)";
      if (winStyle === 0) {           // goods on a shelf
        for (let k = 0; k < 3; k++) {
          const gw = 3 + ((v + k) % 3);
          g.fillRect(wx + 2 + k * 6, wy + wh - 1 - gw, gw, gw);
        }
      } else if (winStyle === 1) {    // split panes with a hanging item
        g.fillRect(wx + ww / 2 - 0.5, wy, 1, wh);
        g.fillRect(wx + 3, wy + 1, 3, 5);
        g.fillRect(wx + ww - 7, wy + 2, 4, 4);
      } else {                        // open counter with produce
        g.fillRect(wx, wy + wh - 4, ww, 4);
        for (let k = 0; k < 4; k++) {
          g.fillStyle = k % 2 ? tint("#c0623a", ambient, blue) : tint("#3a8a5a", ambient, blue);
          g.fillRect(wx + 1 + k * 5, wy + wh - 6, 3, 2);
        }
      }
      g.fillStyle = "rgba(255,255,255,0.16)";  // glass reflection
      g.fillRect(wx, wy, ww, 2);
    }
    // awning on half the designs
    if (v % 2 === 0 && signStyle !== 2) {
      for (let k = 0; k < 6; k++) {
        g.fillStyle = k % 2 ? sign : tint("#e8e2d8", ambient, blue);
        g.fillRect(wx + k * 4, wy - 2, 4, 2);
      }
    }
    g.fillStyle = trim;
    g.fillRect(0, SH_H - 3, SH_W, 3);        // sill
    shops.push(c);
  }

  const trees = buildTreeArt(seed, ambient, blue, night);
  const benches = buildBenchArt(ambient, blue);
  const stalls = buildStallArt(ambient, blue, night);

  return {
    weather, ground, sidewalk, road, roadDashV, roadDashH, roadPuddle,
    park, island, block, pitFloor, pitWallNW, pitWallNE, lamp, ads, neons, megawalls,
    billboards, shops, trees, benches, stalls, crossV, crossH,
    cutCap: tint("#7c818c", ambient, blue),
    cutFloor: tint("#31343d", ambient, blue),
    adColors: adCols, ambient, night,
  };
}
