// Fullscreen DOM overlays: menu, briefing, armory, debrief, game over, objectives.

import { GRID, Weather } from "../engine/util";
import { ITEMS, ItemType, newItem, reloadCost, sellValue } from "../game/items";
import { itemIconUrls } from "../sprites/icons";
import { SaveData, newAgentName } from "../game/save";
import { MissionResult, ObjectiveKind } from "../game/world";

const ui = () => document.getElementById("ui") as HTMLDivElement;

export function clearScreens(): void {
  ui().innerHTML = "";
}

function screen(html: string): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "screen";
  div.innerHTML = html;
  ui().appendChild(div);
  return div;
}

function on(root: HTMLElement, sel: string, fn: (ev: Event) => void): void {
  const el = root.querySelector(sel);
  if (el) el.addEventListener("click", fn);
}

export const WEATHER_LABEL: Record<Weather, string> = {
  day: "CLEAR / DAY", night: "CLEAR / NIGHT", rainday: "RAIN / DAY", rainnight: "RAIN / NIGHT",
};
export const OBJECTIVE_LABEL: Record<ObjectiveKind, string> = {
  assassinate: "ASSASSINATE", persuade: "PERSUADE & EXTRACT", escort: "ESCORT", killall: "PURGE SECTOR",
};

export function showMenu(hasSave: boolean, onStart: (cont: boolean) => void): void {
  clearScreens();
  const s = screen(`
    <h1>SYND</h1>
    <p class="dim">TACTICAL OPERATIONS &middot; EURO-CORP FRANCHISE TERMINAL</p>
    <p>Command a squad of four cyborg agents in a procedurally generated
    cyberpunk metropolis. Complete contracts. Acquire hardware. Expand the syndicate.</p>
    <div>
      ${hasSave ? '<button id="cont">Continue Campaign</button>' : ""}
      <button id="new" class="${hasSave ? "ghost" : ""}">New Campaign</button>
    </div>
    <p class="dim">landscape &middot; tap to command &middot; audio on first tap</p>
  `);
  on(s, "#cont", () => onStart(true));
  on(s, "#new", () => {
    if (hasSave && !confirm("Erase the existing campaign?")) return;
    onStart(false);
  });
}

