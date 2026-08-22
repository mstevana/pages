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
  blocks: HTMLCanvasElement[][]; // [stories][variant]
  lamp: HTMLCanvasElement;
  ads: HTMLCanvasElement[][];    // [variant][frame]
  neons: HTMLCanvasElement[];
  ambient: number;               // 0..1 light level
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

  // ---- building blocks ----
  const wallHues = ["#4c4650", "#3e4450", "#514a42", "#45505a", "#3c3c46"];
  const litCols = ["#ffd76a", "#8fe8ff", "#ff9ec8", "#c0ffa0"];
  const blocks: HTMLCanvasElement[][] = [];
  for (let stories = 1; stories <= 12; stories++) {
    const variants: HTMLCanvasElement[] = [];
    for (let v = 0; v < 3; v++) {
      const H = stories * STORY_H;
      const c = makeCanvas(TILE_W, TILE_H + H);
      const g = ctx2d(c);
      const hue = wallHues[stories % wallHues.length]; // same hue for all variants: uniform roofs per building
      const wallSW = tint(hue, ambient * 0.55, blue);
      const wallSE = tint(hue, ambient * 0.8, blue);
      const roofC = tint(hue, ambient * 0.5, blue);

      // SW face
      g.fillStyle = wallSW;
      g.beginPath();
      g.moveTo(0, TILE_H / 2); g.lineTo(TILE_W / 2, TILE_H);
      g.lineTo(TILE_W / 2, TILE_H + H); g.lineTo(0, TILE_H / 2 + H);
      g.closePath(); g.fill();
      // SE face
      g.fillStyle = wallSE;
      g.beginPath();
      g.moveTo(TILE_W / 2, TILE_H); g.lineTo(TILE_W, TILE_H / 2);
      g.lineTo(TILE_W, TILE_H / 2 + H); g.lineTo(TILE_W / 2, TILE_H + H);
      g.closePath(); g.fill();
      // windows per story
      for (let s = 0; s < stories; s++) {
        for (let wx = 0; wx < 3; wx++) {
          // SW face: top edge slopes +0.5 from x=0..16
          const x1 = 2 + wx * 5;
          const y1 = TILE_H / 2 + x1 * 0.5 + s * STORY_H + 4;
          const lit1 = night ? r.chance(0.55) : false;
          g.fillStyle = lit1 ? litCols[r.int(0, litCols.length - 1)] : tint("#1a2230", ambient + 0.15, blue);
          g.fillRect(x1, y1, 2, 4);
          // SE face: top edge slopes -0.5 from x=16..32
          const x2 = TILE_W / 2 + 3 + wx * 5;
          const y2 = TILE_H - (x2 - TILE_W / 2) * 0.5 + s * STORY_H + 4;
          const lit2 = night ? r.chance(0.55) : false;
          g.fillStyle = lit2 ? litCols[r.int(0, litCols.length - 1)] : tint("#1c2836", ambient + 0.18, blue);
          g.fillRect(x2, y2, 2, 4);
        }
      }
      // roof
      diamond(g, roofC);
      g.strokeStyle = tint(hue, ambient * 0.9, blue);
      g.beginPath();
      g.moveTo(0, TILE_H / 2); g.lineTo(TILE_W / 2, TILE_H); g.lineTo(TILE_W, TILE_H / 2);
      g.stroke();
      variants.push(c);
    }
    blocks.push(variants);
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
    park, island, blocks, lamp, ads, neons, ambient,
  };
}
