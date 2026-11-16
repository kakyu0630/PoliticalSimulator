// 議員人生モードの画面の入口。状態を持ち、画面を描き直し、操作を計算（src/game/career.ts）に渡す。
// URL に ?seed=7&start=newcomer,minsei,smd,15,local を付けると、その条件ですぐ始まる（確認や共有に使う）。
import "./app.css";
import { loadNameData } from "../data/nameData.js";
import { createWorld } from "../game/roster.js";
import type { Member, MemberFactory } from "../game/roster.js";
import { formInitialGovernment } from "../game/cabinet.js";
import type { Appointment } from "../game/cabinet.js";
import { chooseEvent, govAction, startCareer, takeTurn, upgradeAbility } from "../game/career.js";
import type { CareerState, CareerWorld, OriginId, RouteId } from "../game/career.js";
import type { Ability } from "../game/tables.js";
import { partyById } from "../game/parties.js";
import { PREFECTURES, renderJapanMap } from "../map/japanMap.js";
import { FX, activityIds, activityView, cabinetView, partyView, selfView, setupView, statusBar } from "./views.js";
import type { SetupChoice } from "./views.js";
import { chip, esc, icon, pct } from "./ui.js";

type Tab = "act" | "map" | "party" | "cabinet" | "self";
const TABS: { id: Tab; label: string; icon: string; title: string }[] = [
  { id: "act", label: "活動", icon: "tab-activity", title: "今月の活動" },
  { id: "map", label: "地図", icon: "tab-map", title: "全国の情勢" },
  { id: "party", label: "党内", icon: "tab-party", title: "党内" },
  { id: "cabinet", label: "内閣", icon: "tab-cabinet", title: "内閣" },
  { id: "self", label: "自分", icon: "tab-self", title: "能力と経歴" },
];

interface App {
  seed: number;
  base?: { roster: Member[]; government: Appointment[]; factory: MemberFactory };
  setup: SetupChoice;
  state?: CareerState;
  world?: CareerWorld;
  tab: Tab;
  openTabs: Tab[];
  selected?: string;
  last?: { text: string; fx: string };
  busy: boolean;
  /** 見せた総選挙の数（新しい総選挙があれば結果を出す） */
  electionsShown: number;
  toast?: string;
  mapPref?: number;
}

const params = new URLSearchParams(location.search);
const initialTab = TABS.some((t) => t.id === params.get("tab")) ? (params.get("tab") as Tab) : "act";
const app: App = {
  seed: Number(params.get("seed")) || Math.floor(Math.random() * 100000),
  setup: {},
  tab: initialTab,
  openTabs: [initialTab],
  busy: false,
  electionsShown: 0,
};
const root = document.querySelector<HTMLDivElement>("#app")!;

// ---------- 描画 ----------

function render(): void {
  const { state, world } = app;
  if (!state || !world) {
    root.innerHTML = `<div class="shell"><header class="topbar"><div class="crumb"><div class="diamond"></div><div><span class="crumb-sub">議員人生</span><span class="crumb-main">はじめる</span></div></div></header>
      <main class="view">${app.base ? setupView(app.base.roster, app.setup) : `<p class="cut box">名前データを読み込んでいます…</p>`}</main></div>`;
    return;
  }
  const tab = TABS.find((t) => t.id === app.tab)!;
  const panels = app.openTabs.map((id) => {
    const info = TABS.find((t) => t.id === id)!;
    return `<section class="tab-panel${id === app.tab ? " is-focused" : ""}">
      <header class="tab-panel-head"><h2>${icon(info.icon, 20, info.label)}${info.title}</h2>
        ${app.openTabs.length > 1 ? `<button class="tab-close" data-close-tab="${id}" aria-label="${info.label}を閉じる" title="閉じる">×</button>` : ""}
      </header>
      <div class="tab-panel-body">${tabBody(id)}</div>
    </section>`;
  }).join("");
  root.innerHTML = `<div class="shell">
    <header class="topbar">
      <div class="crumb"><div class="diamond"></div><div><span class="crumb-sub">議員人生 ― ${esc(world.player.name.displayName)}・当選${world.player.terms}回</span><span class="crumb-main">${tab.title}</span></div></div>
      <nav class="tabs" aria-label="画面の切り替え">${TABS.map((t, i) => `<button class="tab${app.openTabs.includes(t.id) ? " is-open" : ""}${t.id === app.tab ? " is-active" : ""}" data-tab="${t.id}" aria-pressed="${app.openTabs.includes(t.id)}">${icon(t.icon, 20, t.label)}${t.label}<kbd>${i + 1}</kbd></button>`).join("")}</nav>
    </header>
    <main class="view"><div class="multi-view">${panels}</div></main>
    <footer class="status">${statusBar(state, world)}</footer>
  </div>
  ${modalHtml()}
  ${app.toast ? `<div class="cut toast" role="status">${esc(app.toast)}</div>` : ""}`;
  if (app.openTabs.includes("map")) mountMap();
}

