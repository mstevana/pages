import { STORY_H } from "../engine/util";

// 28 hover-car chassis in three families: concept cars with a wedge profile
// and paired projector lamps, blunt working machines that look welded rather
// modelled, and four squat one-piece shells straight out of Bullfrog's
// original - dark, glossy, the dome running down to the sills.
//
// Every model is a set of proportions the renderer extrudes into a solid: the
// plan outline is a superellipse whose squareness comes from `round`, the
// massing comes from `hull`/`cabH`/`cargo`, and the flourishes (fins, bars,
// racks, skirts) are what makes each silhouette read at a glance.

export type Livery = "none" | "check" | "stripe" | "corp" | "rust";

export interface CarModel {
  name: string;
  L: number; W: number;       // half length / half width, in tiles
  round: number;              // 0 slab-sided box, 1 fully rounded plan
  hull: number;               // deck height in px at zoom 1
  cabH: number;               // canopy roof height in px at zoom 1
  cabF: number; cabB: number; // canopy front / back, as a fraction of L
  cabW: number;               // canopy half width, as a fraction of W
  taper: number;              // how far the nose narrows, fraction of W
  cargo: number;              // full-width rear cargo box height in px (0 = none)
  fin: number;                // tail fin height in px (0 = none)
  bar: number;                // 0 none, 1 police light bar, 2 taxi sign
  rack: boolean;              // slim roof pod
  spoiler: boolean;
  bull: boolean;              // front ram bar
  skirt: boolean;             // ground-effect side flare
  turbo: number;              // pairs of visible thrusters
  // ---- shape, rather than furniture: what makes a car read as a car and not
  // a hull with a cabin dropped on it ----
  wedge: number;              // deck rise from nose to tail, in px. low nose, high tail
  hips: number;               // 0 widest amidships, 1 widest over the rear haunches
  fast: number;               // 0 canopy ends in a wall, 1 it runs out to the tail
  lamps: number;              // spot headlamps per side: 1 big round unit, or
                              // 2 in a cluster. A bar hung across the nose is
                              // the one thing that never reads as a real car.
  glassDrop: number;          // how far the glazing reaches down the flanks
  // The Bullfrog shape: no canopy at all, in the sense of a glass pod set on a
  // hull. The dome IS the bodywork, one moulded shell from sill to crown, with
  // a glazing line scribed round it and the gloss doing the rest.
  shell: boolean;
  livery: Livery;
  body: string; accent: string; glassTint: string;
  vfit: number;               // vertical scale that keeps it under a storey
}

const D: Omit<CarModel, "name"> = {
  L: 1.25, W: 0.42, round: 0.4, hull: 8, cabH: 12.5, cabF: 0.34, cabB: -0.6, cabW: 0.74,
  taper: 0.2, cargo: 0, fin: 0, bar: 0, rack: false, spoiler: false, bull: false,
  skirt: false, turbo: 1, wedge: 0, hips: 0, fast: 0, lamps: 1, glassDrop: 0, shell: false, livery: "none", body: "#3a4048", accent: "#7a828e", glassTint: "#6fa8c2",
  vfit: 1,
};
const M = (name: string, o: Partial<CarModel>): CarModel => ({ ...D, name, ...o });

