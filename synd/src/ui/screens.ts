// Fullscreen DOM overlays: menu, briefing, armory, debrief, game over, objectives.

import { GRID, Weather } from "../engine/util";
import { ITEMS, ItemType, newItem, reloadCost, sellValue } from "../game/items";
import { itemIconUrls } from "../sprites/icons";
import { SaveData, newAgentName, writeSave } from "../game/save";
import { IMPLANTS, IMPLANT_PARTS, ImplantPart, RESEARCH, RESEARCH_ALL, ResearchNode,
         canResearch, implantNodeId, isResearched, itemResearched, noImplants } from "../game/research";
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
  steal: "SEIZE THE CASE", sabotage: "BURN THE MOTOR POOL", hold: "HOLD THE UPLINK", intercept: "INTERCEPT",
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
  onArmory: () => void,
  onResearch: () => void,
  onImplants: () => void
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
      <button id="research" class="ghost">Research</button>
      <button id="implants" class="ghost">Implants</button>
      <button id="armory" class="ghost">Armory</button>
      <button id="launch">Begin Mission</button>
    </div>
  `);
  on(s, "#launch", onLaunch);
  on(s, "#armory", onArmory);
  on(s, "#research", onResearch);
  on(s, "#implants", onImplants);
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
        if (!it) { cells.push(`<div class="arm-slot empty"><img src="${icons.gun}" style="visibility:hidden"><span class="arm-name">&nbsp;</span><span class="arm-bar"></span></div>`); continue; }
        const def = ITEMS[it.type];
        const frac = Math.max(0, Math.min(1, it.charge / def.charge));
        const on = pick && pick.where === "inv" && pick.idx === i ? "on" : "";
        cells.push(
          `<div class="arm-slot pickinv ${on}" data-i="${i}" title="${def.name}">
             <img src="${icons[it.type]}" alt="${def.name}">
             <span class="arm-name">${def.short}</span>
             <span class="arm-bar"><i style="width:${(frac * 100).toFixed(0)}%;background:${frac > 0.25 ? def.color : "#e04040"}"></i></span>
           </div>`
        );
      }
      slots = `<div class="arm-slots">${cells.join("")}</div>`;
    }

    const market = BUY.map((t, i) => {
      // the lab decides the catalogue: an unresearched item shows as a locked
      // silhouette, so the market doubles as a map of what research can open
      if (!itemResearched(save.research, t)) {
        return `<div class="arm-card locked" title="${ITEMS[t].name} - RESEARCH REQUIRED">
                  <img src="${icons[t]}" alt="${ITEMS[t].name}">
                  <span class="arm-name">${ITEMS[t].short}</span>
                  <span class="arm-cost">LAB</span>
                </div>`;
      }
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
      <div class="arm-cols">
        <div class="arm-col">
          <div class="arm-sec">LOADOUT &middot; ${a.name}</div>
          ${slots}
        </div>
        <div class="arm-col">
          <div class="arm-sec">MARKET</div>
          <div class="arm-market">${market}</div>
        </div>
      </div>
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
      writeSave(save);
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
      writeSave(save);
      render();
    });
    on(s, "#act-buy", () => {
      const ag = save.agents[agentIdx];
      if (!pick || pick.where !== "shop" || !ag.alive) return;
      const t = BUY[pick.idx];
      if (!itemResearched(save.research, t)) return;
      if (ag.inv.length >= 8 || save.credits < ITEMS[t].price) return;
      save.credits -= ITEMS[t].price;
      ag.inv.push(newItem(t));
      writeSave(save);
      render();
    });
    on(s, "#hire", () => {
      if (save.credits < HIRE_COST) return;
      save.credits -= HIRE_COST;
      const ag = save.agents[agentIdx];
      ag.alive = true; ag.hp = 100; ag.inv = [newItem("gun")];
      ag.implants = noImplants();   // the chrome went into the ground with the last one
      ag.name = newAgentName(save.agents.map((x) => x.name));
      writeSave(save);
      render();
    });
    on(s, "#done", onDone);
  };
  render();
}

// ---- the lab: a tree of things money turns into capability ----
export function showResearch(save: SaveData, onDone: () => void): void {
  clearScreens();
  let pick: string | null = null;   // selected node id

  const render = () => {
    clearScreens();
    const state = (id: string): "done" | "open" | "locked" =>
      isResearched(save.research, id) ? "done" : canResearch(save.research, id) ? "open" : "locked";

    const node = (n: ResearchNode): string => {
      const st = state(n.id);
      const on = pick === n.id ? "on" : "";
      const cost = st === "done" ? "&#10003;" : `${n.cost}`;
      return `<div class="res-node ${st} ${on}" data-id="${n.id}" title="${n.name}">
                <span class="res-name">${n.name}</span>
                <span class="res-cost">${st === "locked" ? "&#128274;" : cost}</span>
              </div>`;
    };
    const chain = (ids: string[]): string =>
      ids.map((id) => node(RESEARCH_ALL.get(id)!)).join(`<span class="res-link">&#9660;</span>`);

    const branch = (title: string, body: string): string =>
      `<div class="res-branch"><div class="arm-sec">${title}</div>${body}</div>`;

    // implants read as four short chains, MK I to III left to right
    const impRows = IMPLANT_PARTS.map((part) => {
      const line = IMPLANTS[part];
      const marks = [1, 2, 3].map((mk) => {
        const id = implantNodeId(part, mk);
        const st = state(id);
        const on = pick === id ? "on" : "";
        return `<div class="res-node mini ${st} ${on}" data-id="${id}" title="${line.name} MK.${"I".repeat(mk)}">
                  <span class="res-name">MK.${"I".repeat(mk)}</span>
                  <span class="res-cost">${st === "done" ? "&#10003;" : st === "locked" ? "&#128274;" : line.marks[mk - 1].researchCost}</span>
                </div>`;
      }).join("");
      return `<div class="res-imp-row"><span class="res-imp-name">${line.name}</span>${marks}</div>`;
    }).join("");

    // ---- action bar ----
    let bar = `<span class="arm-info dim">SELECT A PROJECT TO FUND</span>`;
    if (pick) {
      const n = RESEARCH_ALL.get(pick)!;
      const st = state(n.id);
      const why = st === "done" ? "RESEARCHED"
        : st === "locked" ? `REQUIRES ${RESEARCH_ALL.get(n.req!)!.name}`
        : save.credits < n.cost ? "NOT ENOUGH CREDITS" : "";
      bar = `<span class="arm-info">${n.name} &middot; ${n.desc}${why ? ` &middot; <b style="color:${st === "done" ? "#4fdc6a" : "#e04040"}">${why}</b>` : ""}</span>
             ${st === "open" ? `<button id="act-res" class="${save.credits >= n.cost ? "buy" : "ghost"}">RESEARCH &minus;${n.cost}</button>` : ""}`;
    }

    const s = screen(`
      <div class="arm-top">
        <h2>RESEARCH</h2>
        <span class="arm-funds">${save.credits}cr</span>
        <span class="arm-spacer"></span>
        <button id="done">Back</button>
      </div>
      <div class="res-cols">
        ${branch("GUNS", chain(["uzi", "shotgun", "minigun"]))}
        ${branch("TECH WEAPONS", chain(["laser", "gauss"]))}
        ${branch("DEFENSE", chain(["medkit", "shield", "psdr"]))}
        ${branch("BODY IMPLANTS", impRows)}
      </div>
      <div class="arm-actbar">${bar}</div>
    `);
    s.classList.add("armory");

    s.querySelectorAll(".res-node").forEach((el) =>
      el.addEventListener("click", () => { pick = (el as HTMLElement).dataset.id ?? null; render(); })
    );
    on(s, "#act-res", () => {
      if (!pick || !canResearch(save.research, pick)) return;
      const n = RESEARCH_ALL.get(pick)!;
      if (save.credits < n.cost) return;
      save.credits -= n.cost;
      save.research.push(n.id);
      writeSave(save);
      render();
    });
    on(s, "#done", onDone);
  };
  render();
}

// ---- the clinic: buy researched implant marks and bolt them into an agent ----
export function showImplants(save: SaveData, onDone: () => void): void {
  clearScreens();
  let agentIdx = save.agents.findIndex((a) => a.alive);
  if (agentIdx < 0) agentIdx = 0;
  let pick: ImplantPart | null = null;

  const render = () => {
    clearScreens();
    const a = save.agents[agentIdx];
    if (!a.implants) a.implants = noImplants();

    const tabs = save.agents.map((ag, i) =>
      `<button class="agent-tab ${i === agentIdx ? "" : "ghost"}" data-i="${i}">${ag.name}${ag.alive ? "" : " &dagger;"}</button>`
    ).join("");

    // the doll: a blocky agent with one tappable region per body part
    const region = (part: ImplantPart, cls: string, label: string): string => {
      const mk = a.implants[part];
      const on = pick === part ? "on" : "";
      return `<div class="doll-part ${cls} ${on} ${mk > 0 ? "chromed" : ""}" data-part="${part}">
                <span class="doll-label">${label}</span>
                <span class="doll-mk">${mk > 0 ? "MK." + "I".repeat(mk) : "&mdash;"}</span>
              </div>`;
    };
    const doll = a.alive ? `
      <div class="doll">
        <div class="doll-head"></div>
        ${region("eyes", "doll-eyes", "EYES")}
        <div class="doll-armrow">
          ${region("arms", "doll-arms", "ARMS")}
          ${region("torso", "doll-torso", "TORSO")}
        </div>
        ${region("legs", "doll-legs", "LEGS")}
      </div>` : `<div class="arm-sec">AGENT DECEASED &middot; HIRE AT THE ARMORY</div>`;

    // catalogue: the four lines with each researched mark as a card
    const lines = IMPLANT_PARTS.map((part) => {
      const line = IMPLANTS[part];
      const cur = a.implants[part];
      const marks = [1, 2, 3].map((mk) => {
        const m = line.marks[mk - 1];
        const researched = isResearched(save.research, implantNodeId(part, mk));
        const fitted = cur >= mk;
        const on = pick === part && !fitted && researched ? "" : "";
        if (!researched) return `<div class="arm-card locked mini" title="${line.name} MK.${"I".repeat(mk)} - RESEARCH REQUIRED">
            <span class="arm-name">MK.${"I".repeat(mk)}</span><span class="arm-cost">LAB</span></div>`;
        if (fitted) return `<div class="arm-card done mini" title="INSTALLED">
            <span class="arm-name">MK.${"I".repeat(mk)}</span><span class="arm-cost">&#10003;</span></div>`;
        const afford = save.credits >= m.price;
        return `<div class="arm-card mini ${afford ? "afford" : "poor"}" title="${m.label}">
            <span class="arm-name">MK.${"I".repeat(mk)}</span><span class="arm-cost">${m.price}</span></div>`;
      }).join("");
      const on = pick === part ? "on" : "";
      return `<div class="imp-line pickpart ${on}" data-part="${part}">
                <span class="imp-name">${line.name}</span>${marks}
              </div>`;
    }).join("");

    // ---- action bar: the next mark for the picked part ----
    let bar = `<span class="arm-info dim">SELECT A BODY PART TO UPGRADE</span>`;
    if (pick && a.alive) {
      const line = IMPLANTS[pick];
      const cur = a.implants[pick];
      if (cur >= 3) {
        bar = `<span class="arm-info">${line.name} &middot; MK.III FITTED &middot; <b style="color:#4fdc6a">FULLY UPGRADED</b></span>`;
      } else {
        const mk = cur + 1;
        const m = line.marks[mk - 1];
        const researched = isResearched(save.research, implantNodeId(pick, mk));
        const why = !researched ? "RESEARCH REQUIRED" : save.credits < m.price ? "NOT ENOUGH CREDITS" : "";
        bar = `<span class="arm-info">${line.name} MK.${"I".repeat(mk)} &middot; ${m.label}${why ? ` &middot; <b style="color:#e04040">${why}</b>` : ""}</span>
               <button id="act-fit" class="${why ? "ghost" : "buy"}">INSTALL &minus;${m.price}</button>`;
      }
    }

    const s = screen(`
      <div class="arm-top">
        <h2>IMPLANTS</h2>
        <span class="arm-funds">${save.credits}cr</span>
        <span class="arm-spacer"></span>
        <button id="done">Back</button>
      </div>
      <div class="arm-tabs">${tabs}</div>
      <div class="imp-cols">
        <div class="arm-col">
          <div class="arm-sec">SUBJECT &middot; ${a.name}</div>
          ${doll}
        </div>
        <div class="arm-col">
          <div class="arm-sec">CATALOGUE</div>
          ${lines}
        </div>
      </div>
      <div class="arm-actbar">${bar}</div>
    `);
    s.classList.add("armory");

    s.querySelectorAll(".agent-tab").forEach((el) =>
      el.addEventListener("click", () => { agentIdx = Number((el as HTMLElement).dataset.i); pick = null; render(); })
    );
    s.querySelectorAll(".doll-part, .imp-line").forEach((el) =>
      el.addEventListener("click", () => { pick = (el as HTMLElement).dataset.part as ImplantPart; render(); })
    );
    on(s, "#act-fit", () => {
      const ag = save.agents[agentIdx];
      if (!pick || !ag.alive) return;
      const cur = ag.implants[pick];
      if (cur >= 3) return;
      const mk = cur + 1;
      const m = IMPLANTS[pick].marks[mk - 1];
      if (!isResearched(save.research, implantNodeId(pick, mk)) || save.credits < m.price) return;
      save.credits -= m.price;
      ag.implants[pick] = mk;
      writeSave(save);
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