function tabBody(tab: Tab): string {
  const { state, world } = app;
  if (!state || !world) return "";
  if (tab === "act") return activityView(state, world, app.selected, app.last);
  if (tab === "self") return selfView(state, world);
  if (tab === "party") return partyView(state, world);
  if (tab === "cabinet") return cabinetView(state, world);
  return mapViewShell();
}

function openTab(tab: Tab): void {
  if (!app.openTabs.includes(tab)) {
    if (app.openTabs.length >= 3) {
      const remove = app.openTabs.find((id) => id !== app.tab) ?? app.openTabs[0];
      app.openTabs = app.openTabs.filter((id) => id !== remove);
      app.toast = `${TABS.find((t) => t.id === remove)!.label}を閉じました`;
    }
    app.openTabs.push(tab);
  }
  app.tab = tab;
  render();
}

function closeTab(tab: Tab): void {
  if (app.openTabs.length <= 1) return;
  app.openTabs = app.openTabs.filter((id) => id !== tab);
  if (app.tab === tab) app.tab = app.openTabs[app.openTabs.length - 1];
  render();
}

function mapViewShell(): string {
  const w = app.world!;
  const pref = app.mapPref ?? app.state!.setup.pref;
  const holder = w.roster.find((m) => m.seat === "小選挙区" && m.district === pref);
  const pr = w.roster.filter((m) => m.seat === "比例" && m.home === pref);
  const info = holder
    ? `<b>${esc(PREFECTURES[pref - 1].name)}</b>：${chip(holder.party)} ${esc(holder.name.displayName)}（${esc(partyById(holder.party).short)}・当選${holder.terms}回・地盤${holder.jiban}）${pr.length ? `　比例：${pr.map((m) => esc(m.name.displayName)).join("、")}` : ""}`
    : "";
  return `<div class="page"><section class="cut box"><div id="map"></div><p style="margin:8px 0 0">${info}</p><p class="muted" style="margin:4px 0 0">県を押すと、その県の議員を表示します。枠の太い県が自分の地元です。</p></section></div>`;
}

function mountMap(): void {
  const w = app.world!;
  const el = document.querySelector("#map");
  if (!el) return;
  renderJapanMap(el, {
    cellSize: 14,
    fill: (code) => {
      const m = w.roster.find((x) => x.seat === "小選挙区" && x.district === code);
      return m ? partyById(m.party).color : "#d4d4d8";
    },
    onClick: (code) => {
      app.mapPref = code;
      render();
    },
  });
  const mine = el.querySelector<SVGPathElement>(`path.pref[data-code="${app.state!.setup.pref}"]`);
  if (mine) {
    mine.setAttribute("stroke", "#e61919");
    mine.setAttribute("stroke-width", "4");
  }
}

