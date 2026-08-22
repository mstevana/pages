// Campaign persistence in localStorage.

import { ItemStack, newItem } from "./items";

export interface SaveAgent {
  name: string;
  alive: boolean;
  hp: number;         // carried between missions (0..100)
  inv: ItemStack[];   // up to 8
}

export interface SaveData {
  version: number;
  mission: number;    // 1-based mission counter
  credits: number;
  kills: number;
  agents: SaveAgent[];
}

const KEY = "synd.save.v1";
const NAMES = [
  "MARIN", "VOSS", "KYRO", "TANE", "REZA", "OKUDA", "SABLE", "DRAX",
  "NYX", "HALE", "IVANO", "CROSS", "MIRA", "JET", "KANE", "ONYX",
];

export function newAgentName(taken: string[]): string {
  for (const n of NAMES) if (!taken.includes(n)) return n;
  return "AGT-" + Math.floor(Math.random() * 900 + 100);
}

export function newCampaign(): SaveData {
  const agents: SaveAgent[] = [];
  for (let i = 0; i < 4; i++) {
    agents.push({
      name: NAMES[i],
      alive: true,
      hp: 100,
      inv: [newItem("gun")],
    });
  }
  return { version: 1, mission: 1, credits: 0, kills: 0, agents };
}

export function loadSave(): SaveData | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as SaveData;
    if (!d || d.version !== 1 || !Array.isArray(d.agents)) return null;
    return d;
  } catch {
    return null;
  }
}

export function writeSave(d: SaveData): void {
  try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* private mode */ }
}

export function clearSave(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
