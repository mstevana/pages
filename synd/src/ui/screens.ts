// Fullscreen DOM overlays: menu, briefing, armory, debrief, game over, objectives.

import { Weather } from "../engine/util";
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
  const roster = save.agents.map((a) =>
    `<tr><td>${a.name}</td><td>${a.alive ? a.hp + "%" : "K.I.A."}</td><td>${a.alive ? a.inv.map((i) => ITEMS[i.type].short).join(" ") || "-" : "-"}</td></tr>`
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

  const BUY: ItemType[] = ["gun", "uzi", "shotgun", "minigun", "laser", "gauss", "shield", "medkit", "persuadertron"];
  const HIRE_COST = 1200;
  const icons = itemIconUrls();

  const render = () => {
    clearScreens();
    const a = save.agents[agentIdx];
    const tabs = save.agents.map((ag, i) =>
      `<button class="agent-tab ${i === agentIdx ? "" : "ghost"}" data-i="${i}">${ag.name}${ag.alive ? "" : " &dagger;"}</button>`
    ).join("");

    // loadout: eight compact slots, tap one to sell it
    let slots = "";
    if (!a.alive) {
      slots = `<div class="arm-sec">AGENT DECEASED</div>
        <button id="hire" class="${save.credits >= HIRE_COST ? "" : "ghost"}">HIRE REPLACEMENT &middot; ${HIRE_COST}cr</button>`;
    } else {
      const cells = [];
      for (let i = 0; i < 8; i++) {
        const it = a.inv[i];
        if (!it) { cells.push(`<div class="arm-slot empty"><img src="${icons.gun}" style="visibility:hidden"><span class="arm-act">&nbsp;</span><span class="arm-act">&nbsp;</span></div>`); continue; }
        const def = ITEMS[it.type];
        const frac = Math.max(0, Math.min(1, it.charge / def.charge));
        const rl = reloadCost(it);
        const rlRow = rl > 0
          ? `<span class="arm-act rld ${save.credits >= rl ? "" : "poor"}" data-i="${i}">&#8635;${rl}</span>`
          : `<span class="arm-act poor">&#8635;&mdash;</span>`;
        cells.push(
          `<div class="arm-slot" title="${def.name}">
             <img src="${icons[it.type]}" alt="${def.name}">
             <span class="arm-bar"><i style="width:${(frac * 100).toFixed(0)}%;background:${frac > 0.25 ? def.color : "#e04040"}"></i></span>
             ${rlRow}
             <span class="arm-act sell" data-i="${i}">+${sellValue(it)}</span>
           </div>`
        );
      }
      slots = `<div class="arm-slots">${cells.join("")}</div>`;
    }

    const market = BUY.map((t) => {
      const afford = save.credits >= ITEMS[t].price && a.alive && a.inv.length < 8;
      return `<div class="arm-card ${afford ? "afford buy" : "poor"}" data-t="${t}" title="${ITEMS[t].name}">
                <img src="${icons[t]}" alt="${ITEMS[t].name}">
                <span class="arm-name">${ITEMS[t].short}</span>
                <span class="arm-cost">${ITEMS[t].price}</span>
              </div>`;
    }).join("");

    const s = screen(`
      <div class="arm-top">
        <h2>ARMORY</h2>
        <span class="arm-funds">${save.credits}cr</span>
        <span class="arm-spacer"></span>
        <button id="done">Back</button>
      </div>
      <div class="arm-tabs">${tabs}</div>
      <div class="arm-sec">LOADOUT &middot; ${a.name} &middot; &#8635; RELOAD &middot; + SELL (spent gear fetches less)</div>
      ${slots}
      <div class="arm-sec">MARKET &middot; TAP TO BUY</div>
      <div class="arm-market">${market}</div>
    `);
    s.classList.add("armory");

    s.querySelectorAll(".agent-tab").forEach((el) =>
      el.addEventListener("click", () => { agentIdx = Number((el as HTMLElement).dataset.i); render(); })
    );
    s.querySelectorAll(".arm-card.buy").forEach((el) =>
      el.addEventListener("click", () => {
        const t = (el as HTMLElement).dataset.t as ItemType;
        const ag = save.agents[agentIdx];
        if (!ag.alive || ag.inv.length >= 8 || save.credits < ITEMS[t].price) return;
        save.credits -= ITEMS[t].price;
        ag.inv.push(newItem(t));
        render();
      })
    );
    s.querySelectorAll(".arm-act.sell").forEach((el) =>
      el.addEventListener("click", () => {
        const i = Number((el as HTMLElement).dataset.i);
        const ag = save.agents[agentIdx];
        if (!ag.alive || i >= ag.inv.length) return;
        const [it] = ag.inv.splice(i, 1);
        save.credits += sellValue(it);
        render();
      })
    );
    s.querySelectorAll(".arm-act.rld:not(.poor)").forEach((el) =>
      el.addEventListener("click", () => {
        const i = Number((el as HTMLElement).dataset.i);
        const ag = save.agents[agentIdx];
        if (!ag.alive || i >= ag.inv.length) return;
        const it = ag.inv[i];
        const cost = reloadCost(it);
        if (cost <= 0 || save.credits < cost) return;
        save.credits -= cost;
        it.charge = ITEMS[it.type].charge;
        render();
      })
    );
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
  screen(`<h2>${text}</h2><p class="dim">GENERATING SECTOR GRID 512&times;512</p>`);
}