function modalHtml(): string {
  const { state, world } = app;
  if (!state || !world) return "";
  // 総選挙の結果
  if (state.elections.length > app.electionsShown) {
    const e = state.elections[state.elections.length - 1];
    const district = e.district.length
      ? `<div class="race-bar" style="height:22px;margin:8px 0">${e.district.map((d) => `<i style="width:${d.share * 100}%;background:${partyById(d.party).color}"></i>`).join("")}</div>
        <p>${e.district.map((d) => `${d.isPlayer ? "★" : ""}${esc(d.name)}（${esc(partyById(d.party).short)}）${pct(d.share)}`).join("　")}</p>`
      : `<p>比例名簿 ${e.pr!.rank}位（党の比例当選 ${e.pr!.seats}人）</p>`;
    const seats = e.seats.sort((a, b) => b.total - a.total).map((s) => `${chip(s.party)} ${esc(partyById(s.party).short)} ${s.total}`).join("　");
    const after = state.log.filter((l) => l.date === `${e.year}年${e.month}月` && /政権|党首選|首相|連立|に就いた/.test(l.text)).map((l) => `<li>${esc(l.text)}</li>`).join("");
    return `<div class="overlay"><div class="cut dialog" role="dialog" aria-modal="true">
      <h2>${icon(e.won ? "st-rose" : "ev-reject", 32)} ${e.year}年${e.month}月 総選挙 ― ${e.won ? "当選！" : "落選"}</h2>
      ${district}<p style="font-size:14px">${seats}</p>${after ? `<ul style="font-size:14px">${after}</ul>` : ""}
      <button class="btn primary" data-action="close-election">続ける</button></div></div>`;
  }
  // 出来事の選択肢
  if (state.pendingEvent) {
    const pe = state.pendingEvent;
    return `<div class="overlay"><div class="cut dialog" role="dialog" aria-modal="true"><h2>${esc(pe.title)}</h2><p>${esc(pe.text)}</p>
      <div class="choices">${pe.choices.map((c, i) => `<button class="choice" data-choose="${i}">${i + 1}. ${esc(c)}</button>`).join("")}</div></div></div>`;
  }
  // 引退
  if (state.over) {
    return `<div class="overlay"><div class="cut dialog" role="dialog" aria-modal="true"><h2>${icon("st-rose", 32)} 政治家人生のおわり</h2><p>${esc(state.over)}</p>
      <ul>${state.achievements.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>
      <button class="btn primary" data-action="restart">最初から遊ぶ</button></div></div>`;
  }
  return "";
}

function showToast(text: string): void {
  app.toast = text;
  render();
  window.setTimeout(() => {
    if (app.toast === text) {
      app.toast = undefined;
      render();
    }
  }, 2600);
}

// ---------- 操作 ----------

async function start(): Promise<void> {
  const c = app.setup;
  if (!app.base || !c.origin || !c.party || !c.route || !c.pref || !c.archetype) return;
  app.busy = true;
  try {
    const { state, world } = await startCareer(app.base, { origin: c.origin, party: c.party, route: c.route, pref: c.pref, archetype: c.archetype }, app.seed);
    app.state = state;
    app.world = world;
    app.last = { text: state.log.at(-1)!.text, fx: "" };
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e));
  } finally {
    app.busy = false;
  }
  render();
}

async function doActivity(id: string): Promise<void> {
  const { state, world } = app;
  if (!state || !world || app.busy) return;
  app.busy = true;
  const r = await takeTurn(state, world, id);
  app.busy = false;
  if (!r.ok) {
    showToast(r.message);
    return;
  }
  app.last = { text: r.message, fx: FX[id] ?? "" };
  app.selected = undefined;
  render();
}

function selectActivity(id: string): void {
  if (app.selected === id) void doActivity(id);
  else {
    app.selected = id;
    render();
  }
}