export function showBriefing(
  save: SaveData,
  kind: ObjectiveKind,
  weather: Weather,
  text: string,
  onLaunch: () => void,
  onArmory: () => void
): void {
  clearScreens();
  const icons = itemIconUrls();
  // the loadout reads as the kit itself: one icon per item, each over what is
  // left in it, so a squad going out on empty guns is obvious at a glance
  const kit = (a: SaveData["agents"][number]): string => {
    if (!a.alive || a.inv.length === 0) return `<span class="dim">-</span>`;
    return `<div class="brief-kit">${a.inv.map((it) => {
      const def = ITEMS[it.type];
      const frac = Math.max(0, Math.min(1, it.charge / def.charge));
      const bar = def.charge > 1
        ? `<span class="kit-bar"><i style="width:${(frac * 100).toFixed(0)}%;background:${frac > 0.25 ? def.color : "#e04040"}"></i></span>`
        : `<span class="kit-bar"></span>`;
      return `<span class="kit-slot" title="${def.name}"><img src="${icons[it.type]}" alt="${def.name}">${bar}</span>`;
    }).join("")}</div>`;
  };
  const roster = save.agents.map((a) =>
    `<tr><td>${a.name}</td><td>${a.alive ? a.hp + "%" : "K.I.A."}</td><td>${kit(a)}</td></tr>`
  ).join("");
  const s = screen(`
    <h2>MISSION ${String(save.mission).padStart(2, "0")} &middot; ${OBJECTIVE_LABEL[kind]}</h2>
    <p class="dim">CONDITIONS: ${WEATHER_LABEL[weather]} &middot; FUNDS: ${save.credits}cr</p>
    <p>${text}</p>
    <table>
      <tr><th>AGENT</th><th>COND</th><th>LOADOUT</th></tr>
      ${roster}
    </table>
    <div>
      <button id="armory" class="ghost">Armory</button>
      <button id="launch">Begin Mission</button>
    </div>
  `);
  on(s, "#launch", onLaunch);
  on(s, "#armory", onArmory);
}

export function showArmory(save: SaveData, onDone: () => void): void {
  clearScreens();
  let agentIdx = save.agents.findIndex((a) => a.alive);
  if (agentIdx < 0) agentIdx = 0;
  // nothing is bought or sold by tapping the grid - picking an item only
  // selects it, and the action bar carries thumb-sized buttons
  let pick: { where: "inv" | "shop"; idx: number; type?: ItemType } | null = null;

  const BUY: ItemType[] = ["gun", "uzi", "shotgun", "minigun", "laser", "gauss", "shield", "medkit", "persuadertron"];
  const HIRE_COST = 1200;
  const icons = itemIconUrls();

  const render = () => {
    clearScreens();
    const a = save.agents[agentIdx];
    if (pick && pick.where === "inv" && (!a.alive || pick.idx >= a.inv.length)) pick = null;

    const tabs = save.agents.map((ag, i) =>
      `<button class="agent-tab ${i === agentIdx ? "" : "ghost"}" data-i="${i}">${ag.name}${ag.alive ? "" : " &dagger;"}</button>`
    ).join("");

    let slots = "";
    if (!a.alive) {
      slots = `<div class="arm-sec">AGENT DECEASED</div>
        <button id="hire" class="${save.credits >= HIRE_COST ? "" : "ghost"}">HIRE REPLACEMENT &middot; ${HIRE_COST}cr</button>`;
    } else {
      const cells = [];
      for (let i = 0; i < 8; i++) {
        const it = a.inv[i];
        if (!it) { cells.push(`<div class="arm-slot empty"><img src="${icons.gun}" style="visibility:hidden"><span class="arm-bar"></span></div>`); continue; }
        const def = ITEMS[it.type];
        const frac = Math.max(0, Math.min(1, it.charge / def.charge));
        const on = pick && pick.where === "inv" && pick.idx === i ? "on" : "";
        cells.push(
          `<div class="arm-slot pickinv ${on}" data-i="${i}" title="${def.name}">
             <img src="${icons[it.type]}" alt="${def.name}">
             <span class="arm-bar"><i style="width:${(frac * 100).toFixed(0)}%;background:${frac > 0.25 ? def.color : "#e04040"}"></i></span>
           </div>`
        );
      }
      slots = `<div class="arm-slots">${cells.join("")}</div>`;
    }

    const market = BUY.map((t, i) => {
      const on = pick && pick.where === "shop" && pick.idx === i ? "on" : "";
      const afford = save.credits >= ITEMS[t].price;
      return `<div class="arm-card pickshop ${on} ${afford ? "afford" : "poor"}" data-i="${i}" data-t="${t}" title="${ITEMS[t].name}">
                <img src="${icons[t]}" alt="${ITEMS[t].name}">
                <span class="arm-name">${ITEMS[t].short}</span>
                <span class="arm-cost">${ITEMS[t].price}</span>
              </div>`;
    }).join("");

    // ---- action bar ----
    let bar = `<span class="arm-info dim">SELECT AN ITEM TO BUY, RELOAD OR SELL</span>`;
    if (pick && pick.where === "inv" && a.alive) {
      const it = a.inv[pick.idx];
      const def = ITEMS[it.type];
      const rl = reloadCost(it);
      const rlBtn = rl > 0
        ? `<button id="act-rld" class="${save.credits >= rl ? "rld" : "ghost"}">RELOAD &minus;${rl}</button>`
        : "";
      bar = `<span class="arm-info">${def.name} &middot; ${Math.ceil(it.charge)}/${def.charge}${rl > 0 ? "" : " &middot; FULL"}</span>
             ${rlBtn}
             <button id="act-sell" class="sell">SELL +${sellValue(it)}</button>`;
    } else if (pick && pick.where === "shop") {
      const t = BUY[pick.idx];
      const def = ITEMS[t];
      const full = a.alive && a.inv.length >= 8;
      const broke = save.credits < def.price;
      const why = !a.alive ? "AGENT DECEASED" : full ? "NO FREE SLOTS" : broke ? "NOT ENOUGH CREDITS" : "";
      bar = `<span class="arm-info">${def.name} &middot; ${def.price}cr &middot; ${def.charge} charge${why ? ` &middot; <b style="color:#e04040">${why}</b>` : ""}</span>
             <button id="act-buy" class="${why ? "ghost" : "buy"}">BUY &minus;${def.price}</button>`;
    }

    const s = screen(`
      <div class="arm-top">
        <h2>ARMORY</h2>
        <span class="arm-funds">${save.credits}cr</span>
        <span class="arm-spacer"></span>
        <button id="done">Back</button>
      </div>
      <div class="arm-tabs">${tabs}</div>
      <div class="arm-sec">LOADOUT &middot; ${a.name}</div>
      ${slots}
      <div class="arm-sec">MARKET</div>
      <div class="arm-market">${market}</div>
      <div class="arm-actbar">${bar}</div>
    `);
    s.classList.add("armory");

    s.querySelectorAll(".agent-tab").forEach((el) =>
      el.addEventListener("click", () => { agentIdx = Number((el as HTMLElement).dataset.i); pick = null; render(); })
    );
    s.querySelectorAll(".arm-slot.pickinv").forEach((el) =>
      el.addEventListener("click", () => { pick = { where: "inv", idx: Number((el as HTMLElement).dataset.i) }; render(); })
    );
    s.querySelectorAll(".arm-card.pickshop").forEach((el) =>
      el.addEventListener("click", () => {
        const e = el as HTMLElement;
        pick = { where: "shop", idx: Number(e.dataset.i), type: e.dataset.t as ItemType };
        render();
      })
    );
    on(s, "#act-sell", () => {
      const ag = save.agents[agentIdx];
      if (!pick || pick.where !== "inv" || !ag.alive || pick.idx >= ag.inv.length) return;
      const [it] = ag.inv.splice(pick.idx, 1);
      save.credits += sellValue(it);
      pick = null;
      render();
    });
    on(s, "#act-rld", () => {
      const ag = save.agents[agentIdx];
      if (!pick || pick.where !== "inv" || !ag.alive || pick.idx >= ag.inv.length) return;
      const it = ag.inv[pick.idx];
      const cost = reloadCost(it);
      if (cost <= 0 || save.credits < cost) return;
      save.credits -= cost;
      it.charge = ITEMS[it.type].charge;
      render();
    });
    on(s, "#act-buy", () => {
      const ag = save.agents[agentIdx];
      if (!pick || pick.where !== "shop" || !ag.alive) return;
      const t = BUY[pick.idx];
      if (ag.inv.length >= 8 || save.credits < ITEMS[t].price) return;
      save.credits -= ITEMS[t].price;
      ag.inv.push(newItem(t));
      render();
    });
    on(s, "#hire", () => {
      if (save.credits < HIRE_COST) return;
      save.credits -= HIRE_COST;
      const ag = save.agents[agentIdx];
      ag.alive = true; ag.hp = 100; ag.inv = [newItem("gun")];
      ag.name = newAgentName(save.agents.map((x) => x.name));
      render();
    });
    on(s, "#done", onDone);
  };
  render();
}

export function showDebrief(
  save: SaveData, result: MissionResult, onContinue: () => void
): void {
  clearScreens();
  const s = screen(`
    <h2 style="color:${result.success ? "#4fdc6a" : "#e04040"}">
      MISSION ${result.success ? "ACCOMPLISHED" : "FAILED"}
    </h2>
    <p>${result.reason}</p>
    <table>
      <tr><td>KILLS</td><td>${result.kills}</td></tr>
      <tr><td>CREDITS EARNED</td><td>${result.creditsEarned}cr</td></tr>
      <tr><td>SYNDICATE FUNDS</td><td>${save.credits}cr</td></tr>
      <tr><td>AGENTS ACTIVE</td><td>${save.agents.filter((a) => a.alive).length}/4</td></tr>
    </table>
    <button id="next">Continue</button>
  `);
  on(s, "#next", onContinue);
}

export function showGameOver(save: SaveData, onNew: () => void): void {
  clearScreens();
  const s = screen(`
    <h2 style="color:#e04040">SYNDICATE TERMINATED</h2>
    <p>All agents lost. The board has liquidated your franchise.</p>
    <table>
      <tr><td>MISSIONS COMPLETED</td><td>${save.mission - 1}</td></tr>
      <tr><td>TOTAL KILLS</td><td>${save.kills}</td></tr>
    </table>
    <button id="new">New Campaign</button>
  `);
  on(s, "#new", onNew);
}

export function showObjectives(
  missionNo: number, kind: ObjectiveKind, text: string, status: string, onResume: () => void
): void {
  clearScreens();
  const s = screen(`
    <h2>OBJECTIVES</h2>
    <p class="dim">MISSION ${String(missionNo).padStart(2, "0")} &middot; ${OBJECTIVE_LABEL[kind]}</p>
    <p>${text}</p>
    <p style="color:#ffe32f">${status}</p>
    <button id="resume">Resume</button>
  `);
  on(s, "#resume", onResume);
}

export function showPause(onResume: () => void, onAbort: () => void): void {
  clearScreens();
  const s = screen(`
    <h2>PAUSED</h2>
    <div>
      <button id="resume">Resume</button>
      <button id="abort" class="ghost">Abort Mission</button>
    </div>
  `);
  on(s, "#resume", onResume);
  on(s, "#abort", () => {
    if (confirm("Abort the mission? It will count as failed.")) onAbort();
  });
}

export function showLoading(text: string): void {
  clearScreens();
  screen(`<h2>${text}</h2><p class="dim">GENERATING SECTOR GRID ${GRID}&times;${GRID}</p>`);
}
