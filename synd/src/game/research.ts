// The research tree and the implant catalogue.
//
// Money is the only resource: a node is bought outright in the lab between
// missions, gated by the node before it in its branch. Weapons and kit that
// have not been researched cannot be bought at the armory (loot is exempt -
// a gun taken off a corpse works no matter whose lab it came from). Implants
// are researched per body part and per mark, then bought and installed on an
// agent; they die with the agent.

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
  cost: number;              // credits to research
  req: string | null;        // node that must be researched first
  item?: ItemType;           // unlocks this item at the armory
  part?: ImplantPart;        // unlocks this implant mark for purchase
  mark?: number;
}

// Chains, in play order. The pistol is the starter weapon and needs no
// research; everything else earns its place.
export const RESEARCH: ResearchNode[] = [
  // ---- guns: powder and lead, cheap and early ----
  { id: "uzi",      branch: "guns", name: "UZI",         desc: "Machine pistol. Volume of fire over manners.", cost: 400,  req: null,      item: "uzi" },
  { id: "shotgun",  branch: "guns", name: "SHOTGUN",     desc: "Five pellets a pull. Ends arguments indoors.", cost: 700,  req: "uzi",     item: "shotgun" },
  { id: "minigun",  branch: "guns", name: "MINIGUN",     desc: "Rotary cannon. The street empties around it.", cost: 1800, req: "shotgun", item: "minigun" },
  // ---- tech weapons: the lab's own line ----
  { id: "laser",    branch: "tech", name: "LASER",       desc: "Hitscan beam, burns through a file of men.",   cost: 2200, req: null,      item: "laser" },
  { id: "gauss",    branch: "tech", name: "GAUSS GUN",   desc: "Hypervelocity slug. One round, one building.", cost: 3600, req: "laser",   item: "gauss" },
  // ---- defense: keeping the squad on its feet ----
  { id: "medkit",   branch: "defense", name: "MEDKIT",        desc: "Field trauma pack, two uses.",            cost: 200,  req: null,     item: "medkit" },
  { id: "shield",   branch: "defense", name: "SHIELD BELT",   desc: "Personal energy screen. Drains as it takes hits.", cost: 900, req: "medkit", item: "shield" },
  { id: "psdr",     branch: "defense", name: "PERSUADERTRON", desc: "Neural override. Civilians follow you home.", cost: 1100, req: "shield", item: "persuadertron" },
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
      { researchCost: 500,  price: 400,  label: "+15% MOVE" },
      { researchCost: 1000, price: 900,  label: "+30% MOVE" },
      { researchCost: 2000, price: 1800, label: "+50% MOVE" },
    ] },
  torso: { part: "torso", name: "CHEST PLATING", desc: "Harder to kill.",
    marks: [
      { researchCost: 600,  price: 500,  label: "+50 HP" },
      { researchCost: 1200, price: 1100, label: "+100 HP" },
      { researchCost: 2400, price: 2200, label: "+150 HP" },
    ] },
  arms: { part: "arms", name: "ARM ACTUATORS", desc: "Faster trigger work.",
    marks: [
      { researchCost: 600,  price: 500,  label: "+18% FIRE RATE" },
      { researchCost: 1200, price: 1100, label: "+54% FIRE RATE" },
      { researchCost: 2400, price: 2200, label: "+100% FIRE RATE" },
    ] },
  eyes: { part: "eyes", name: "TARGETING OPTICS", desc: "Snaps onto a threat sooner.",
    marks: [
      { researchCost: 500,  price: 400,  label: "-40% REACTION" },
      { researchCost: 1000, price: 900,  label: "-65% REACTION" },
      { researchCost: 2000, price: 1800, label: "-90% REACTION" },
    ] },
};
export const implantNodeId = (part: ImplantPart, mark: number): string => `${part}${mark}`;

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
export const canResearch = (research: string[], id: string): boolean => {
  const n = RESEARCH_ALL.get(id);
  if (!n || isResearched(research, id)) return false;
  return n.req === null || isResearched(research, n.req);
};

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