root.addEventListener("click", (ev) => {
  const t = (ev.target as HTMLElement).closest<HTMLElement>("button, [data-tab]");
  if (!t || app.busy) return;
  const d = t.dataset;
  if (d.setup) {
    const key = d.setup as keyof SetupChoice;
    if (key === "pref") {
      app.setup.pref = Number(d.value);
      app.setup.route = d.route as RouteId;
    } else if (key === "route") {
      app.setup.route = d.value as RouteId;
      app.setup.pref = undefined;
    } else {
      (app.setup as Record<string, string>)[key] = d.value!;
      if (key === "origin" || key === "party") {
        app.setup.route = undefined;
        app.setup.pref = undefined;
      }
    }
    render();
  } else if (d.action === "start") void start();
  else if (d.closeTab) closeTab(d.closeTab as Tab);
  else if (d.tab) openTab(d.tab as Tab);
  else if (d.act) selectActivity(d.act);
  else if (d.up) {
    let n = 0;
    for (let i = 0; i < Number(d.times ?? 1); i++) if (upgradeAbility(app.state!, app.world!, d.up as Ability)) n++;
    if (n) showToast(`${d.up}を${n}上げた`);
    else render();
  } else if (d.choose !== undefined) {
    const r = chooseEvent(app.state!, app.world!, Number(d.choose));
    showToast(r.message);
  } else if (d.action === "close-election") {
    app.electionsShown = app.state!.elections.length;
    render();
  } else if (d.action === "toggle-run") {
    app.state!.runForLeader = !app.state!.runForLeader;
    render();
  } else if (d.gov) {
    if (d.gov === "dissolve" && !window.confirm("衆議院を解散して、月末に総選挙を行いますか？")) return;
    const r = govAction(app.state!, app.world!, d.gov, d.arg);
    showToast(r.message);
  } else if (d.action === "restart") location.href = location.pathname;
});

// 数字キーで画面を切り替え、活動の画面では左右キーで選び Enter で実行する。出来事は数字キーで選ぶ
window.addEventListener("keydown", (e) => {
  if (!app.state || !app.world || app.busy || e.altKey || e.ctrlKey || e.metaKey) return;
  if (app.state.pendingEvent) {
    const n = Number(e.key);
    if (n >= 1 && n <= app.state.pendingEvent.choices.length) showToast(chooseEvent(app.state, app.world, n - 1).message);
    return;
  }
  if (app.state.elections.length > app.electionsShown) {
    if (e.key === "Enter" || e.key === " ") {
      app.electionsShown = app.state.elections.length;
      render();
    }
    return;
  }
  const n = Number(e.key);
  if (n >= 1 && n <= TABS.length) {
    openTab(TABS[n - 1].id);
    return;
  }
  if (app.tab !== "act") return;
  const ids = activityIds(app.state, app.world);
  const i = app.selected ? ids.indexOf(app.selected) : -1;
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    e.preventDefault();
    app.selected = ids[(i + (e.key === "ArrowRight" ? 1 : -1) + ids.length) % ids.length];
    render();
  } else if (e.key === "Enter" && app.selected) void doActivity(app.selected);
});

// ---------- 起動 ----------

async function boot(): Promise<void> {
  render();
  const data = await loadNameData();
  const { roster, factory } = await createWorld(data, app.seed);
  app.base = { roster, government: formInitialGovernment(roster), factory };
  const quick = params.get("start");
  if (quick) {
    const [origin, party, route, pref, archetype] = quick.split(",");
    app.setup = { origin: origin as OriginId, party, route: route as RouteId, pref: Number(pref), archetype };
    await start();
    // 確認用：?months=N で、休養と地元回りを交互に N か月進める
    const months = Number(params.get("months") ?? 0);
    for (let i = 0; i < months && app.state && !app.state.over; i++) {
      if (app.state.pendingEvent) chooseEvent(app.state, app.world!, 0);
      await takeTurn(app.state, app.world!, i % 3 === 2 ? "rest" : "local");
    }
    if (params.get("select")) app.selected = params.get("select")!;
    if (months) app.electionsShown = params.get("showElection") ? 0 : app.state?.elections.length ?? 0;
  }
  render();
}

void boot();

// 活動カードの列は、Shift を押さずに通常のホイール操作で横スクロールできる
root.addEventListener("wheel", (ev) => {
  const target = ev.target as HTMLElement;
  const cards = target.closest<HTMLElement>(".cards");
  if (!cards || Math.abs(ev.deltaY) <= Math.abs(ev.deltaX)) return;
  if (cards.scrollWidth <= cards.clientWidth) return;
  cards.scrollLeft += ev.deltaY;
  ev.preventDefault();
}, { passive: false });
