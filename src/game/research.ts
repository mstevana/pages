// The research tree and the implant catalogue.
//
// Money buys the work, but not the result: a project is funded in the lab
// between missions and delivers later, gated by the node before it in its
// branch. Nothing is ever in hand before the next mission is over - the cheap
// projects take exactly that long and the expensive ones take three - so the
// lab is a bet on what the squad will need, not a shop. Weapons and kit that
// have not been delivered cannot be bought at the armory (loot is exempt - a
// gun taken off a corpse works no matter whose lab it came from). Implants
// are researched per body part and per mark, then bought and installed on an
// agent; they die with the agent.
//
// A mission pays roughly a thousand to a few thousand credits, so a cheap
// project is about one job's takings and the top of a chain is several.

import { ItemType } from "./items";

export type Branch = "guns" | "tech" | "defense" | "implants";
export type ImplantPart = "legs" | "torso" | "arms" | "eyes";
export const IMPLANT_PARTS: ImplantPart[] = ["legs", "torso", "arms", "eyes"];

// installed marks per body part, 0 = bare
export type Implants = Record<ImplantPart, number>;
export const noImplants = (): Implants => ({ legs: 0, torso: 0, arms: 0, eyes: 0 });

export interface ResearchNode {
  id: string;
  branch: Branch;
  name: string;
  desc: string;
  cost: number;              // credits to fund it
  req: string | null;        // node that must be researched first
  item?: ItemType;           // unlocks this item at the armory
  part?: ImplantPart;        // unlocks this implant mark for purchase
  mark?: number;
}

// Chains, in play order. The pistol is the starter weapon and needs no
// research; everything else earns its place.
export const RESEARCH: ResearchNode[] = [
  // ---- guns: powder and lead, cheap and early ----
  { id: "uzi",      branch: "guns", name: "UZI",         desc: "Machine pistol. Volume of fire over manners.", cost: 1200,  req: null,      item: "uzi" },
  { id: "shotgun",  branch: "guns", name: "SHOTGUN",     desc: "Five pellets a pull. Ends arguments indoors.", cost: 2100,  req: "uzi",     item: "shotgun" },
  { id: "minigun",  branch: "guns", name: "MINIGUN",     desc: "Rotary cannon. The street empties around it.", cost: 5400, req: "shotgun", item: "minigun" },
  // ---- tech weapons: the lab's own line ----
  { id: "laser",    branch: "tech", name: "LASER",       desc: "Hitscan beam, burns through a file of men.",   cost: 6600, req: null,      item: "laser" },
  { id: "gauss",    branch: "tech", name: "GAUSS GUN",   desc: "Hypervelocity slug. One round, one building.", cost: 10800, req: "laser",   item: "gauss" },
  // ---- defense: keeping the squad on its feet ----
  { id: "medkit",   branch: "defense", name: "MEDKIT",        desc: "Field trauma pack, two uses.",            cost: 600,  req: null,     item: "medkit" },
  { id: "shield",   branch: "defense", name: "SHIELD BELT",   desc: "Personal energy screen. Drains as it takes hits.", cost: 2700, req: "medkit", item: "shield" },
  { id: "psdr",     branch: "defense", name: "PERSUADERTRON", desc: "Neural override. Civilians follow you home.", cost: 3300, req: "shield", item: "persuadertron" },
  // ---- guns, second line: quiet, far, and close-in fire ----
  { id: "silenced", branch: "guns", name: "SILENCED PISTOL", desc: "The one gun the street does not hear. No alarm.", cost: 1050,  req: null,       item: "silenced" },
  { id: "rifle",    branch: "guns", name: "LONG RIFLE",      desc: "18-tile reach. Kill before contact.",           cost: 2700,  req: "silenced", item: "rifle" },
  { id: "flamer",   branch: "guns", name: "FLAMER",          desc: "A cone of fire. The street empties screaming.", cost: 3900, req: "rifle",    item: "flamer" },
  // ---- tech, second line: the beam family, built on the laser ----
  { id: "pulse",    branch: "tech", name: "PULSE LASER",     desc: "An automatic laser. Volume over voltage.",      cost: 4800, req: "laser",    item: "pulse" },
  { id: "arc",      branch: "tech", name: "ARC THROWER",     desc: "Lightning that forks to two more victims.",     cost: 7800, req: "pulse",    item: "arc" },
  { id: "lance",    branch: "tech", name: "PLASMA LANCE",    desc: "A wide heavy beam through cars and men alike.", cost: 15000, req: "arc",      item: "lance" },
  // ---- defense, second line: devices and a veil ----
  { id: "bomb",     branch: "defense", name: "TIME BOMB",    desc: "Four-second fuse. Reshapes an ambush.",         cost: 2100,  req: "medkit",   item: "bomb" },
  { id: "gas",      branch: "defense", name: "GAS GRENADE",  desc: "Knockout cloud. Non-lethal, no heat.",          cost: 4200, req: "bomb",     item: "gas" },
  { id: "cloakf",   branch: "defense", name: "CLOAK FIELD",  desc: "Hostiles cannot see you until you fire.",       cost: 7500, req: "gas",      item: "cloak" },
];

