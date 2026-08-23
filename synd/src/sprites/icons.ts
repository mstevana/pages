// Pixel-art icons for items lying on the ground, one distinctive design per
// type. Built once, lazily, into 16x16 canvases.
//
// Legend: '.' transparent  K outline  D dark metal  M mid metal  L light metal
//         G grip  A item accent  B bright accent  W white  R red

import { ITEMS, ItemType } from "../game/items";
import { ctx2d, makeCanvas } from "../engine/util";

const SZ = 16;

const ART: Record<ItemType, string[]> = {
  gun: [
    "................",
    "................",
    "................",
    "..KKKKKKKKKK....",
    "..KLLLLLLLLK....",
    "..KMMMMMMMMKK...",
    "..KKKKDMKKKKK...",
    "..KGKK.KK.......",
    "..KGGK..........",
    "..KGGK..........",
    "..KGGGK.........",
    "..KKKKK.........",
    "................",
    "................",
    "................",
    "................",
  ],
  uzi: [
    "................",
    "................",
    "......KK........",
    ".....KKKK.......",
    "..KKKKKKKKKKK...",
    "..KMMMMMMMMMLK..",
    "..KMMMMMMMMMLK..",
    "..KKKKDDKKKKKK..",
    "....KGGK........",
    "....KGGK........",
    "....KAAK........",
    "....KAAK........",
    "....KKKK........",
    "................",
    "................",
    "................",
  ],
  shotgun: [
    "................",
    "................",
    "................",
    "...KKKKKKKKKKKK.",
    "...KLLLLLLLLLLK.",
    "...KKKKKKKKKKKK.",
    ".KKKMMMMMMMMMMK.",
    ".KGGKKKKKKKKKKK.",
    ".KGGGK..........",
    ".KKGGGK.........",
    "..KKKKK.........",
    "................",
    "................",
    "................",
    "................",
    "................",
  ],
  minigun: [
    "................",
    "................",
    ".....KKKKKKKKKK.",
    ".....KLLLLLLLLK.",
    "..KKKKKKKKKKKKK.",
    "..KDDKMMMMMMMMK.",
    "..KDDKKKKKKKKKK.",
    "..KDDKLLLLLLLLK.",
    "..KDDKKKKKKKKKK.",
    "..KDDKMMMMMMMMK.",
    "..KKKKKKKKKKKKK.",
    "...KAAK.........",
    "...KKKK.........",
    "................",
    "................",
    "................",
  ],
  laser: [
    "................",
    "................",
    "................",
    "...KKKKKKKKK....",
    "...KDDDDDDDKK...",
    "...KDBBBBBDBAK..",
    "...KDDDDDDDKK...",
    "...KKKKKKKKK....",
    "....KGGK........",
    "....KGGK........",
    "....KKKK........",
    "................",
    "................",
    "................",
    "................",
    "................",
  ],
  gauss: [
    "................",
    "................",
    "................",
    "..KKKKKKKKKKKK..",
    "..KMMAMMAMMAMLK.",
    "..KMMAMMAMMAMLK.",
    "..KKKKKKKKKKKK..",
    "...KGGK.........",
    "...KGGK.........",
    "...KKKK.........",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ],
  shield: [
    "................",
    "....KKKKKKKK....",
    "...KAAAAAAAAK...",
    "...KABBBBBBAK...",
    "...KABBBBBBAK...",
    "...KAAAAAAAAK...",
    "...KAAAAAAAAK...",
    "....KAAAAAAK....",
    ".....KAAAAK.....",
    "......KAAK......",
    ".......KK.......",
    "................",
    "................",
    "................",
    "................",
    "................",
  ],
  medkit: [
    "................",
    "......KKK.......",
    "....KKKKKKKK....",
    "....KWWWWWWK....",
    "....KWWRRWWK....",
    "....KWRRRRWK....",
    "....KWRRRRWK....",
    "....KWWRRWWK....",
    "....KWWWWWWK....",
    "....KKKKKKKK....",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ],
  persuadertron: [
    "................",
    ".......A........",
    "....A..A..A.....",
    ".....KKKKKK.....",
    "....KAAAAAAK....",
    "....KABBBBAK....",
    ".....KAAAAK.....",
    "......KKKK......",
    "......KDDK......",
    ".....KKDDKK.....",
    ".....KMMMMK.....",
    ".....KMAAMK.....",
    ".....KMMMMK.....",
    ".....KKKKKK.....",
    "................",
    "................",
  ],
};

function lighten(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * f + 40));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * f + 40));
  const b = Math.min(255, Math.round((n & 255) * f + 40));
  return `rgb(${r},${g},${b})`;
}

function build(type: ItemType): HTMLCanvasElement {
  const c = makeCanvas(SZ, SZ);
  const g = ctx2d(c);
  const accent = ITEMS[type].color;
  const pal: Record<string, string> = {
    K: "#0b0d12", D: "#3c434f", M: "#7d8794", L: "#c4cedb",
    G: "#4a3728", A: accent, B: lighten(accent, 1.0), W: "#e8eef5", R: "#c62828",
  };
  const rows = ART[type];
  for (let y = 0; y < SZ; y++) {
    const row = rows[y] ?? "";
    for (let x = 0; x < SZ; x++) {
      const col = pal[row[x] ?? "."];
      if (!col) continue;
      g.fillStyle = col;
      g.fillRect(x, y, 1, 1);
    }
  }
  return c;
}

let cache: Record<ItemType, HTMLCanvasElement> | null = null;

export function itemIcons(): Record<ItemType, HTMLCanvasElement> {
  if (cache) return cache;
  const out = {} as Record<ItemType, HTMLCanvasElement>;
  for (const t of Object.keys(ART) as ItemType[]) out[t] = build(t);
  cache = out;
  return out;
}

export const ICON_SIZE = SZ;

// data-URL variants for the DOM screens (armory, briefing)
let urls: Record<ItemType, string> | null = null;
export function itemIconUrls(): Record<ItemType, string> {
  if (urls) return urls;
  const ic = itemIcons();
  const out = {} as Record<ItemType, string>;
  for (const t of Object.keys(ic) as ItemType[]) out[t] = ic[t].toDataURL();
  urls = out;
  return out;
}
