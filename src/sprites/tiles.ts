// Procedural tile art: ground tiles, extruded building blocks with windows,
// animated ad videowalls and neon signs. Everything is baked per-weather.

import { Rng } from "../engine/rng";
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

  // ---- street lamp ----
  const lamp = makeCanvas(16, 40);
  {
    const g = ctx2d(lamp);
    g.fillStyle = tint("#3a3a44", ambient + 0.2, blue);
    g.fillRect(7, 8, 2, 30);
    g.fillRect(7, 6, 8, 2);
    if (night) {
      g.fillStyle = "#ffe9a8";
      g.fillRect(13, 8, 3, 2);
      const grad = g.createRadialGradient(14, 9, 1, 14, 9, 9);
      grad.addColorStop(0, "rgba(255,230,160,0.5)");
      grad.addColorStop(1, "rgba(255,230,160,0)");
      g.fillStyle = grad;
      g.fillRect(5, 0, 18, 18);
    } else {
      g.fillStyle = "#c8c8d0";
      g.fillRect(13, 8, 3, 2);
    }
  }

  // ---- animated ad videowalls (8 designs x 4 frames, 24x14) ----
  const AD_W = 24, AD_H = 14;
  const ads: HTMLCanvasElement[][] = [];
  const adTexts = ["SYND CORP", "GRID CAB", "RAMEN 24H", "SOMA+", "OBEY", "VOLT BAR", "NEO AIR", "EYE-X"];
  const adCols = ["#25e0ff", "#ffe32f", "#ff7a1f", "#7dff3f", "#ff2fa0", "#b06bff", "#8fe8ff", "#ff4d6d"];
  for (let v = 0; v < 8; v++) {
    const frames: HTMLCanvasElement[] = [];
    for (let f = 0; f < 4; f++) {
      const c = makeCanvas(AD_W, AD_H);
      const g = ctx2d(c);
      g.fillStyle = "#06070c";
      g.fillRect(0, 0, AD_W, AD_H);
      const col = adCols[v];
      switch (v % 4) {
        case 0: { // scrolling text
          g.fillStyle = col;
          g.font = "bold 7px monospace";
          const t = adTexts[v] + "  " + adTexts[v];
          g.fillText(t, 2 - f * 6, 9);
          break;
        }
        case 1: { // blinking brand
          if (f !== 3) {
            g.fillStyle = col;
            g.font = "bold 6px monospace";
            g.fillText(adTexts[v].slice(0, 8), 1, 9);
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
          g.fillText(adTexts[v].slice(0, 6), 2, 8 + (f % 2));
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

  // ---- neon signs ----
  const neonTexts = ["BAR", "GUNS", "HOTEL", "CLUB", "XXX", "NOODLE", "CLINIC", "PAWN"];
  const neons: HTMLCanvasElement[] = [];
  for (let v = 0; v < 8; v++) {
    const c = makeCanvas(26, 10);
    const g = ctx2d(c);
    const col = adCols[(v + 3) % adCols.length];
    g.shadowColor = col;
    g.shadowBlur = night ? 5 : 2;
    g.strokeStyle = col;
    g.strokeRect(1.5, 1.5, 23, 7);
    g.fillStyle = col;
    g.font = "bold 6px monospace";
    g.fillText(neonTexts[v], 3, 7);
    neons.push(c);
  }

  return {
    weather, ground, sidewalk, road, roadDashV, roadDashH, roadPuddle,
    park, island, block, pitFloor, pitWallNW, pitWallNE, lamp, ads, neons, ambient, night,
  };
}