// ---- implants: one chain of three marks per body part ----
export interface ImplantMark {
  researchCost: number;      // lab cost to unlock the mark
  price: number;             // hardware cost to install on one agent
  label: string;             // what the mark does, shown on the doll screen
}
export interface ImplantLine {
  part: ImplantPart;
  name: string;
  desc: string;
  marks: [ImplantMark, ImplantMark, ImplantMark];   // MK I..III
}
export const IMPLANTS: Record<ImplantPart, ImplantLine> = {
  legs: { part: "legs", name: "LEG SERVOS", desc: "Faster on foot.",
    marks: [
      { researchCost: 1500,  price: 400,  label: "+15% MOVE" },
      { researchCost: 3000, price: 900,  label: "+30% MOVE" },
      { researchCost: 6000, price: 1800, label: "+50% MOVE" },
    ] },
  torso: { part: "torso", name: "CHEST PLATING", desc: "Harder to kill.",
    marks: [
      { researchCost: 1800,  price: 500,  label: "+50 HP" },
      { researchCost: 3600, price: 1100, label: "+100 HP" },
      { researchCost: 7200, price: 2200, label: "+150 HP" },
    ] },
  arms: { part: "arms", name: "ARM ACTUATORS", desc: "Faster trigger work.",
    marks: [
      { researchCost: 1800,  price: 500,  label: "+18% FIRE RATE" },
      { researchCost: 3600, price: 1100, label: "+54% FIRE RATE" },
      { researchCost: 7200, price: 2200, label: "+100% FIRE RATE" },
    ] },
  eyes: { part: "eyes", name: "TARGETING OPTICS", desc: "Snaps onto a threat sooner.",
    marks: [
      { researchCost: 1500,  price: 400,  label: "-40% REACTION" },
      { researchCost: 3000, price: 900,  label: "-65% REACTION" },
      { researchCost: 6000, price: 1800, label: "-90% REACTION" },
    ] },
};
export const implantNodeId = (part: ImplantPart, mark: number): string => `${part}${mark}`;

// A project in the lab, and how many missions it still owes.
export interface Project { id: string; left: number; total: number; }

// How long a project runs, in missions. Never less than one: whatever is
// funded today is with the squad no earlier than the job after next.
export function researchMissions(cost: number): number {
  return cost >= 6000 ? 3 : cost >= 2000 ? 2 : 1;
}

// every research node, weapons and implants together, keyed by id
export const RESEARCH_ALL: Map<string, ResearchNode> = (() => {
  const m = new Map<string, ResearchNode>();
  for (const n of RESEARCH) m.set(n.id, n);
  for (const part of IMPLANT_PARTS) {
    const line = IMPLANTS[part];
    for (let mk = 1; mk <= 3; mk++) {
      const id = implantNodeId(part, mk);
      m.set(id, {
        id, branch: "implants", name: `${line.name} MK.${"I".repeat(mk)}`,
        desc: `${line.desc} ${line.marks[mk - 1].label}.`,
        cost: line.marks[mk - 1].researchCost,
        req: mk === 1 ? null : implantNodeId(part, mk - 1),
        part, mark: mk,
      });
    }
  }
  return m;
})();

export const isResearched = (research: string[], id: string): boolean => research.includes(id);
export const projectOn = (pending: Project[], id: string): Project | undefined =>
  pending.find((p) => p.id === id);

// A project can be funded when it is neither delivered nor already running,
// and the one before it in the chain is delivered - work in progress does not
// unlock the next rung, or the whole tree could be bought in an afternoon.
export const canResearch = (research: string[], pending: Project[], id: string): boolean => {
  const n = RESEARCH_ALL.get(id);
  if (!n || isResearched(research, id) || projectOn(pending, id)) return false;
  return n.req === null || isResearched(research, n.req);
};

// A mission has been played: every project owes one fewer, and whatever has
// come due is delivered. Returns the ids that landed, for the debrief to say.
export function advanceResearch(research: string[], pending: Project[]): string[] {
  const done: string[] = [];
  for (const p of pending) {
    p.left -= 1;
    if (p.left <= 0) { done.push(p.id); if (!research.includes(p.id)) research.push(p.id); }
  }
  for (let i = pending.length - 1; i >= 0; i--) if (pending[i].left <= 0) pending.splice(i, 1);
  return done;
}

// What the armory may sell. The pistol is standard issue; the rest of the
// market opens as the lab delivers.
export function itemResearched(research: string[], t: ItemType): boolean {
  if (t === "gun") return true;
  for (const n of RESEARCH) if (n.item === t) return isResearched(research, n.id);
  return false;   // mission cargo and anything unlisted is never for sale
}

// ---- what the marks do in the field ----
export const legSpeedMult  = (mk: number): number => [1, 1.15, 1.3, 1.5][mk] ?? 1;
export const torsoHpBonus  = (mk: number): number => [0, 50, 100, 150][mk] ?? 0;
export const armFireMult   = (mk: number): number => [1, 0.85, 0.65, 0.5][mk] ?? 1;   // × weapon cooldown
export const eyeAimMult    = (mk: number): number => [1, 0.6, 0.35, 0.1][mk] ?? 1;    // × reaction delay