export const CAR_MODELS: CarModel[] = [
  // ---- Concept-car half: wedge profile, haunches over the rear, a canopy set
  // back with the glazing running out to the tail, and an unbroken light blade
  // across nose and tail. Low noses and a deck that climbs are what make these
  // read as designed rather than assembled. ----
  M("TAXI M5", { L: 1.18, W: 0.42, round: 0.7, hull: 6.5, cabH: 15, cabF: 0.54, cabB: -0.7,
    cabW: 0.86, taper: 0.34, wedge: 4.5, hips: 0.6, fast: 0.6, lamps: 2, glassDrop: 0.55,
    bar: 2, livery: "check", body: "#e8b400", accent: "#1a1a1e" }),
  M("POLICE INTERCEPTOR", { L: 1.44, W: 0.43, round: 0.48, hull: 6, cabH: 12, cabF: 0.08, cabB: -0.64,
    cabW: 0.7, taper: 0.46, wedge: 7, hips: 0.95, fast: 0.78, lamps: 2, glassDrop: 0.6,
    bar: 1, skirt: true, turbo: 2, livery: "stripe", body: "#1f3f8c", accent: "#e8eef5" }),
  M("ZORG LIMO", { L: 1.94, W: 0.4, round: 0.6, hull: 5, cabH: 11, cabF: 0.2, cabB: -0.82,
    cabW: 0.74, taper: 0.4, wedge: 6, hips: 0.5, fast: 0.92, lamps: 2, glassDrop: 0.62,
    fin: 4, livery: "corp", body: "#131317", accent: "#c8a24a" }),
  M("RETRO COUPE", { L: 1.24, W: 0.4, round: 0.86, hull: 5.5, cabH: 11.5, cabF: 0.24, cabB: -0.52,
    cabW: 0.66, taper: 0.5, wedge: 6.5, hips: 0.8, fast: 0.72, lamps: 2, glassDrop: 0.5,
    fin: 7, livery: "stripe", body: "#e4dcc4", accent: "#8c1f1f" }),
  M("EUROCORP SDN", { L: 1.4, W: 0.4, round: 0.42, hull: 5.5, cabH: 11.5, cabF: 0.22, cabB: -0.7,
    cabW: 0.72, taper: 0.4, wedge: 5.5, hips: 0.7, fast: 0.8, lamps: 2, glassDrop: 0.58,
    livery: "corp", body: "#54565e", accent: "#9aa2ae" }),
  M("COURIER", { L: 0.96, W: 0.37, round: 0.66, hull: 5.5, cabH: 12, cabF: 0.46, cabB: -0.5,
    cabW: 0.8, taper: 0.38, wedge: 4, hips: 0.55, fast: 0.6, lamps: 2, glassDrop: 0.5,
    rack: true, body: "#2a2d36", accent: "#ff7a1f" }),
  M("QUADRA V", { L: 1.4, W: 0.41, round: 0.5, hull: 4, cabH: 9, cabF: 0.14, cabB: -0.6,
    cabW: 0.62, taper: 0.54, wedge: 8, hips: 1.05, fast: 0.9, lamps: 2, glassDrop: 0.48,
    spoiler: true, skirt: true, turbo: 2, livery: "stripe", body: "#a81c1c", accent: "#f0f0f0" }),
  M("RAYFIELD", { L: 1.62, W: 0.4, round: 0.72, hull: 4.5, cabH: 10, cabF: 0.14, cabB: -0.74,
    cabW: 0.68, taper: 0.48, wedge: 7, hips: 0.9, fast: 0.94, lamps: 2, glassDrop: 0.62,
    skirt: true, livery: "corp", body: "#eceff2", accent: "#c8a24a" }),
  // ---- The Bullfrog shape: squat one-piece shells, dark and glossy, the dome
  // running all the way to the sills. Four of them, because the
  // original game's streets were full of them and they are the reason the
  // series looks the way it does. ----
  M("SCARAB", { lamps: 2, L: 0.9, W: 0.44, round: 1, hull: 4.5, cabH: 13, cabF: 0.74, cabB: -0.8,
    cabW: 0.95, taper: 0.14, hips: 0.18, fast: 0.3, shell: true,
    body: "#17181c", accent: "#b8bec8", glassTint: "#8fb4c8" }),
  M("CARBON POD", { lamps: 2, L: 1.02, W: 0.45, round: 0.95, hull: 5, cabH: 13.5, cabF: 0.7, cabB: -0.82,
    cabW: 0.93, taper: 0.16, hips: 0.22, fast: 0.32, shell: true, turbo: 2,
    body: "#23262c", accent: "#8a929e", glassTint: "#8fb4c8" }),
  M("OBSIDIAN", { lamps: 2, L: 1.12, W: 0.43, round: 0.9, hull: 5, cabH: 13, cabF: 0.68, cabB: -0.84,
    cabW: 0.9, taper: 0.2, hips: 0.25, fast: 0.35, shell: true, livery: "corp",
    body: "#101318", accent: "#c8a24a", glassTint: "#8fb4c8" }),
  M("GREY BEETLE", { lamps: 2, L: 0.96, W: 0.45, round: 1, hull: 4.5, cabH: 12.5, cabF: 0.72, cabB: -0.8,
    cabW: 0.94, taper: 0.14, hips: 0.2, fast: 0.28, shell: true,
    body: "#3c4048", accent: "#aab2be", glassTint: "#8fb4c8" }),
  M("THORTON HATCH", { L: 1.0, W: 0.41, round: 0.6, hull: 6.5, cabH: 12.5, cabF: 0.4, cabB: -0.44,
    cabW: 0.8, taper: 0.34, wedge: 3.5, hips: 0.45, fast: 0.5, lamps: 2, glassDrop: 0.45,
    livery: "rust", body: "#6b7250", accent: "#3a3a34" }),
  M("DELAMAIN CAB", { L: 1.36, W: 0.42, round: 0.56, hull: 6, cabH: 12.5, cabF: 0.44, cabB: -0.68,
    cabW: 0.78, taper: 0.38, wedge: 5, hips: 0.6, fast: 0.74, lamps: 2, glassDrop: 0.6,
    bar: 2, livery: "corp", body: "#14382c", accent: "#d8d2c0" }),
  M("CORPO EXEC", { L: 1.54, W: 0.4, round: 0.55, hull: 5.5, cabH: 11, cabF: 0.16, cabB: -0.74,
    cabW: 0.68, taper: 0.44, wedge: 6.5, hips: 0.8, fast: 0.9, lamps: 2, glassDrop: 0.6,
    livery: "corp", body: "#0f1014", accent: "#b8bec8" }),
  M("ALVARADO", { L: 1.48, W: 0.43, round: 0.34, hull: 6.5, cabH: 12, cabF: 0.2, cabB: -0.68,
    cabW: 0.74, taper: 0.36, wedge: 5, hips: 0.75, fast: 0.7, lamps: 2, glassDrop: 0.5,
    livery: "stripe", body: "#8a7a5c", accent: "#2e2a22" }),
  M("MAKIGAI POD", { L: 0.86, W: 0.41, round: 0.95, hull: 5, cabH: 14, cabF: 0.66, cabB: -0.68,
    cabW: 0.92, taper: 0.34, wedge: 3, hips: 0.35, fast: 0.45, lamps: 2, glassDrop: 0.72,
    body: "#1f8a8a", accent: "#e8f4f4", glassTint: "#8fd0dc" }),
  M("HERRERA RACE", { L: 1.46, W: 0.39, round: 0.52, hull: 3.5, cabH: 8, cabF: 0.1, cabB: -0.54,
    cabW: 0.56, taper: 0.58, wedge: 9, hips: 1.15, fast: 0.95, lamps: 2, glassDrop: 0.42,
    spoiler: true, skirt: true, turbo: 2, livery: "stripe", body: "#e07a10", accent: "#141418" }),
  M("MIZUTANI", { L: 1.34, W: 0.39, round: 0.62, hull: 4.5, cabH: 9.5, cabF: 0.16, cabB: -0.62,
    cabW: 0.62, taper: 0.52, wedge: 7.5, hips: 1, fast: 0.88, lamps: 2, glassDrop: 0.5,
    fin: 3, spoiler: true, body: "#b8bcc4", accent: "#25e0ff" }),
  M("CHEVALIER", { L: 1.32, W: 0.43, round: 0.4, hull: 6.5, cabH: 12, cabF: 0.24, cabB: -0.66,
    cabW: 0.76, taper: 0.34, wedge: 5, hips: 0.7, fast: 0.72, lamps: 2, glassDrop: 0.5,
    rack: true, body: "#3a4048", accent: "#7a828e" }),
  M("NEON SPORT", { L: 1.36, W: 0.39, round: 0.66, hull: 4, cabH: 9, cabF: 0.14, cabB: -0.62,
    cabW: 0.6, taper: 0.56, wedge: 8.5, hips: 1.1, fast: 0.92, lamps: 2, glassDrop: 0.46,
    fin: 4, spoiler: true, skirt: true, turbo: 2, livery: "stripe", body: "#2a0f3a", accent: "#ff2fa0" }),

  // ---- Working half: left blunt on purpose. A city where every last van is a
  // teardrop has nothing for the sleek ones to be sleek against, and these are
  // the machines that are meant to look like they were welded, not modelled. ----
  M("ENFORCER", { L: 1.26, W: 0.44, round: 0.05, hull: 9.5, cabH: 13.5, cabF: 0.36, cabB: -0.6,
    cabW: 0.78, taper: 0.06, bull: true, body: "#1d2740", accent: "#4a6ea8" }),
  M("CARGO HAULER", { L: 1.52, W: 0.47, round: 0.1, hull: 10.5, cabH: 16, cabF: 0.66, cabB: 0.24,
    cabW: 0.8, taper: 0.12, cargo: 14, turbo: 2, livery: "stripe", body: "#c8641e", accent: "#2a2a30" }),
  M("TRANSIT BLOCK", { L: 1.46, W: 0.49, round: 0, hull: 11.5, cabH: 17, cabF: 0.7, cabB: 0.34,
    cabW: 0.78, taper: 0.02, cargo: 17, turbo: 2, body: "#232630", accent: "#5c6270" }),
  M("PATROL WAGON", { L: 1.38, W: 0.45, round: 0.12, hull: 10, cabH: 14.5, cabF: 0.44, cabB: -0.16,
    cabW: 0.82, taper: 0.08, cargo: 8, bar: 1, livery: "stripe", body: "#3d4a2a", accent: "#c8c840" }),
  M("MILITECH SUV", { L: 1.36, W: 0.47, round: 0.08, hull: 12, cabH: 17, cabF: 0.46, cabB: -0.42,
    cabW: 0.84, taper: 0.08, cargo: 5, bull: true, turbo: 2, livery: "corp",
    body: "#191b20", accent: "#6d7684", glassTint: "#4c6a78" }),
  M("KAUKAZ TRUCK", { L: 1.78, W: 0.5, round: 0, hull: 12.5, cabH: 18, cabF: 0.76, cabB: 0.42,
    cabW: 0.76, taper: 0.02, cargo: 19, bull: true, turbo: 2, livery: "rust",
    body: "#4a4438", accent: "#8a7a4a" }),
  M("MAHIR SUPRON", { L: 1.46, W: 0.45, round: 0.18, hull: 10, cabH: 15, cabF: 0.56, cabB: -0.08,
    cabW: 0.82, taper: 0.1, cargo: 12, livery: "stripe", body: "#5a2e78", accent: "#d8a8ff" }),
];



