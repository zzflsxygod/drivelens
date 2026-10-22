import "./urlguard";   // first: drops ?api= / ?token= / ?key= from the address before anything else runs
import "./style.css";
import { ic } from "./icons";
import { initPlatform, setRootBack } from "./platform";
import { initWeb, installMode, promptInstall, onInstallChange, isWeb } from "./pwa";
import { isDemo, enterDemo, exitDemo, DEMO_CREDIT, skey } from "./demo";   // first: installs the demo fetch layer before any request
import { t, fmtDateTime as fmtDate, fmtDur, fmtTime, ago as agoIso, monthLabel, fmtNum, langSetting, currentLang, type LangSetting } from "./i18n";
import { testConnection, renderResult, showSetupWizard } from "./setup";
import { ICON } from "./toolbar";
import { initUI, popMenu, closeMenus } from "./ui";
import { initSheets, focusField } from "./sheets";
import { mountNotifications, initNotificationClicks } from "./notify";
import { initOverlayScrollbar } from "./scrollbar";
import { DriveMap, effectiveTheme } from "./map";
import { showReport as renderReport, nowMonth } from "./report";
import { batteryCardHTML, showBattery, type Battery } from "./insights";
import { showDrivesTab, restoreDismissed, type Ctx as JourneyCtx } from "./journey";
import { infiniteList } from "./infinite";
import { initBackToTop, backToTop, isJumped } from "./totop";
import { checkServer, serverReady, onServerInfo, serverInfo, globalBanner, lacks, featureText, tooOldText, serverLabel, APP_VERSION } from "./version";
import { api, setAlias, resetAlias, setCost, resetCost, fmtMoney, defaultCurrency, CURRENCIES, loadSettings, realServer, type Theme, type LabelLang, saveSettings, Car, Charge, ChargePoint, Drive, PathPoint } from "./api";
import { installGuideUrl, RELEASES_URL, ISSUES_URL } from "./links";

const view = document.getElementById("view")!;
const carSel = document.getElementById("car") as HTMLSelectElement;
let map: DriveMap | null = null;

function applyTheme() { document.documentElement.dataset.theme = effectiveTheme(); map?.setTheme(); }
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { document.documentElement.dataset.theme = effectiveTheme(); });
document.documentElement.dataset.theme = effectiveTheme();

const esc = (s: unknown) => String(s ?? "—").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const n = (v: number | null, d = 1) => v == null ? "—" : v.toFixed(d);
const carQ = () => carSel.value ? `&car_id=${carSel.value}` : "";

/** Clickable place name; opens rename dialog when it has an address id. */
function place(name: string | null, addressId: number | null, alias: string | null) {
  if (addressId == null) return esc(name);
  return `<span class="place" data-addr="${addressId}" data-name="${esc(name)}" data-alias="${alias ? 1 : 0}">${esc(name)}<span class="pen">✎</span></span>`;
}

function renameDialog(addressId: number, current: string, hasAlias: boolean, onDone: () => void) {
  const dlg = document.createElement("div");
  dlg.className = "modal";
  dlg.innerHTML = `
    <div class="sheet">
      <h3>${t("alias.title")}</h3>
      <input id="alias" maxlength="200" enterkeyhint="done" autocomplete="off" value="${esc(current)}">
      <p class="muted">${t("alias.hint")}</p>
      <div id="dlgmsg"></div>
      <div class="btns">
        ${hasAlias ? `<button id="reset" class="ghost">${t("alias.reset")}</button>` : ""}
        <button id="cancel" class="ghost">${t("common.cancel")}</button>
        <button id="ok" class="primary small">${t("common.save")}</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);
  const input = dlg.querySelector("#alias") as HTMLInputElement;
  focusField(input, true);
  const close = () => dlg.remove();
  const run = async (fn: () => Promise<unknown>) => {
    try { await fn(); close(); onDone(); }
    catch (e) { dlg.querySelector("#dlgmsg")!.innerHTML = `<div class="error">${esc((e as Error).message)}</div>`; }
  };
  dlg.onclick = e => { if (e.target === dlg) close(); };
  (dlg.querySelector("#cancel") as HTMLElement).onclick = close;
  (dlg.querySelector("#ok") as HTMLElement).onclick = () => {
    const v = input.value.trim();
    if (!v) { dlg.querySelector("#dlgmsg")!.innerHTML = `<div class="error">${t("common.nameEmpty")}</div>`; return; }
    run(() => setAlias(addressId, v));
  };
  input.onkeydown = e => { if (e.key === "Enter") (dlg.querySelector("#ok") as HTMLElement).click(); };
  const reset = dlg.querySelector("#reset") as HTMLElement | null;
  if (reset) reset.onclick = () => run(() => resetAlias(addressId));
}

function costBadge(c: Charge) {
  return c.cost != null ? `<span class="cost${c.cost_source === "manual" ? " manual" : ""}">${fmtMoney(c.cost, c.currency)}</span>` : "";
}

function costDialog(c: Charge, onDone: () => void) {
  const manual = c.cost_source === "manual";
  const cur0 = (manual ? c.currency : null) || c.default_currency || defaultCurrency();
  const opts = [...new Set([cur0, ...CURRENCIES])];
  const kwh = c.charge_energy_added;
  const dlg = document.createElement("div");
  dlg.className = "modal";
  dlg.innerHTML = `
    <div class="sheet">
      <h3>${t("cost.title")}</h3>
      <div class="muted">${esc(c.address)} · ${fmtDate(c.start_date)} · ${kwh != null ? `${kwh.toFixed(2)} kWh` : ""}</div>
      <div class="cost-row">
        <input id="amount" type="number" inputmode="decimal" min="0" step="any" placeholder="${t("cost.amount")}" value="${manual && c.cost != null ? c.cost : ""}">
        <select id="cur">${opts.map(o => `<option${o === cur0 ? " selected" : ""}>${o}</option>`).join("")}</select>
      </div>
      <div id="unit" class="muted"></div>
      <input id="note" maxlength="500" placeholder="${t("common.noteOptional")}" value="${esc(manual ? c.cost_note ?? "" : "").replace(/^—$/, "")}">
      <p class="muted">${c.teslamate_cost != null ? t("cost.tmRecorded", { c: fmtMoney(c.teslamate_cost, c.default_currency) }) : t("cost.tmNone")}${t("cost.manualNote")}</p>
      <div id="dlgmsg"></div>
      <div class="btns">
        ${manual ? `<button id="reset" class="ghost">${t("cost.delete")}</button>` : ""}
        <button id="cancel" class="ghost">${t("common.cancel")}</button>
        <button id="ok" class="primary small">${t("common.save")}</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);
  const amount = dlg.querySelector("#amount") as HTMLInputElement;
  const cur = dlg.querySelector("#cur") as HTMLSelectElement;
  const unit = () => {
    const v = parseFloat(amount.value);
    dlg.querySelector("#unit")!.textContent = v >= 0 && kwh ? t("common.unitPrice", { p: fmtMoney(v / kwh, cur.value, true) }) : "";
  };
  amount.oninput = unit; cur.onchange = unit; unit();
  focusField(amount);
  const close = () => dlg.remove();
  const msg = (s: string) => { dlg.querySelector("#dlgmsg")!.innerHTML = `<div class="error">${esc(s)}</div>`; };
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); close(); onDone(); } catch (e) { msg((e as Error).message); } };
  dlg.onclick = e => { if (e.target === dlg) close(); };
  (dlg.querySelector("#cancel") as HTMLElement).onclick = close;
  (dlg.querySelector("#ok") as HTMLElement).onclick = () => {
    const v = parseFloat(amount.value);
    if (!(v >= 0) || v >= 1e9) return msg(t("cost.invalid"));
    const note = (dlg.querySelector("#note") as HTMLInputElement).value.trim();
    run(() => setCost(c.id, v, cur.value, note || null));
  };
  amount.onkeydown = e => { if (e.key === "Enter") (dlg.querySelector("#ok") as HTMLElement).click(); };
  const reset = dlg.querySelector("#reset") as HTMLElement | null;
  if (reset) reset.onclick = () => run(() => resetCost(c.id));
}

