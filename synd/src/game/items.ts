// Item and weapon definitions.

export type ItemType =
  | "gun" | "uzi" | "minigun" | "shotgun" | "laser" | "gauss"
  | "shield" | "medkit" | "persuadertron";

export interface ItemDef {
  type: ItemType;
  name: string;
  short: string;          // label on inventory slot
  weapon: boolean;        // fires projectiles
  charge: number;         // shots for weapons, energy units otherwise
  damage: number;
  range: number;          // tiles
  cooldown: number;       // seconds between shots
  pellets: number;        // projectiles per trigger pull
  spread: number;         // radians of inaccuracy
  speed: number;          // projectile speed, tiles/sec (0 = hitscan beam)
  price: number;          // armory price in credits
  color: string;          // projectile / slot accent color
}

export const ITEMS: Record<ItemType, ItemDef> = {
  gun:           { type: "gun",           name: "PISTOL",        short: "GUN",  weapon: true,  charge: 40,  damage: 26, range: 9,  cooldown: 0.42, pellets: 1, spread: 0.05, speed: 26, price: 150,  color: "#ffd27a" },
  uzi:           { type: "uzi",           name: "UZI",           short: "UZI",  weapon: true,  charge: 90,  damage: 14, range: 10, cooldown: 0.09, pellets: 1, spread: 0.13, speed: 28, price: 450,  color: "#ffe9a0" },
  shotgun:       { type: "shotgun",       name: "SHOTGUN",       short: "SHTG", weapon: true,  charge: 24,  damage: 16, range: 6,  cooldown: 0.75, pellets: 5, spread: 0.36, speed: 22, price: 550,  color: "#ffb36b" },
  minigun:       { type: "minigun",       name: "MINIGUN",       short: "MINI", weapon: true,  charge: 220, damage: 12, range: 11, cooldown: 0.05, pellets: 1, spread: 0.16, speed: 30, price: 1800, color: "#fff2c8" },
  laser:         { type: "laser",         name: "LASER",         short: "LASR", weapon: true,  charge: 30,  damage: 70, range: 14, cooldown: 0.6,  pellets: 1, spread: 0.0,  speed: 0,  price: 2600, color: "#ff4d6d" },
  gauss:         { type: "gauss",         name: "GAUSS GUN",     short: "GAUS", weapon: true,  charge: 5,   damage: 400, range: 13, cooldown: 1.4, pellets: 1, spread: 0.0,  speed: 18, price: 4200, color: "#7ad7ff" },
  shield:        { type: "shield",        name: "SHIELD BELT",   short: "SHLD", weapon: false, charge: 100, damage: 0,  range: 0,  cooldown: 0,    pellets: 0, spread: 0,    speed: 0,  price: 1200, color: "#7affc8" },
  medkit:        { type: "medkit",        name: "MEDKIT",        short: "MED",  weapon: false, charge: 2,   damage: 0,  range: 0,  cooldown: 0,    pellets: 0, spread: 0,    speed: 0,  price: 300,  color: "#8cff7a" },
  persuadertron: { type: "persuadertron", name: "PERSUADERTRON", short: "PSDR", weapon: false, charge: 100, damage: 0,  range: 3.2, cooldown: 0,   pellets: 0, spread: 0,    speed: 0,  price: 900,  color: "#d98cff" },
};

export interface ItemStack {
  type: ItemType;
  charge: number; // remaining charge; weapon with 0 charge is useless
}

export function newItem(type: ItemType): ItemStack {
  return { type, charge: ITEMS[type].charge };
}

// What the armory pays for an item. A fully spent one fetches half of what a
// loaded one does, and anything in between scales with the charge remaining.
export const SELL_RATE = 0.4;
export function sellValue(it: ItemStack): number {
  const def = ITEMS[it.type];
  const frac = def.charge > 0 ? Math.max(0, Math.min(1, it.charge / def.charge)) : 1;
  return Math.floor(def.price * SELL_RATE * (0.5 + 0.5 * frac));
}

// Rough sustained damage per second, used to rank weapons when an agent's
// current gun runs dry and has to be swapped for the next best one.
export function weaponDps(t: ItemType): number {
  const d = ITEMS[t];
  if (!d.weapon) return -1;
  return (d.damage * Math.max(1, d.pellets)) / Math.max(0.05, d.cooldown);
}

// Loot tables. Cops normally drop a gun, small chance of something else.
// Enemy agents have a higher chance to drop any item.
export function copDrop(r: () => number): ItemType | null {
  const x = r();
  if (x < 0.62) return "gun";
  if (x < 0.70) return "uzi";
  if (x < 0.74) return "shotgun";
  if (x < 0.77) return "medkit";
  if (x < 0.79) return "shield";
  return null;
}
export function enemyDrop(r: () => number): ItemType | null {
  const x = r();
  if (x < 0.30) return "uzi";
  if (x < 0.42) return "gun";
  if (x < 0.52) return "shotgun";
  if (x < 0.62) return "minigun";
  if (x < 0.70) return "laser";
  if (x < 0.74) return "gauss";
  if (x < 0.82) return "shield";
  if (x < 0.90) return "medkit";
  return null;
}
