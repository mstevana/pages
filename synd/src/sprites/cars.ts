// 24 hover-car chassis. The line-up borrows from the flying taxis and police
// cruisers of The Fifth Element, the blunt utilitarian machines of Syndicate,
// and the muscle cars, corpo sedans and armoured SUVs of Cyberpunk 2077.
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
  livery: Livery;
  body: string; accent: string; glassTint: string;
}

const D: Omit<CarModel, "name"> = {
  L: 1.25, W: 0.42, round: 0.4, hull: 8, cabH: 12.5, cabF: 0.34, cabB: -0.6, cabW: 0.74,
  taper: 0.2, cargo: 0, fin: 0, bar: 0, rack: false, spoiler: false, bull: false,
  skirt: false, turbo: 1, livery: "none", body: "#3a4048", accent: "#7a828e", glassTint: "#6fa8c2",
};
const M = (name: string, o: Partial<CarModel>): CarModel => ({ ...D, name, ...o });

export const CAR_MODELS: CarModel[] = [
  // ---- The Fifth Element: rounded retro-future cabs and cruisers ----
  M("TAXI M5", { L: 1.15, W: 0.41, round: 0.75, hull: 8.5, cabH: 15, cabF: 0.36, cabB: -0.52,
    cabW: 0.82, taper: 0.24, bar: 2, livery: "check", body: "#e8b400", accent: "#1a1a1e" }),
  M("POLICE CRUISER", { L: 1.34, W: 0.43, round: 0.2, hull: 9.5, cabH: 14.5, cabF: 0.4, cabB: -0.5,
    cabW: 0.8, taper: 0.14, bar: 1, bull: true, livery: "stripe", body: "#1f3f8c", accent: "#e8eef5" }),
  M("ZORG LIMO", { L: 1.92, W: 0.38, round: 0.55, hull: 6, cabH: 11.5, cabF: 0.06, cabB: -0.8,
    cabW: 0.72, taper: 0.34, fin: 5, livery: "corp", body: "#131317", accent: "#c8a24a" }),
  M("CARGO HAULER", { L: 1.52, W: 0.47, round: 0.1, hull: 10.5, cabH: 16, cabF: 0.66, cabB: 0.24,
    cabW: 0.8, taper: 0.12, cargo: 14, turbo: 2, livery: "stripe", body: "#c8641e", accent: "#2a2a30" }),
  M("RETRO COUPE", { L: 1.16, W: 0.4, round: 0.85, hull: 7, cabH: 12.5, cabF: 0.3, cabB: -0.5,
    cabW: 0.7, taper: 0.4, fin: 8, livery: "stripe", body: "#e4dcc4", accent: "#8c1f1f" }),
  // ---- Syndicate: blunt, riveted, government-issue ----
  M("ENFORCER", { L: 1.26, W: 0.44, round: 0.05, hull: 9.5, cabH: 13.5, cabF: 0.36, cabB: -0.6,
    cabW: 0.78, taper: 0.06, bull: true, body: "#1d2740", accent: "#4a6ea8" }),
  M("EUROCORP SDN", { L: 1.34, W: 0.39, round: 0.35, hull: 7.5, cabH: 12, cabF: 0.34, cabB: -0.66,
    cabW: 0.74, taper: 0.16, livery: "corp", body: "#54565e", accent: "#9aa2ae" }),
  M("TRANSIT BLOCK", { L: 1.46, W: 0.49, round: 0, hull: 11.5, cabH: 17, cabF: 0.7, cabB: 0.34,
    cabW: 0.78, taper: 0.02, cargo: 17, turbo: 2, body: "#232630", accent: "#5c6270" }),
  M("PATROL WAGON", { L: 1.38, W: 0.45, round: 0.12, hull: 10, cabH: 14.5, cabF: 0.44, cabB: -0.16,
    cabW: 0.82, taper: 0.08, cargo: 8, bar: 1, livery: "stripe", body: "#3d4a2a", accent: "#c8c840" }),
  M("COURIER", { L: 0.9, W: 0.36, round: 0.6, hull: 7.5, cabH: 12.5, cabF: 0.38, cabB: -0.46,
    cabW: 0.78, taper: 0.2, rack: true, body: "#2a2d36", accent: "#ff7a1f" }),
  // ---- Cyberpunk 2077: muscle, corpo chrome and armour ----
  M("QUADRA V", { L: 1.36, W: 0.4, round: 0.45, hull: 5, cabH: 9.5, cabF: 0.28, cabB: -0.62,
    cabW: 0.66, taper: 0.44, spoiler: true, skirt: true, turbo: 2, livery: "stripe",
    body: "#a81c1c", accent: "#f0f0f0" }),
  M("RAYFIELD", { L: 1.58, W: 0.39, round: 0.7, hull: 5.5, cabH: 10.5, cabF: 0.2, cabB: -0.72,
    cabW: 0.7, taper: 0.4, skirt: true, livery: "corp", body: "#eceff2", accent: "#c8a24a" }),
  M("MILITECH SUV", { L: 1.36, W: 0.47, round: 0.08, hull: 12, cabH: 17, cabF: 0.46, cabB: -0.42,
    cabW: 0.84, taper: 0.08, cargo: 5, bull: true, turbo: 2, livery: "corp",
    body: "#191b20", accent: "#6d7684", glassTint: "#4c6a78" }),
  M("THORTON HATCH", { L: 0.96, W: 0.4, round: 0.55, hull: 8.5, cabH: 13.5, cabF: 0.34, cabB: -0.4,
    cabW: 0.8, taper: 0.18, livery: "rust", body: "#6b7250", accent: "#3a3a34" }),
  M("DELAMAIN CAB", { L: 1.32, W: 0.41, round: 0.5, hull: 8, cabH: 13, cabF: 0.34, cabB: -0.6,
    cabW: 0.76, taper: 0.24, bar: 2, livery: "corp", body: "#14382c", accent: "#d8d2c0" }),
  M("CORPO EXEC", { L: 1.48, W: 0.39, round: 0.5, hull: 6.8, cabH: 11.8, cabF: 0.24, cabB: -0.7,
    cabW: 0.7, taper: 0.32, livery: "corp", body: "#0f1014", accent: "#b8bec8" }),
  M("ALVARADO", { L: 1.44, W: 0.42, round: 0.25, hull: 8.5, cabH: 13, cabF: 0.26, cabB: -0.66,
    cabW: 0.76, taper: 0.2, livery: "stripe", body: "#8a7a5c", accent: "#2e2a22" }),
  M("MAKIGAI BUBBLE", { L: 0.8, W: 0.39, round: 1, hull: 6.5, cabH: 15.5, cabF: 0.5, cabB: -0.24,
    cabW: 0.9, taper: 0.16, body: "#1f8a8a", accent: "#e8f4f4", glassTint: "#8fd0dc" }),
  M("HERRERA RACE", { L: 1.42, W: 0.38, round: 0.5, hull: 4.5, cabH: 8.5, cabF: 0.22, cabB: -0.56,
    cabW: 0.6, taper: 0.5, spoiler: true, skirt: true, turbo: 2, livery: "stripe",
    body: "#e07a10", accent: "#141418" }),
  M("MIZUTANI", { L: 1.3, W: 0.38, round: 0.6, hull: 5.5, cabH: 10.5, cabF: 0.28, cabB: -0.6,
    cabW: 0.66, taper: 0.46, fin: 4, spoiler: true, body: "#b8bcc4", accent: "#25e0ff" }),
  M("KAUKAZ TRUCK", { L: 1.78, W: 0.5, round: 0, hull: 12.5, cabH: 18, cabF: 0.76, cabB: 0.42,
    cabW: 0.76, taper: 0.02, cargo: 19, bull: true, turbo: 2, livery: "rust",
    body: "#4a4438", accent: "#8a7a4a" }),
  M("CHEVALIER", { L: 1.28, W: 0.43, round: 0.15, hull: 8.5, cabH: 13, cabF: 0.32, cabB: -0.62,
    cabW: 0.8, taper: 0.1, rack: true, body: "#3a4048", accent: "#7a828e" }),
  M("MAHIR SUPRON", { L: 1.46, W: 0.45, round: 0.18, hull: 10, cabH: 15, cabF: 0.56, cabB: -0.08,
    cabW: 0.82, taper: 0.1, cargo: 12, livery: "stripe", body: "#5a2e78", accent: "#d8a8ff" }),
  M("NEON SPORT", { L: 1.32, W: 0.38, round: 0.65, hull: 5, cabH: 9.5, cabF: 0.26, cabB: -0.6,
    cabW: 0.64, taper: 0.48, fin: 5, spoiler: true, skirt: true, turbo: 2, livery: "stripe",
    body: "#2a0f3a", accent: "#ff2fa0" }),
];