function bindPlaces(refresh: () => void) {
  view.querySelectorAll<HTMLElement>(".place").forEach(el => el.onclick = () =>
    renameDialog(Number(el.dataset.addr), el.dataset.name || "", el.dataset.alias === "1", refresh));
}


function destroyMap() { map?.destroy(); map = null; }
function showError(e: unknown) { view.innerHTML = `<div class="error">${ic("alert")}${esc((e as Error).message)}</div>`; }
function loading() { destroyMap(); view.innerHTML = `<div class="muted">${t("common.loading")}</div>`; }

async function loadCars() {
  try {
    const cars = await api<Car[]>("/api/cars");
    carList = cars;
    const keep = carSel.value;
    carSel.innerHTML = cars.map(c => `<option value="${c.id}">${esc(carName(c))}</option>`).join("");
    if (keep && cars.some(c => String(c.id) === keep)) carSel.value = keep;
    syncCarPill();
  } catch { carPill.hidden = true; }
}
let carList: Car[] = [];
const carPill = document.getElementById("carpill") as HTMLButtonElement;
const carName = (c: Car) => c.name || c.marketing_name || `Car ${c.id}`;
const carSub = (c: Car) => { const m = c.marketing_name || (c.model ? `Model ${c.model}` : ""); return m && m !== carName(c) ? m : ""; };
function syncCarPill() {
  const c = carList.find(x => String(x.id) === carSel.value) ?? carList[0];
  carPill.hidden = !c;
  if (!c) return;
  const multi = carList.length > 1;
  carPill.classList.toggle("single", !multi);
  carPill.innerHTML = `${ICON.car}<span>${esc(carName(c))}</span>${multi ? ICON.chev : ""}`;
  carPill.title = carSub(c) || carName(c);
  carPill.setAttribute("aria-label", carName(c));
}
carPill.onclick = () => {
  if (carList.length < 2) return;
  popMenu(carPill, carList.map(c => ({ value: String(c.id), label: carName(c), sub: carSub(c), active: String(c.id) === carSel.value })), v => {
    if (v === carSel.value) return;
    carSel.value = v; syncCarPill(); carSel.onchange?.(new Event("change"));
  });
};

function showDrives() { showDrivesTab(journeyCtx); }

async function showDrive(id: number, back: () => void = showDrives) {
  loading();
  try {
    const [d, pts] = await Promise.all([api<Drive>(`/api/drives/${id}`), api<PathPoint[]>(`/api/drives/${id}/path`)]);
    view.innerHTML = `
      <button class="back">${t("common.back")}</button>
      <h2>${place(d.start_address, d.start_address_id, d.start_alias)} → ${place(d.end_address, d.end_address_id, d.end_alias)}</h2>
      <div class="muted">${fmtDate(d.start_date)} – ${fmtDate(d.end_date)} · ${t("common.tapPlace")}</div>
      <div id="map"></div>
      <div class="grid">
        <div><small>${t("f.distance")}</small><b>${n(d.distance_km)} km</b></div>
        <div><small>${t("f.duration")}</small><b>${fmtDur(d.duration_min)}</b></div>
        <div><small>${t("f.energy")}</small><b>${n(d.energy_kwh, 2)} kWh</b></div>
        <div><small>${t("f.efficiency")}</small><b>${n(d.efficiency_wh_km, 0)} Wh/km</b></div>
        <div><small>${t("f.maxSpeed")}</small><b>${d.speed_max ?? "—"} km/h</b></div>
        <div><small>${t("f.battery")}</small><b>${d.start_battery_level ?? "—"}% → ${d.end_battery_level ?? "—"}%</b></div>
      </div>`;
    (view.querySelector(".back") as HTMLElement).onclick = back;
    bindPlaces(() => showDrive(id, back));
    map = new DriveMap(document.getElementById("map")!, { route: pts.map(p => [p.lng, p.lat] as [number, number]) });
  } catch (e) { showError(e); }
}

async function showCharges(restore = false) {
  destroyMap();
  const car = await currentCarId().catch(() => null);
  view.innerHTML = `<div class="list-toolbar"><h2 class="tb-title">${t("charges.title")}</h2><div class="tb-right" id="c-tb"></div></div><div id="clist"></div>`;
  const list = infiniteList<Charge>({
    container: document.getElementById("clist")!, toolbar: document.getElementById("c-tb")!, key: `charges:${car ?? "all"}`, path: `/api/charges?x=1${carQ()}`,
    paging: !lacks("paging"), carId: car, monthsSupported: !lacks("paging"), restore,
    dateOf: c => c.start_date, empty: t("charges.empty"),
    header: (m, tot, loaded) => {
      const byCur = new Map<string, number>();
      for (const c of loaded) if (c.cost != null) { const k = c.currency || defaultCurrency(); byCur.set(k, (byCur.get(k) ?? 0) + c.cost); }
      const cost = byCur.size ? " · " + [...byCur].map(([k, v]) => fmtMoney(v, k)).join(" + ") : "";
      return `<b>${monthLabel(m)}</b><span>${tot ? t("charges.monthHead", { n: tot.charge_count, kwh: n(tot.energy_added_kwh, 0) }) : t("charges.monthHead", { n: loaded.length, kwh: n(loaded.reduce((a, c) => a + (c.charge_energy_added ?? 0), 0), 0) })}${cost}</span>`;
    },
    card: c => `
      <div class="card" data-id="${c.id}">
        <div class="row"><b>${esc(c.address)}</b>${costBadge(c)}</div>
        <div class="row muted">${fmtDate(c.start_date)} · ${fmtDur(c.duration_min)}</div>
        <div class="bar"><div style="left:${c.start_battery_level ?? 0}%;width:${(c.end_battery_level ?? 0) - (c.start_battery_level ?? 0)}%"></div></div>
        <div class="stats">
          <span>${ic("bolt")} +${n(c.charge_energy_added, 2)} kWh</span>
          <span>${ic("battery")} ${c.start_battery_level ?? "—"}% → ${c.end_battery_level ?? "—"}%</span>
        </div>
      </div>`,
    bind: root => root.querySelectorAll<HTMLElement>(".card[data-id]").forEach(el => el.onclick = () => {
      list.leave(); window.scrollTo(0, 0); showCharge(Number(el.dataset.id), () => showCharges(true));
    }),
  });
}