// A car has to fit under whatever is over it. In a basement garage that is the
// slab holding up the street, one storey above the floor it is parked on, and
// anything taller pokes through it. Measure each model's highest point -- roof
// furniture included, since a light bar is what sticks out -- and squash the
// whole body to fit if it overruns.
const GROUND_CLEARANCE = 2;              // px at zoom 1, matching drawCar
const HEADROOM = 0.95 * STORY_H;         // 95% of the storey it parks under

// No car may be longer than three tiles, or two of them overlap where the road
// spacing only leaves room for three. The body runs nose to tail over 2*L, and
// a ram bar pushes the nose out another tenth, so the true half-extent is
// L*(bull?1.1:1); scale L down where that would exceed 1.5 tiles. Doing it here
// rather than by hand keeps the guarantee even as new chassis are added.
export const MAX_CAR_HALF = 1.5;         // three tiles, tip to tip
for (const m of CAR_MODELS) {
  const halfExtent = m.L * (m.bull ? 1.1 : 1);
  if (halfExtent > MAX_CAR_HALF) m.L *= MAX_CAR_HALF / halfExtent;
}

for (const m of CAR_MODELS) {
  // the wedge raises the tail, so whatever sits back there sits that much
  // higher and has to be counted or a garage ceiling gets a spoiler through it
  const top = Math.max(
    m.cabH + (m.bar ? 2.2 : 0) + m.wedge * 0.5,
    m.hull + m.cargo + m.wedge,
    m.hull + m.fin + m.wedge,
    m.hull + (m.rack ? 4 : 0) + m.wedge,
    m.hull + (m.spoiler ? 4.5 : 0) + m.wedge,
  );
  const tall = GROUND_CLEARANCE + top;
  m.vfit = tall <= HEADROOM ? 1 : HEADROOM / tall;
}
