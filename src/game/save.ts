// Campaign persistence in localStorage.

import { ItemStack, newItem } from "./items";
import { Implants, Project, noImplants } from "./research";

export interface SaveAgent {
  name: string;
  alive: boolean;
  hp: number;         // carried between missions (0..100)
  inv: ItemStack[];   // up to 8
  implants: Implants; // installed marks per body part; die with the agent
}

export interface SaveData {
  version: number;
  mission: number;    // 1-based mission counter
  credits: number;
  kills: number;
  agents: SaveAgent[];
  research: string[]; // ids of delivered nodes
  pending: Project[]; // projects the lab is still working on
}

const KEY = "synd.save.v1";
const NAMES = [
  "MARIN", "VOSS", "KYRO", "TANE", "REZA", "OKUDA", "SABLE", "DRAX",
  "NYX", "HALE", "IVANO", "CROSS", "MIRA", "JET", "KANE", "ONYX",
  "ZHOU", "VEGA", "RASK", "KOLD", "SEVIK", "AMARI", "TOLL", "BRIX",
  "NOVAK", "QUILL", "ASHER", "DELVE", "RIGG", "SOLAI", "VANCE", "KITE",
  "ORLOV", "FANG", "LUCE", "MERO", "SKARN", "TREVI", "ZANE", "WREN",
  "HOLT", "CASS", "DIEGO", "EIKO", "FARO", "GRIM", "HEX", "IRIS",
  "JUNO", "KRAY", "LOME", "MOSS", "NAIRO", "OSEI", "PYRE", "QADIR",
  "ROOK", "STILT", "TARU", "URSA", "VOLK", "XOLA", "YUEN", "ZEPH",
];

// a name nobody on the roster is already using, drawn at random so two
// campaigns rarely field the same squad
export function newAgentName(taken: string[]): string {
  const free = NAMES.filter((n) => !taken.includes(n));
  if (free.length === 0) return "AGT-" + Math.floor(Math.random() * 900 + 100);
  return free[Math.floor(Math.random() * free.length)];
}

export function newCampaign(): SaveData {
  const agents: SaveAgent[] = [];
  const taken: string[] = [];
  for (let i = 0; i < 4; i++) {
    const name = newAgentName(taken);
    taken.push(name);
    agents.push({
      name,
      alive: true,
      hp: 100,
      inv: [newItem("gun")],
      implants: noImplants(),
    });
  }
  return { version: 1, mission: 1, credits: 0, kills: 0, agents, research: [], pending: [] };
}

export function loadSave(): SaveData | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as SaveData;
    if (!d || d.version !== 1 || !Array.isArray(d.agents)) return null;
    // saves from before the lab existed: no tree, no chrome
    if (!Array.isArray(d.research)) d.research = [];
    // saves from before the lab took time: nothing was ever in progress
    if (!Array.isArray(d.pending)) d.pending = [];
    for (const a of d.agents) if (!a.implants) a.implants = noImplants();
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