/** SVG chart: power (kW, filled area, left axis) + battery % (line, right axis). */
function chargeChart(points: ChargePoint[]): string {
  const pts = points
    .map(p => ({ t: Date.parse(p.date), kw: p.power_kw ?? (p.charger_power != null && p.charger_power > 0 ? p.charger_power : null), soc: p.battery_level, src: p.power_source }))
    .filter(p => !Number.isNaN(p.t));
  const hasPower = pts.some(p => (p.kw ?? 0) > 0), hasSoc = pts.some(p => p.soc != null);
  if (pts.length < 2 || (!hasPower && !hasSoc)) return `<div class="chart-empty">${t("chart.noCurve")}</div>`;
  const W = 360, H = 150, L = 34, R = 30, T = 10, B = 22, iw = W - L - R, ih = H - T - B;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1, span = Math.max(1, t1 - t0);
  const maxKw = Math.max(5, ...pts.map(p => p.kw ?? 0));
  const niceMax = maxKw > 100 ? Math.ceil(maxKw / 50) * 50 : maxKw > 20 ? Math.ceil(maxKw / 10) * 10 : Math.ceil(maxKw / 2) * 2;
  const x = (t: number) => L + (t - t0) / span * iw;
  const yKw = (v: number) => T + ih - v / niceMax * ih;
  const ySoc = (v: number) => T + ih - v / 100 * ih;
  const kwPts = pts.filter(p => p.kw != null);
  const area = hasPower ? `M${x(kwPts[0].t).toFixed(1)},${yKw(0)} ` + kwPts.map(p => `L${x(p.t).toFixed(1)},${yKw(p.kw!).toFixed(1)}`).join(" ") + ` L${x(kwPts[kwPts.length - 1].t).toFixed(1)},${yKw(0)} Z` : "";
  const socPts = pts.filter(p => p.soc != null);
  const socLine = hasSoc ? socPts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${ySoc(p.soc!).toFixed(1)}`).join(" ") : "";
  const time = (v: number) => fmtTime(v);
  const grid = [0, 0.5, 1].map(f => `<line x1="${L}" x2="${W - R}" y1="${T + ih * (1 - f)}" y2="${T + ih * (1 - f)}" class="cg"/>
      <text x="${L - 4}" y="${T + ih * (1 - f) + 4}" text-anchor="end" class="ct">${Math.round(niceMax * f)}</text>
      <text x="${W - R + 4}" y="${T + ih * (1 - f) + 4}" class="ct soc">${Math.round(100 * f)}%</text>`).join("");
  const derived = pts.some(p => p.src === "energy_delta" || p.src === "voltage_current");
  const peak = hasPower ? Math.max(...kwPts.map(p => p.kw!)) : null;
  return `<div class="chart-box">
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${t("chart.curveAria")}">
      ${grid}
      ${hasPower ? `<path d="${area}" class="ca"/>` : ""}
      ${hasSoc ? `<path d="${socLine}" class="cl"/>` : ""}
      <text x="${L}" y="${H - 6}" class="ct">${time(t0)}</text>
      <text x="${W - R}" y="${H - 6}" text-anchor="end" class="ct">${time(t1)}</text>
    </svg>
    <div class="legend"><span><i class="lg-kw"></i>${t("chart.power")}${peak != null ? t("chart.peak", { v: peak.toFixed(0) }) : ""}</span><span><i class="lg-soc"></i>${t("chart.soc")}</span></div>
    ${!hasPower ? `<div class="muted small-note">${t("chart.noPower")}</div>` : derived ? `<div class="muted small-note">${t("chart.derived")}</div>` : ""}
  </div>`;
}

async function showCharge(id: number, back: () => void = () => showCharges(true)) {
  loading();
  try {
    const c = await api<Charge & { points: ChargePoint[] }>(`/api/charges/${id}`);
    view.innerHTML = `
      <button class="back">${t("common.back")}</button>
      <h2>${place(c.address, c.address_id, c.alias)}</h2>
      <div class="muted">${fmtDate(c.start_date)} – ${fmtDate(c.end_date)} · ${t("common.tapPlace")}</div>
      <div class="grid">
        <div><small>${t("charge.added")}</small><b>${n(c.charge_energy_added, 2)} kWh</b></div>
        <div><small>${t("charge.used")}</small><b>${n(c.charge_energy_used, 2)} kWh</b></div>
        <div class="cost-cell" id="costcell" title="${t("charge.costEdit")}"><small>${t("charge.cost")}${c.cost_source === "manual" ? t("charge.manual") : c.cost_source === "teslamate" ? " · TeslaMate" : ""}</small>
          <b>${fmtMoney(c.cost, c.currency)} <span class="pen">✎</span></b>
          ${c.cost != null && c.charge_energy_added ? `<span class="muted unit">${t("common.unitPrice", { p: fmtMoney(c.cost / c.charge_energy_added, c.currency, true) })}</span>` : ""}
          ${c.cost_note ? `<span class="muted unit">${esc(c.cost_note)}</span>` : ""}</div>
        <div><small>${t("f.duration")}</small><b>${fmtDur(c.duration_min)}</b></div>
        <div><small>${t("f.battery")}</small><b>${c.start_battery_level}% → ${c.end_battery_level}%</b></div>
        <div><small>${t("charge.temp")}</small><b>${n(c.outside_temp_avg)} °C</b></div>
      </div>
      <h3>${t("charge.curve")}</h3>
      ${chargeChart(c.points)}
      ${c.latitude != null ? `<div id="map" class="small"></div>` : ""}`;
    (view.querySelector(".back") as HTMLElement).onclick = back;
    bindPlaces(() => showCharge(id, back));
    (document.getElementById("costcell") as HTMLElement).onclick = () => lacks("costs")
      ? showBanner(featureText("costs")) : costDialog(c, () => showCharge(id, back));
    if (c.latitude != null && c.longitude != null) {
      map = new DriveMap(document.getElementById("map")!, { point: [c.longitude, c.latitude] });
    }
  } catch (e) { showError(e); }
}

function demoSettingsCard() {
  const real = realServer().apiUrl;
  return `<div class="card demo-card on">
    <b>${ic("spark")} ${t("demo.title")}</b>
    <p class="small">${t("demo.on")}</p>
    <p class="muted small">${real ? t("demo.backTo", { u: esc(real) }) : t("demo.backWizard")}<br>${t("demo.mapNote")}</p>
    <button id="demo-exit" class="primary">${t("demo.exitBtn")}</button>
    <p class="muted tiny">${esc(DEMO_CREDIT)}</p></div>`;
}
/** Publishes the real height of the sticky header (safe-area padding + car pill + demo strip) as --hdr-h,
 *  so everything that sticks below it (server banner, month headers, page heads) lines up exactly instead of
 *  relying on a hard-coded guess. */
function trackHeaderHeight() {
  const h = document.querySelector("body > header") as HTMLElement | null;
  if (!h) return;
  const set = () => { const v = Math.round(h.getBoundingClientRect().height); if (v > 0) document.body.style.setProperty("--hdr-h", `${v}px`); };
  set();
  if ("ResizeObserver" in window) new ResizeObserver(set).observe(h); else addEventListener("resize", set);
}
/** Slim persistent strip at the bottom of the header while demo mode is active.
 *  It lives *inside* the sticky header (not as a separately sticky sibling), so it can never drift. */
function mountDemoBanner() {
  if (!isDemo()) return;
  document.body.classList.add("demo");
  const b = document.createElement("div");
  b.id = "demo-banner"; b.className = "demo-banner"; b.setAttribute("role", "status");
  b.innerHTML = `<span class="demo-dot"></span><b>${t("demo.banner")}</b><span class="demo-sub">· ${t("demo.bannerSub")}</span><button type="button">${t("demo.exit")}</button>`;
  (b.querySelector("button") as HTMLElement).onclick = () => exitDemo();
  document.querySelector("header")!.append(b);
}

/** Settings › Server. Once a server is saved it collapses into one compact row (status dot, host, versions);
 *  tapping it expands the address / token / save & test / check controls. Demo mode: version line only. */
function serverSectionHTML(url: string, token: string) {
  const title = `<div class="section-title"><span>${t("set.server")}</span></div>`;
  const verBox = `<div class="version-box"><span class="muted">App <code>v${esc(APP_VERSION)}</code> · ${t("set.server")} <code id="srv-ver">${esc(serverLabel())}</code></span><button id="srv-check" class="ghost small">${t("set.check")}</button></div>`;
  if (isDemo()) return title + verBox;
  return `${title}
    <div class="card srv-card" id="srv-card">
      <button type="button" class="srv-head" id="srv-toggle" aria-expanded="false" aria-controls="srv-body">
        <span class="srv-dot" id="srv-dot" aria-hidden="true"></span>
        <span class="srv-main"><b class="srv-host" id="srv-host">${esc(hostOf(url) || t("set.srvNone"))}</b>
          <span class="srv-meta"><span class="srv-state" id="srv-state"></span><span class="srv-ver">App v${esc(APP_VERSION)} · ${t("set.server")} <span id="srv-sv">—</span></span></span></span>
        <svg class="srv-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
      </button>
      <div class="srv-body" id="srv-body" role="region" aria-labelledby="srv-toggle"><div><div class="srv-inner">
        ${verBox}
        <label>${t("set.apiUrl")}<input id="url" placeholder="https://drivelens.example.com" value="${esc(url)}"></label>
        <label>API Token<input id="token" type="password" value="${esc(token)}"></label>
        <button id="save" class="primary">${t("set.saveTest")}</button>
        <div id="msg"></div></div></div></div>
    </div>
    <div class="card demo-card"><div class="demo-card-row"><div><b>${ic("spark")} ${t("demo.title")}</b><p class="muted small">${t("demo.enterHint")}</p></div>
      <button id="demo-enter" class="ghost small">${t("demo.enterBtn")}</button></div></div>`;
}
const hostOf = (u: string) => { try { return new URL(u).host; } catch { return u; } };
let srvTouched = false;   // the user opened / closed it himself → don't auto-expand any more
function setServerOpen(open: boolean) {
  const card = document.getElementById("srv-card"), btn = document.getElementById("srv-toggle");
  if (!card || !btn) return;
  card.classList.toggle("open", open); btn.setAttribute("aria-expanded", String(open));
  card.querySelectorAll<HTMLElement>("#srv-body input, #srv-body button").forEach(e => { e.tabIndex = open ? 0 : -1; });
}
/** Refresh the compact row (and the version line) from the current /health state. */
function paintServerHead() {
  const v = document.getElementById("srv-ver"); if (v) v.textContent = serverLabel();
  const dot = document.getElementById("srv-dot"), st = document.getElementById("srv-state"), sv = document.getElementById("srv-sv");
  if (!dot || !st || !sv) return;
  const s = loadSettings(), i = serverInfo();
  const host = document.getElementById("srv-host"); if (host) host.textContent = hostOf(s.apiUrl || "") || t("set.srvNone");
  const cfg = !!(s.apiUrl && s.token);
  const k = !cfg ? "none" : i.state === "ok" || i.state === "legacy" ? "ok" : i.state === "unreachable" ? "err" : "wait";
  dot.className = `srv-dot is-${k}`;
  st.className = `srv-state is-${k}`;
  st.textContent = k === "ok" ? t("set.srvOk") : k === "err" ? t("set.srvErr") : k === "none" ? t("set.srvNoneShort") : t("common.checking");
  sv.textContent = i.state === "ok" ? `v${i.version ?? "?"}` : i.state === "legacy" ? "<0.5.1" : "—";
  if (!srvTouched && (k === "err" || k === "none")) setServerOpen(true);
}
function bindServerSection(configured: boolean) {
  const btn = document.getElementById("srv-toggle"); if (!btn) return;
  srvTouched = false;
  setServerOpen(!configured);
  btn.onclick = () => { srvTouched = true; setServerOpen(btn.getAttribute("aria-expanded") !== "true"); };
  paintServerHead();
}
onServerInfo(() => paintServerHead());

function showSettings() {
  destroyMap();
  const s = loadSettings();
  view.innerHTML = `
    <h2 class="tb-title set-title">${t("set.title")}</h2>
    ${isDemo() ? demoSettingsCard() : ""}
    <div class="section-title"><span>${t("set.display")}</span></div>
    <div class="card set-group">
    <label>${t("set.language")}<select id="uilang">
      <option value="auto">${t("set.langAuto")}</option><option value="zh">中文</option><option value="en">English</option><option value="ja">日本語</option>
    </select></label>
    <label>${t("set.theme")}<select id="theme">
      <option value="auto">${t("set.themeAuto")}</option><option value="light">${t("set.themeLight")}</option><option value="dark">${t("set.themeDark")}</option>
    </select></label>
    <label>${t("set.mapLang")}<select id="lang">
      <option value="">${t("set.mapLangAuto")}</option><option value="ja">日本語</option><option value="zh">中文</option><option value="en">English</option><option value="local">${t("set.mapLangLocal")}</option>
    </select></label>
    <label>${t("set.currency")}<select id="currency">${CURRENCIES.map(c => `<option>${c}</option>`).join("")}</select></label>
    <p class="muted">${t("set.currencyHint")}</p>
    <p class="muted">${t("set.mapCredit")}</p>
    </div>
    <div class="section-title"><span>${t("seg.journeys")}</span></div>
    <div class="card set-group">
    <label>${t("set.gap")}<select id="jgap">${[30, 60, 90, 120, 180, 240].map(m => `<option value="${m}">${t("set.minutes", { n: m })}</option>`).join("")}</select></label>
    <p class="muted">${t("set.gapHint")}</p>
    <label class="chk-row"><input type="checkbox" id="sgon"> ${t("set.suggestOn")}</label>
    <p><button id="sgrestore" class="ghost small">${t("set.suggestRestore")}</button> <span id="sgmsg" class="muted"></span></p>
    </div>
    <div id="notify-slot"></div>
    <div id="pwa-slot"></div>
    ${serverSectionHTML(s.apiUrl || "", s.token || "")}
    ${aboutCardHTML()}
    ${supportCardHTML()}`;
  mountInstallCard();
  mountNotifications(document.getElementById("notify-slot")!);
  (document.getElementById("srv-check") as HTMLElement).onclick = () => { document.getElementById("srv-ver")!.textContent = t("common.checking"); checkServer().then(paintServerHead); };
  bindServerSection(!!(s.apiUrl && s.token));
  const themeSel = document.getElementById("theme") as HTMLSelectElement;
  const langSel = document.getElementById("lang") as HTMLSelectElement;
  themeSel.value = s.theme ?? "auto"; langSel.value = s.labelLang ?? "";
  const uiSel = document.getElementById("uilang") as HTMLSelectElement;
  uiSel.value = langSetting();
  uiSel.onchange = () => {
    saveSettings({ ...loadSettings(), uiLang: uiSel.value as LangSetting });   // "auto" is stored too (absent = pre-v0.11 install)
    location.reload();   // every view re-renders in the new language
  };
  themeSel.onchange = () => { saveSettings({ ...loadSettings(), theme: themeSel.value as Theme }); applyTheme(); };
  const gapSel = document.getElementById("jgap") as HTMLSelectElement;
  gapSel.value = String(s.journeyGap ?? 60);
  gapSel.onchange = () => saveSettings({ ...loadSettings(), journeyGap: Number(gapSel.value) });
  const sgOn = document.getElementById("sgon") as HTMLInputElement;
  sgOn.checked = !s.suggestionsOff;
  sgOn.onchange = () => saveSettings({ ...loadSettings(), suggestionsOff: !sgOn.checked });
  (document.getElementById("sgrestore") as HTMLElement).onclick = async () => {
    document.getElementById("sgmsg")!.textContent = "…";
    document.getElementById("sgmsg")!.textContent = await restoreDismissed(journeyCtx);
  };
  const curSel = document.getElementById("currency") as HTMLSelectElement;
  curSel.value = defaultCurrency();
  curSel.onchange = () => saveSettings({ ...loadSettings(), currency: curSel.value });
  langSel.onchange = () => {
    const ns = { ...loadSettings() };
    if (langSel.value) ns.labelLang = langSel.value as LabelLang; else delete ns.labelLang;
    saveSettings(ns);
  };
  const demoBtn = document.getElementById("demo-enter") ?? document.getElementById("demo-exit");
  if (demoBtn) demoBtn.onclick = () => isDemo() ? exitDemo() : enterDemo();
  if (isDemo()) return;
  (document.getElementById("save") as HTMLElement).onclick = async () => {
    const msg = document.getElementById("msg")!;
    const urlIn = document.getElementById("url") as HTMLInputElement, tokIn = document.getElementById("token") as HTMLInputElement;
    msg.innerHTML = `<div class="muted">${t("set.testing")}</div>`;
    const r = await testConnection(urlIn.value, tokIn.value.trim());
    msg.innerHTML = renderResult(r);
    if (!r.ok) return;   // keep the old working settings when the new ones fail
    urlIn.value = r.url;
    saveSettings({ ...loadSettings(), apiUrl: r.url, token: tokIn.value.trim() });
    checkServer().then(paintServerHead);
    loadCars();
  };
}


// ---------------- Settings extras: install as app (web) + support / donation ----------------
/** Build-time donation page (VITE_DONATE_URL). Empty → no card at all. */
const DONATE_URL = (import.meta.env.VITE_DONATE_URL ?? "").trim();
function donateLabel(u: string) {
  const h = (() => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } })();
  if (/buymeacoffee\.com$/.test(h)) return "Buy me a coffee";
  if (/ko-fi\.com$/.test(h)) return "Ko-fi";
  if (/github\.com$/.test(h)) return "GitHub Sponsors";
  return t("don.btn");
}
function aboutCardHTML() {
  const row = (href: string, ico: string, label: string) =>
    `<a class="about-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer"><span class="about-ico" aria-hidden="true">${ico}</span><span>${label}</span><span class="about-go" aria-hidden="true">›</span></a>`;
  return `<div class="section-title"><span>${t("about.title")}</span></div><div class="card about-card">
    ${row(installGuideUrl(), ic("book"), t("about.guide"))}${row(RELEASES_URL, ic("box"), t("about.releases"))}${row(ISSUES_URL, ic("chat"), t("about.feedback"))}</div>`;
}
function supportCardHTML() {
  if (!/^https:\/\//.test(DONATE_URL)) return "";
  if (import.meta.env.VITE_DONATE_WEB_ONLY === "1" && !isWeb()) return "";
  return `<div class="card support-card"><div class="support-ico" aria-hidden="true">${ic("coffee")}</div>
    <div class="support-body"><b>${t("don.title")}</b><p class="muted small">${t("don.text")}</p>
    <a class="support-btn" href="${esc(DONATE_URL)}" target="_blank" rel="noopener noreferrer">${esc(donateLabel(DONATE_URL))} <span aria-hidden="true">→</span></a></div></div>`;
}
function mountInstallCard() {
  const slot = document.getElementById("pwa-slot"); if (!slot) return;
  const render = () => {
    const m = installMode();
    slot.innerHTML = !m ? "" : `<div class="card demo-card install-card"><div class="demo-card-row"><div><b>${ic("phone")} ${t("pwa.title")}</b>
      <p class="muted small">${m === "ios" ? t("pwa.ios") : t("pwa.text")}</p></div>
      ${m === "prompt" ? `<button id="pwa-install" class="ghost small">${t("pwa.btn")}</button>` : ""}</div></div>`;
    const b = document.getElementById("pwa-install");
    if (b) b.onclick = () => { void promptInstall(); };
  };
  render(); onInstallChange(() => { if (slot.isConnected) render(); });
}

// ---------------- Home (首页) ----------------
interface Summary {
  car: { id: number; name: string | null; model: string | null; marketing_name: string | null; trim_badging: string | null;
         exterior_color: string | null; wheel_type: string | null; vin: string | null; efficiency: number | null };
  state: { state: string | null; since: string | null } | null;
  position: { date: string | null; latitude: number | null; longitude: number | null; battery_level: number | null;
              usable_battery_level: number | null; rated_battery_range_km: number | null; ideal_battery_range_km: number | null;
              est_battery_range_km: number | null; odometer_km: number | null; outside_temp: number | null;
              inside_temp: number | null; speed: number | null } | null;
  location: { name: string | null; address_id: number | null; source: string } | null;
  software: { version: string | null; installed_at: string | null } | null;
  last_drive: Drive | null; last_charge: Charge | null;
  stats: { total_distance_km: number | null; drive_count: number | null; charge_count: number | null;
           total_energy_added_kwh: number | null; total_cost: number | null; costs?: CurAmt[] };
  this_month: { month: string | null; distance_km: number | null; drive_count: number | null; drive_energy_kwh: number | null;
                charge_count: number | null; charge_energy_added_kwh: number | null; charge_cost: number | null; charge_costs?: CurAmt[] };
}

interface CurAmt { currency: string; amount: number; count: number }
/** Per-currency sums (each shown separately); falls back to the legacy single total. */
const costSum = (list: CurAmt[] | undefined, legacy: number | null) =>
  list ? (list.length ? list.map(x => fmtMoney(x.amount, x.currency)).join("<br>") : "—") : fmtMoney(legacy);

const STATE_CLS: Record<string, string> = { online: "st-online", asleep: "st-asleep", offline: "st-offline", driving: "st-online" };
const COLORS = ["PearlWhite", "SolidBlack", "MidnightSilver", "DeepBlue", "RedMulticoat", "Red", "StealthGrey", "QuicksilverGrey", "UltraRed", "Black", "White", "Silver", "Blue"] as const;
const colorLabel = (c: string) => (COLORS as readonly string[]).includes(c) ? t(`color.${c}` as `color.${typeof COLORS[number]}`) : c;

function ago(iso: string | null) { return iso ? agoIso(iso) : ""; }

type Status = Pick<Summary, "car" | "state" | "position" | "software">;
type Activity = Pick<Summary, "location" | "last_drive" | "last_charge">;
type StatsData = Pick<Summary, "stats" | "this_month">;
interface HomeCache { status?: Status; activity?: Activity; stats?: StatsData; savedAt?: number }

const LAST_CAR_KEY = skey("drivelens-last-car");   // demo mode has its own namespace
const homeCacheKey = (id: number) => skey(`drivelens-home-${id}`);
function readHomeCache(id: number): HomeCache {
  try { return JSON.parse(localStorage.getItem(homeCacheKey(id)) || "{}"); } catch { return {}; }
}
function writeHomeCache(id: number, patch: HomeCache) {
  try { localStorage.setItem(homeCacheKey(id), JSON.stringify({ ...readHomeCache(id), ...patch, savedAt: Date.now() })); } catch { /* quota */ }
}

/** Car to show without waiting for the network: selector value, else last used, else 1st from list. */
async function currentCarId(): Promise<number | null> {
  if (carSel.value) return Number(carSel.value);
  const last = Number(localStorage.getItem(LAST_CAR_KEY));
  if (last) {
    loadCars().then(() => {
      if (!carSel.options.length) return;
      if ([...carSel.options].some(o => o.value === String(last))) { carSel.value = String(last); syncCarPill(); return; }
      // the remembered car is not on this server (removed, other server): switch to the first one and re-render
      localStorage.setItem(LAST_CAR_KEY, carSel.value); syncCarPill();
      (document.querySelector("nav button.active") as HTMLElement | null)?.click();
    });
    return last;
  }
  await loadCars();
  return carSel.value ? Number(carSel.value) : null;
}

const sk = (w = "60%", h = "14px") => `<span class="sk" style="width:${w};height:${h}"></span>`;
const skCard = () => `<div class="card sk-card">${sk("70%", "16px")}<br>${sk("45%")}<br>${sk("85%")}</div>`;
const skGrid = (n: number) => `<div class="grid">${Array.from({ length: n }, () => `<div>${sk("50%", "10px")}<br>${sk("70%", "16px")}</div>`).join("")}</div>`;

function heroHTML(s: Status) {
  const p = s.position, c = s.car;
  const driving = s.state?.state === "online" && (p?.speed ?? 0) > 0;
  const stKey = driving ? "driving" : s.state?.state ?? "";
  const [stLabel, stCls] = STATE_CLS[stKey] ? [t(`state.${stKey}` as "state.online"), STATE_CLS[stKey]] : [t("state.unknown"), "st-offline"];
  const lvl = p?.battery_level ?? null;
  const lvlCls = lvl == null ? "" : lvl < 20 ? "low" : lvl < 50 ? "mid" : "";
  const model = c.marketing_name || (c.model ? `Model ${c.model}` : "");
  const extras = [c.exterior_color ? colorLabel(c.exterior_color) : null, c.wheel_type].filter(Boolean).join(" · ");
  return `
    <div class="row"><div>
      <div class="car-name">${esc(c.name || `Car ${c.id}`)}</div>
      <div class="muted">${esc(model)}${extras ? ` · ${esc(extras)}` : ""}</div>
    </div><button class="icon-btn" data-refresh title="${t("common.refresh")}">⟳</button></div>
    <div class="badge ${stCls}">${stLabel}${s.state?.since ? t("hero.since", { t: ago(s.state.since) }) : ""}</div>
    <div class="gauge-row">
      <div class="pct">${lvl ?? "—"}<small>%</small></div>
      <div class="range"><b>${n(p?.rated_battery_range_km ?? null, 0)}</b> km<div class="muted">${t("hero.est", { v: n(p?.est_battery_range_km ?? null, 0) })}</div></div>
    </div>
    <div class="gauge"><div class="${lvlCls}" style="width:${lvl ?? 0}%"></div></div>
    ${heroTiles([
      [t("hero.odo"), p?.odometer_km != null ? `${fmtNum(Math.round(p.odometer_km))} km` : "—"],
      [t("hero.sw"), s.software?.version?.split(" ")[0] || "—"],
      [t("hero.temps"), `${deg(p?.outside_temp)} / ${deg(p?.inside_temp)}`],
    ])}`;
}
/** Whole degrees for the hero tile ("-0" → "0"); the tile is too narrow for decimals on phones. */
const deg = (v: number | null | undefined) => v == null || !isFinite(v) ? "—" : `${Math.round(v) || 0}°`;
/** The three hero tiles always stay on one line: --n (longest value, in characters) lets CSS size the
 *  monospace text to the tile width (container query units), so all three shrink together when needed. */
function heroTiles(items: [string, string][]) {
  const len = Math.max(8, ...items.map(([, v]) => [...v].length));
  return `<div class="kv kv-fit" style="--n:${len}">${items.map(([k, v]) =>
    `<div><small>${k}</small><b title="${esc(v)}">${esc(v)}</b></div>`).join("")}</div>`;
}
const heroSkeleton = () => `
    <div class="row"><div style="flex:1">${sk("40%", "24px")}<br>${sk("55%")}</div><button class="icon-btn" data-refresh title="${t("common.refresh")}">⟳</button></div>
    <div style="margin:10px 0">${sk("90px", "20px")}</div>
    <div class="gauge-row">${sk("110px", "46px")}${sk("90px", "30px")}</div>
    <div class="gauge"></div>
    <div class="kv">${[1, 2, 3].map(() => `<div>${sk("60%", "10px")}<br>${sk("80%")}</div>`).join("")}</div>`;

function monthHTML(d: StatsData) {
  const m = d.this_month;
  return `<div class="section-title">${t("home.thisMonth", { m: m.month ? monthLabel(m.month) : "" })} <a class="link" data-report="${esc(m.month ?? "")}">${t("home.openReport")}</a></div>
    <div class="grid month-card" data-report="${esc(m.month ?? "")}">
      <div><small>${t("home.driven")}</small><b>${n(m.distance_km, 0)} km</b></div>
      <div><small>${t("home.used")}</small><b>${n(m.drive_energy_kwh, 1)} kWh</b></div>
      <div><small>${t("home.charged")}</small><b>${n(m.charge_energy_added_kwh, 1)} kWh</b></div>
      <div><small>${t("home.chargeCost")}</small><b>${costSum(m.charge_costs, m.charge_cost)}</b></div>
      <div><small>${t("home.drives")}</small><b>${m.drive_count ?? 0}</b></div>
      <div><small>${t("home.charges")}</small><b>${m.charge_count ?? 0}</b></div>
    </div>`;
}
function totalsHTML(d: StatsData) {
  const st = d.stats;
  return `<div class="section-title">${t("home.totals")}</div>
    <div class="grid">
      <div><small>${t("home.totalDist")}</small><b>${n(st.total_distance_km, 0)} km</b></div>
      <div><small>${t("home.drivesCharges")}</small><b>${st.drive_count ?? 0} / ${st.charge_count ?? 0}</b></div>
      <div><small>${t("home.totalCharged")}</small><b>${n(st.total_energy_added_kwh, 0)} kWh</b></div>
      <div><small>${t("home.totalCost")}</small><b>${costSum(st.costs, st.total_cost)}</b></div>
    </div>`;
}
function lastDriveHTML(a: Activity) {
  const d = a.last_drive;
  if (!d) return `<div class="section-title">${t("home.lastDrive")}</div><div class="empty">${ic("route")}<span>${t("home.noDrives")}</span></div>`;
  return `<div class="section-title">${t("home.lastDrive")}</div>
    <div class="card" data-drive="${d.id}">
      <div class="row"><b>${esc(d.start_address)} → ${esc(d.end_address)}</b></div>
      <div class="row muted">${fmtDate(d.start_date)} · ${fmtDur(d.duration_min)}</div>
      <div class="stats"><span>${ic("ruler")} ${n(d.distance_km)} km</span><span>${ic("battery")} ${d.start_battery_level ?? "—"}% → ${d.end_battery_level ?? "—"}%</span><span>${ic("bolt")} ${n(d.efficiency_wh_km, 0)} Wh/km</span></div>
    </div>`;
}
function lastChargeHTML(a: Activity) {
  const ch = a.last_charge;
  if (!ch) return `<div class="section-title">${t("home.lastCharge")}</div><div class="empty">${ic("bolt")}<span>${t("charges.empty")}</span></div>`;
  return `<div class="section-title">${t("home.lastCharge")}</div>
    <div class="card" data-charge="${ch.id}">
      <div class="row"><b>${esc(ch.address)}</b>${costBadge(ch)}</div>
      <div class="row muted">${fmtDate(ch.start_date)} · ${fmtDur(ch.duration_min)}</div>
      <div class="stats"><span>${ic("bolt")} +${n(ch.charge_energy_added, 2)} kWh</span><span>${ic("battery")} ${ch.start_battery_level ?? "—"}% → ${ch.end_battery_level ?? "—"}%</span></div>
    </div>`;
}

let homeGen = 0;

async function showHome() {
  destroyMap();
  const gen = ++homeGen;
  const alive = () => gen === homeGen && document.getElementById("home") != null;
  view.innerHTML = `
    <div id="home">
      <div class="pull-hint" id="pull">${t("home.pull")}</div>
      <div id="stale" class="stale" hidden></div>
      <div class="hero" id="sec-hero">${heroSkeleton()}</div>
      <div id="sec-map"><div class="section-title">${sk("40%")}</div><div class="map-ph sk"></div></div>
      <div id="sec-month"><div class="section-title">${sk("30%")}</div>${skGrid(6)}</div>
      <div id="sec-battery"></div>
      <div id="sec-drive"><div class="section-title">${sk("25%")}</div>${skCard()}</div>
      <div id="sec-charge"><div class="section-title">${sk("25%")}</div>${skCard()}</div>
      <div id="sec-totals"><div class="section-title">${sk("20%")}</div>${skGrid(3)}</div>
    </div>`;
  view.querySelector("[data-refresh]")?.addEventListener("click", showHome);

  const id = await currentCarId().catch(() => null);
  if (!alive()) return;
  if (id == null) { view.innerHTML = `<div class="error">${t("home.noCar")}</div>`; return; }
  localStorage.setItem(LAST_CAR_KEY, String(id));

  const data: HomeCache = { ...readHomeCache(id) };
  const fresh = { status: false, activity: false, stats: false };
  const sec = (k: string) => document.getElementById(`sec-${k}`)!;

  const updateStale = () => {
    const el = document.getElementById("stale"); if (!el) return;
    const pending = Object.values(fresh).some(v => !v);
    el.hidden = !(pending && data.savedAt);
    el.textContent = t("home.cached", { t: ago(new Date(data.savedAt ?? 0).toISOString()) });
  };

  const errorBox = (k: string, msg: string, retry: () => void) => {
    const el = sec(k), html = `<div class="error card-error">${ic("alert")} ${esc(msg)} <button class="retry">${t("common.retry")}</button></div>`;
    const old = el.querySelector(".card-error"); if (old) old.remove();
    el.insertAdjacentHTML(fresh[k as keyof typeof fresh] || !hasCache(k) ? "beforeend" : "afterbegin", html);
    if (!hasCache(k)) el.querySelectorAll(".sk, .sk-card, .grid, .map-ph, .section-title").forEach(e => e.remove());
    (el.querySelector(".retry") as HTMLElement).onclick = retry;
  };
  const hasCache = (k: string) => k === "hero" || k === "map" ? !!data.status : k === "drive" || k === "charge" ? !!data.activity : !!data.stats;

  const paintHero = () => {
    if (!data.status) return;
    sec("hero").innerHTML = heroHTML(data.status);
    sec("hero").querySelector("[data-refresh]")!.addEventListener("click", showHome);
  };
  let mapObserver: IntersectionObserver | null = null;
  const paintMap = () => {
    const p = data.status?.position;
    if (!data.status) return;
    if (p?.latitude == null || p.longitude == null) { sec("map").innerHTML = ""; return; }
    const title = `<div class="section-title"><span>${esc(data.activity?.location?.name ?? t("home.lastPos"))}</span><span class="muted">${p.date ? ago(p.date) : ""}</span></div>`;
    const existing = document.getElementById("map");
    if (existing) { sec("map").querySelector(".section-title")!.outerHTML = title; return; }
    sec("map").innerHTML = `${title}<div id="map" class="small"><div class="map-ph sk"></div></div>`;
    // Lazy: only create the WebGL map once the card is (nearly) on screen
    mapObserver?.disconnect();
    mapObserver = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting) || !alive()) return;
      mapObserver?.disconnect();
      const el = document.getElementById("map"); if (!el) return;
      el.innerHTML = "";
      map = new DriveMap(el, { point: [p.longitude!, p.latitude!] });
    }, { rootMargin: "200px" });
    mapObserver.observe(document.getElementById("map")!);
  };
  const paintActivity = () => {
    if (!data.activity) return;
    sec("drive").innerHTML = lastDriveHTML(data.activity);
    sec("charge").innerHTML = lastChargeHTML(data.activity);
    sec("drive").querySelector<HTMLElement>("[data-drive]")?.addEventListener("click", e => showDrive(Number((e.currentTarget as HTMLElement).dataset.drive)));
    sec("charge").querySelector<HTMLElement>("[data-charge]")?.addEventListener("click", e => showCharge(Number((e.currentTarget as HTMLElement).dataset.charge)));
    if (data.status) paintMap();
  };
  const paintStats = () => {
    if (!data.stats) return;
    sec("month").innerHTML = monthHTML(data.stats);
    sec("month").querySelectorAll<HTMLElement>("[data-report]").forEach(el => el.onclick = () => openReport(el.dataset.report || nowMonth(), id));
    applyFeatureGates();
    sec("totals").innerHTML = totalsHTML(data.stats);
  };

  // 1) Instant: cached data
  paintHero(); paintMap(); paintActivity(); paintStats(); updateStale();

  // 2) Background: three independent requests
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const loadStatus = () => api<Status>(`/api/cars/${id}/status`).then(r => {
    if (!alive()) return; data.status = r; fresh.status = true; writeHomeCache(id, { status: r });
    paintHero(); paintMap(); updateStale();
  }).catch(e => { if (alive()) { fresh.status = true; updateStale(); errorBox("hero", t("home.errStatus", { e: (e as Error).message }), loadStatus); } });
  const loadActivity = () => api<Activity>(`/api/cars/${id}/last-activity`).then(r => {
    if (!alive()) return; data.activity = r; fresh.activity = true; writeHomeCache(id, { activity: r });
    paintActivity(); updateStale();
  }).catch(e => { if (alive()) { fresh.activity = true; updateStale(); errorBox("drive", t("home.errActivity", { e: (e as Error).message }), loadActivity); } });
  const loadStats = () => api<StatsData>(`/api/cars/${id}/stats?tz=${encodeURIComponent(tz)}&currency=${defaultCurrency()}`).then(r => {
    if (!alive()) return; data.stats = r; fresh.stats = true; writeHomeCache(id, { stats: r });
    paintStats(); updateStale();
  }).catch(e => { if (alive()) { fresh.stats = true; updateStale(); errorBox("month", t("home.errStats", { e: (e as Error).message }), loadStats); } });
  loadStatus(); loadActivity(); loadStats();
  // 电池健康 card (api_level ≥ 12)
  serverReady().then(() => {
    if (lacks("insights") || !alive()) return;
    api<Battery>(`/api/cars/${id}/battery?summary=true`).then(async b => {
      if (!alive()) return;
      sec("battery").innerHTML = batteryCardHTML(b, await carInfo(id), id);
      sec("battery").querySelectorAll<HTMLElement>("[data-battery]").forEach(el => el.onclick = () => openBattery(id));
    }).catch(() => { /* optional card */ });
  });
}

async function carInfo(id: number): Promise<Car | null> { try { return (await api<Car[]>("/api/cars")).find(c => c.id === id) ?? null; } catch { return null; } }
async function openBattery(id: number) { destroyMap(); ++homeGen; showBattery(view, id, showHome, await carInfo(id)); window.scrollTo(0, 0); }

/** Monthly report (opened from the 首页 month card; back returns to 首页). */
async function openReport(month: string, carId?: number) {
  destroyMap();
  await serverReady();
  if (lacks("report")) {
    view.innerHTML = `<button class="back">${t("common.back")}</button><div class="pane" style="margin-top:12px">
      <div class="error card-error">${ic("alert")} ${esc(featureText("report"))} <button class="retry">${t("common.retry")}</button></div>
      <div class="muted">${t("report.needServer")}</div></div>`;
    (view.querySelector(".back") as HTMLElement).onclick = showHome;
    (view.querySelector(".retry") as HTMLElement).onclick = async () => { await checkServer(); openReport(month, carId); };
    return;
  }
  const id = carId ?? await currentCarId().catch(() => null);
  if (id == null) return showHome();
  ++homeGen;
  const self = (m: string) => openReport(m, id);
  const back = () => self(month);
  renderReport(view, id, month, { back: showHome, month: self,
    drive: d => showDrive(d, back), charge: c => showCharge(c, back),
    extras: lacks("insights") ? undefined : { setMap: m => { destroyMap(); map = m; } } });
  window.scrollTo(0, 0);
}

// ---------------- 旅程 ----------------
const journeyCtx: JourneyCtx = {
  view,
  setMap(m) { if (map && map !== m) destroyMap(); map = m; },
  showDrive: (id, back) => showDrive(id, back),
  showCharge: (id, back) => showCharge(id, back),
  carQ,
  carId: () => currentCarId().catch(() => null),
  journeysAvailable: () => !lacks("journeys"),
  journeysMessage: () => featureText("journeys"),
  dismissAvailable: () => !lacks("dismiss"),
  pagingAvailable: () => !lacks("paging"),
  journey2Available: () => !lacks("journey2"),
  journey2Message: () => featureText("journey2"),
};

// ---------------- Server version banner ----------------
const banner = document.getElementById("srv-banner")!;
let bannerOverride: string | null = null;
function renderBanner() {
  const text = bannerOverride ?? globalBanner();
  banner.hidden = !text;
  if (!text) return;
  banner.innerHTML = `<span>${ic("alert")} ${esc(text)}</span><button class="retry">${t("common.retry")}</button><button class="x" aria-label="${t("common.close")}">×</button>`;
  (banner.querySelector(".retry") as HTMLElement).onclick = async () => {
    banner.querySelector(".retry")!.textContent = t("common.checking"); bannerOverride = null;
    await checkServer();
    if (!globalBanner()) (document.querySelector("nav button.active") as HTMLElement | null)?.click();
  };
  (banner.querySelector(".x") as HTMLElement).onclick = () => { banner.hidden = true; bannerOverride = null; };
}
function showBanner(text: string) { bannerOverride = text; renderBanner(); }
/** Hide entry points the server is known not to support. */
function applyFeatureGates() {
  document.querySelectorAll<HTMLElement>("a[data-report]").forEach(a => a.hidden = lacks("report"));
  document.querySelectorAll<HTMLElement>(".month-card[data-report]").forEach(c => c.classList.toggle("month-card", !lacks("report")));
  const ver = document.getElementById("srv-ver"); if (ver) ver.textContent = serverLabel();
}
onServerInfo(() => {
  renderBanner(); applyFeatureGates();
  // a feature screen showing a 404 may now be explained
});
let lastCheck = 0;
window.addEventListener("drivelens-server-error", () => {
  if (Date.now() - lastCheck < 10000) return; lastCheck = Date.now();
  checkServer().then(i => { if (i.state === "legacy") showBanner(tooOldText(7)); });
});
window.addEventListener("focus", () => { if (Date.now() - lastCheck > 300000) { lastCheck = Date.now(); checkServer(); } });

// Pull-to-refresh on the home tab (touch devices)
let pullStartY: number | null = null;
window.addEventListener("touchstart", e => {
  if (window.scrollY === 0 && document.querySelector("nav button.active")?.getAttribute("data-tab") === "home")
    pullStartY = e.touches[0].clientY;
}, { passive: true });
window.addEventListener("touchmove", e => {
  if (pullStartY == null) return;
  const dy = e.touches[0].clientY - pullStartY, hint = document.getElementById("pull");
  if (hint) { hint.style.height = `${Math.min(dy, 70)}px`; hint.textContent = dy > 60 ? t("home.release") : t("home.pull"); }
}, { passive: true });
window.addEventListener("touchend", e => {
  if (pullStartY == null) return;
  const dy = e.changedTouches[0].clientY - pullStartY; pullStartY = null;
  const hint = document.getElementById("pull"); if (hint) hint.style.height = "0";
  if (dy > 60) showHome();
});

mountDemoBanner();
trackHeaderHeight();
initSheets();
const tabs: Record<string, () => void> = { home: showHome, drives: showDrives, charges: () => showCharges(), settings: showSettings };
initPlatform();   // touch class, external links, Android insets / status bar / back button
initWeb();        // browser / PWA: service worker (shell only), install prompt, theme-color
setRootBack(() => {   // Android back at a tab root: other tab → home; on home → exit
  const active = document.querySelector<HTMLElement>("nav button.active");
  if (document.body.classList.contains("setup-mode")) return false;
  if (active?.dataset.tab !== "home" || !document.getElementById("home")) {
    (document.querySelector('nav button[data-tab="home"]') as HTMLElement).click(); return true;
  }
  return false;
});
initBackToTop();
initUI(view);
initOverlayScrollbar();
const NAV_IC: Record<string, string> = { home: "home", drives: "route", charges: "bolt", settings: "gear" };
document.querySelectorAll<HTMLButtonElement>("nav button").forEach(b => { b.innerHTML = `${ic(NAV_IC[b.dataset.tab!] ?? "info")}<span>${t(`nav.${b.dataset.tab}` as "nav.home")}</span>`; });
document.querySelectorAll<HTMLButtonElement>("nav button").forEach(b => b.onclick = e => {
  // re-tapping the active tab (real tap, not a programmatic re-render) scrolls to top / back to newest
  if (e.isTrusted && b.classList.contains("active") && (window.scrollY > 0 || isJumped())) return backToTop();
  document.querySelectorAll("nav button").forEach(x => x.classList.remove("active"));
  b.classList.add("active"); tabs[b.dataset.tab!]();
});
carSel.onchange = () => { localStorage.setItem(LAST_CAR_KEY, carSel.value); (document.querySelector("nav button.active") as HTMLElement).click(); };

// The server URL / token are never taken from the URL (removed in 1.1.1; urlguard.ts strips such parameters).
const qp = new URLSearchParams(location.search);
const start = qp.get("view");
/** Deep links (?view=…) and notification taps (service worker → postMessage, see notify.ts). */
function openView(v: string | null) {
  const tab = (name: string) => document.querySelector<HTMLElement>(`nav button[data-tab="${name}"]`)!;
  if (v === "charges") tab("charges").click();
  else if (v === "settings") tab("settings").click();
  else if (v?.startsWith("drive:")) showDrive(Number(v.slice(6)));
  else if (v?.startsWith("charge:")) showCharge(Number(v.slice(7)));
  else if (v?.startsWith("report")) openReport(v.slice(7) || nowMonth());
  else if (v === "battery") currentCarId().then(id => { if (id != null) openBattery(id); });
  else if (v?.startsWith("journey:")) { serverReady().then(() => import("./journey").then(m => m.showJourney(journeyCtx, Number(v.slice(8))))); }
  else if (v === "journeys") { tab("drives").classList.add("active"); serverReady().then(() => import("./journey").then(m => m.showJourneys(journeyCtx))); }
  else if (v === "drives") tab("drives").click();
  else showHome();
}
initNotificationClicks(v => { if (loadSettings().apiUrl && !document.body.classList.contains("setup-mode")) { closeMenus(); document.querySelector(".modal")?.remove(); openView(v); } });
// a later reload must not reopen the notification target (but keep it while the first service-worker install may still reload the page)
if (qp.get("from") === "push" && navigator.serviceWorker?.controller) history.replaceState(null, "", location.pathname);
if (!loadSettings().apiUrl) {
  showSetupWizard(view, () => { checkServer(); loadCars(); showHome(); });
} else { checkServer(); loadCars(); openView(start); }
