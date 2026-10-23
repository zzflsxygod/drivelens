// SPDX-License-Identifier: AGPL-3.0-or-later
// 月度报告 page. Data: GET /api/cars/:id/report?month=YYYY-MM&tz=..&currency=..
import { api, fmtMoney, defaultCurrency } from "./api";
import { ic } from "./icons";
import { featureText } from "./version";
import type { DriveMap } from "./map";
import { loadReportExtras } from "./insights";
import { t, currentLang, fmtDur, fmtMonthDay, monthLabel, weekdays, fmtNum } from "./i18n";

interface Money { currency: string; amount: number }
interface Overview { distance_km: number; drive_duration_min: number; drive_count: number; energy_used_kwh: number;
  energy_added_kwh: number; charge_count: number; costs: Money[]; efficiency_wh_km: number | null }
interface Bucket { kind: "home" | "supercharger" | "other"; count: number; energy_kwh: number; costs: Money[] }
interface DriveRec { id: number; start_date: string; start_address: string | null; end_address: string | null;
  distance_km: number | null; duration_min: number | null; speed_max: number | null }
interface ChargeRec { id: number; start_date: string; address: string | null; energy_kwh: number | null; cost: number | null;
  currency: string | null; peak_kw: number | null; start_battery_level: number | null; end_battery_level: number | null; duration_min: number | null }
export interface Report { month: string; is_current: boolean; first_month: string | null; days_in_month: number; days_elapsed: number;
  overview: Overview; previous: Overview; split: Bucket[]; daily: { date: string; distance_km: number; energy_added_kwh: number }[];
  records: { longest_drive: DriveRec | null; top_speed_drive: DriveRec | null; most_expensive_charge: ChargeRec | null; fastest_charge: ChargeRec | null } }

export interface ReportNav { back: () => void; drive: (id: number) => void; charge: (id: number) => void; month: (m: string) => void;
  /** api_level ≥ 12: footprint map + 12-month trends */
  extras?: { setMap: (m: DriveMap | null) => void } }

const esc = (s: unknown) => String(s ?? "—").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const num = (v: number, d = 0) => fmtNum(v, d);
const md = (iso: string) => fmtMonthDay(iso);
const durHM = (m: number | null) => fmtDur(m);
const COLORS = { home: "var(--mix-home)", supercharger: "var(--mix-sc)", other: "var(--mix-other)" };
const LABEL = (k: "home" | "supercharger" | "other") => t(`mix.${k}`);
const ICON = { home: ic("home"), supercharger: ic("bolt"), other: ic("plug") };

export function shiftMonth(m: string, by: number) {
  const [y, mo] = m.split("-").map(Number); const d = new Date(y, mo - 1 + by, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
export function nowMonth() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }

/** main currency: the default currency if present, else the largest */
function mainCur(list: Money[]) { const d = defaultCurrency(); return list.find(m => m.currency === d) ?? [...list].sort((a, b) => b.amount - a.amount)[0]; }
const costTxt = (list: Money[]) => list.length ? list.map(m => fmtMoney(m.amount, m.currency)).join(" + ") : "—";

function delta(cur: number | null, prev: number | null, goodUp: boolean) {
  if (cur == null || prev == null || prev === 0) return `<div class="d neu">– <span>${t("rp.vsPrev")}</span></div>`;
  const p = Math.round((cur - prev) / prev * 100);
  const cls = p === 0 ? "neu" : (p > 0) === goodUp ? "up" : "dn";
  return `<div class="d ${cls}">${p > 0 ? "↑" : p < 0 ? "↓" : "–"} ${Math.abs(p)}% <span class="neu">${t("rp.vsPrev")}</span></div>`;
}

function donut(parts: [number, string][], center: string, sub: string) {
  const R = 42, C = 2 * Math.PI * R, tot = parts.reduce((a, p) => a + p[0], 0); let off = 0, s = "";
  if (tot > 0) for (const [v, c] of parts) { if (v <= 0) continue; const l = C * v / tot;
    s += `<circle r="${R}" cx="55" cy="55" fill="none" style="stroke:${c}" stroke-width="14" stroke-dasharray="${l} ${C - l}" stroke-dashoffset="${-off}" transform="rotate(-90 55 55)"/>`; off += l; }
  else s = `<circle r="${R}" cx="55" cy="55" fill="none" style="stroke:var(--sub)" stroke-width="14"/>`;
  return `<svg width="110" height="110" viewBox="0 0 110 110"><g>${s}</g><text x="55" y="54" text-anchor="middle" font-size="${center.length > 6 ? 13 : 15}" font-weight="700" style="fill:var(--text)">${center}</text><text x="55" y="70" text-anchor="middle" class="ax">${sub}</text></svg>`;
}

function bars(r: Report) {
  const W = 392, H = 170, L = 28, B = 22, T = 10, iw = W - L - 6, ih = H - T - B, n = r.daily.length, bw = iw / n;
  const nice = (v: number) => { const s = [10, 20, 50, 100, 150, 200, 300, 400, 500, 800, 1000]; return s.find(x => x >= v) ?? Math.ceil(v / 500) * 500; };
  const mk = nice(Math.max(1, ...r.daily.map(d => d.distance_km))), mc = nice(Math.max(1, ...r.daily.map(d => d.energy_added_kwh)));
  let g = "";
  [0, .5, 1].forEach(f => { const y = T + ih * (1 - f);
    g += `<line x1="${L}" x2="${W - 6}" y1="${y}" y2="${y}" class="cg"/><text class="ax" x="${L - 4}" y="${y + 3}" text-anchor="end">${Math.round(mk * f)}</text>`; });
  r.daily.forEach((d, i) => { const x = L + i * bw, fut = r.is_current && i >= r.days_elapsed;
    if (d.distance_km > 0) g += `<rect x="${x + 1}" y="${T + ih * (1 - d.distance_km / mk)}" width="${Math.max(bw / 2 - 1, 1)}" height="${ih * d.distance_km / mk}" rx="1.5" style="fill:var(--accent)"><title>${d.date} ${d.distance_km} km</title></rect>`;
    if (d.energy_added_kwh > 0) g += `<rect x="${x + bw / 2}" y="${T + ih * (1 - d.energy_added_kwh / mc)}" width="${Math.max(bw / 2 - 1, 1)}" height="${ih * d.energy_added_kwh / mc}" rx="1.5" style="fill:var(--green)" opacity=".85"><title>${d.date} ${d.energy_added_kwh} kWh</title></rect>`;
    if (fut) g += `<rect x="${x}" y="${T}" width="${bw}" height="${ih}" style="fill:var(--grid)" opacity=".6"/>`;
    if ([0, 4, 9, 14, 19, 24, 29].includes(i)) g += `<text class="ax" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${i + 1}</text>`; });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${t("rp.dailyAria")}">${g}</svg>
    <div class="lg"><span><i style="background:var(--accent)"></i>${t("rp.lgKm")}</span><span><i style="background:var(--green)"></i>${t("rp.lgKwh", { v: mc })}</span></div>`;
}

function calendar(r: Report) {
  const [y, m] = r.month.split("-").map(Number);
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7; // Monday first
  const max = Math.max(1, ...r.daily.map(d => d.distance_km));
  const cells = Array.from({ length: lead }, () => `<div></div>`).concat(r.daily.map((d, i) => {
    const fut = r.is_current && i >= r.days_elapsed, a = d.distance_km / max;
    const bg = d.distance_km > 0 ? `background:color-mix(in srgb, var(--accent) ${Math.round(18 + 72 * a)}%, var(--sub));` : "";
    return `<div class="cal-d${fut ? " fut" : ""}${d.distance_km > 0 && a > .5 ? " hot" : ""}" style="${bg}" title="${d.date}"><b>${i + 1}</b><span>${d.distance_km > 0 ? Math.round(d.distance_km) : ""}</span>${d.energy_added_kwh > 0 ? `<i title="${d.energy_added_kwh} kWh">${ic("bolt")}</i>` : ""}</div>`; }));
  return `<div class="cal">${weekdays().map(w => `<div class="cal-h">${w}</div>`).join("")}${cells.join("")}</div>
    <div class="lg"><span><i style="background:color-mix(in srgb, var(--accent) 55%, var(--sub))"></i>${t("rp.calLegend")}</span><span style="display:inline-flex;align-items:center;gap:4px"><span style="color:var(--red);display:inline-flex">${ic("bolt")}</span>${t("rp.calCharge")}</span></div>`;
}

function bodySkeleton() {
  const sk = (w: string, h = "14px") => `<span class="sk" style="width:${w};height:${h}"></span>`;
  return `<div class="ov">${Array.from({ length: 6 }, () => `<div>${sk("50%", "10px")}<br>${sk("70%", "22px")}<br>${sk("40%", "10px")}</div>`).join("")}</div>
    <div class="section-title">${sk("25%")}</div><div class="pane">${sk("100%", "150px")}</div>
    <div class="section-title">${sk("20%")}</div><div class="pane">${sk("100%", "150px")}</div>`;
}
export function reportSkeleton(month: string) {
  return `<button class="back" data-title="${t("rp.pageTitle")}">${t("common.back")}</button>${switcher(month, null)}<div id="rp-body">${bodySkeleton()}</div>`;
}

function switcher(month: string, r: Report | null) {
  const [y, m] = month.split("-").map(Number);
  const canNext = month < nowMonth(), canPrev = !r?.first_month || month > r.first_month;
  const mn = currentLang() === "en" ? new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1))) : String(m);
  const sub = r ? (r.is_current ? t("rp.rangeCur", { m: mn, d: r.days_elapsed }) : t("rp.range", { m: mn, d: r.days_in_month })) : "&nbsp;";
  const chev = (d: string) => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return `<div class="msw"><div class="msw-pill" role="group" aria-label="${monthLabel(month)}">
      <button class="msw-arrow" data-m="${shiftMonth(month, -1)}" data-dir="-1" ${canPrev ? "" : "disabled"} aria-label="${t("rp.prevMonth")}" title="${t("rp.prevMonth")}">${chev("m14.5 6-6 6 6 6")}</button>
      <b class="msw-label">${monthLabel(month)}</b>
      <button class="msw-arrow" data-m="${shiftMonth(month, 1)}" data-dir="1" ${canNext ? "" : "disabled"} aria-label="${t("rp.nextMonth")}" title="${t("rp.nextMonth")}">${chev("m9.5 6 6 6-6 6")}</button>
    </div><div class="muted msw-sub">${sub}</div></div>`;
}

export function reportHTML(r: Report) {
  const o = r.overview, p = r.previous, cur = defaultCurrency();
  const oc = mainCur(o.costs), pc = p.costs.find(x => x.currency === oc?.currency);
  const perKm = oc && o.distance_km > 0 ? oc.amount / o.distance_km : null;
  const perKmPrev = pc && p.distance_km > 0 ? pc.amount / p.distance_km : null;
  const perKwh = oc && o.energy_added_kwh > 0 ? oc.amount / o.energy_added_kwh : null;
  const perKwhPrev = pc && p.energy_added_kwh > 0 ? pc.amount / p.energy_added_kwh : null;
  const mc = oc?.currency ?? cur;
  const bucketCost = (b: Bucket) => b.costs.find(x => x.currency === mc)?.amount ?? 0;
  const days = r.daily.filter(d => d.distance_km > 0), top = [...r.daily].sort((a, b) => b.distance_km - a.distance_km)[0];
  const elapsed = r.is_current ? Math.max(r.days_elapsed, 1) : r.days_in_month;
  const rec = r.records, ld = rec.longest_drive, ts = rec.top_speed_drive, ec = rec.most_expensive_charge, fc = rec.fastest_charge;
  const recCard = (attr: string, icon: string, label: string, title: string, val: string, sub = "") =>
    `<div class="card best" ${attr}><div class="ic">${icon}</div><div class="t"><small>${label}</small><b>${title}</b></div><div class="v">${val}${sub ? `<div class="muted">${sub}</div>` : ""}</div><div class="chev">›</div></div>`;
  const empty = o.drive_count === 0 && o.charge_count === 0;
  return `<div class="ov">
      <div><small>${t("rp.distance")}</small><b>${num(o.distance_km)}<i>km</i></b>${delta(o.distance_km, p.distance_km, true)}</div>
      <div><small>${t("rp.driveTime")}</small><b>${Math.floor(o.drive_duration_min / 60)}<i>${t("rp.unitH")}</i>${o.drive_duration_min % 60}<i>${t("rp.unitM")}</i></b>${delta(o.drive_duration_min, p.drive_duration_min, true)}</div>
      <div><small>${t("rp.driveCount")}</small><b>${o.drive_count}<i>${t("rp.unitTimes")}</i></b>${delta(o.drive_count, p.drive_count, true)}</div>
      <div><small>${t("rp.used")}</small><b>${num(o.energy_used_kwh)}<i>kWh</i></b>${delta(o.energy_used_kwh, p.energy_used_kwh, false)}</div>
      <div><small>${t("rp.charged")}</small><b>${num(o.energy_added_kwh)}<i>kWh</i></b>${delta(o.energy_added_kwh, p.energy_added_kwh, false)}</div>
      <div><small>${t("rp.cost")}</small><b class="${o.costs.length > 1 ? "multi" : ""}">${costTxt(o.costs)}</b>${delta(oc?.amount ?? null, pc?.amount ?? null, false)}</div>
    </div>
    ${r.is_current ? `<div class="muted small-note">${t("rp.curNote")}</div>` : ""}
    ${empty ? `<div class="pane muted" style="text-align:center;margin-top:10px">${t("rp.empty")}</div>` : `
    <div class="section-title">${t("rp.effCost")}</div>
    <div class="pane">
      <div class="kpi">
        <div><small>${t("rp.avgEff")}</small><b>${o.efficiency_wh_km != null ? num(o.efficiency_wh_km) : "—"} <span class="muted">Wh/km</span></b>${delta(o.efficiency_wh_km, p.efficiency_wh_km, false)}</div>
        <div><small>${t("rp.perKm")}</small><b>${perKm != null ? fmtMoney(perKm, mc, true) : "—"} <span class="muted">/km</span></b>${delta(perKm, perKmPrev, false)}</div>
        <div><small>${t("rp.perKwh")}</small><b>${perKwh != null ? fmtMoney(perKwh, mc, true) : "—"} <span class="muted">/kWh</span></b>${delta(perKwh, perKwhPrev, false)}</div>
      </div>
      <div class="donuts">
        <div class="donut">${donut(r.split.map(b => [b.energy_kwh, COLORS[b.kind]]), num(o.energy_added_kwh), "kWh")}<div>${t("rp.byEnergy")}</div></div>
        <div class="donut">${donut(r.split.map(b => [bucketCost(b), COLORS[b.kind]]), oc ? fmtMoney(oc.amount, mc) : "—", t("rp.costUnit"))}<div>${t("rp.byCost")}</div></div>
      </div>
      <div class="lg">${r.split.map(b => `<span><i style="background:${COLORS[b.kind]}"></i>${LABEL(b.kind)}</span>`).join("")}</div>
      <table class="split"><tr><td></td><td>${t("rp.colEnergy")}</td><td>${t("rp.colCost")}</td><td>${t("rp.colUnit")}</td></tr>
        ${r.split.map(b => `<tr><td>${ICON[b.kind]} ${LABEL(b.kind)} ×${b.count}</td><td>${num(b.energy_kwh)} kWh</td><td>${costTxt(b.costs)}</td>
          <td>${b.energy_kwh > 0 && bucketCost(b) > 0 ? fmtMoney(bucketCost(b) / b.energy_kwh, mc, true) : "—"}</td></tr>`).join("")}
      </table>
    </div>
    <div class="section-title">${t("rp.daily")} <div class="seg" id="rp-seg"><span data-v="bar" class="on">${t("rp.bar")}</span><span data-v="cal">${t("rp.cal")}</span></div></div>
    <div class="pane"><div id="rp-daily">${bars(r)}</div>
      <div class="muted" style="text-align:center;margin-top:4px">${t("rp.dailySummary", { n: days.length, avg: num(o.distance_km / elapsed) })}${top && top.distance_km > 0 ? t("rp.dailyTop", { d: md(top.date), km: num(top.distance_km) }) : ""}</div></div>
    <div class="section-title">${t("rp.records")}</div>
    ${ld ? recCard(`data-drive="${ld.id}"`, ic("route"), t("rp.longest", { d: md(ld.start_date) }), `${esc(ld.start_address)} → ${esc(ld.end_address)}`, `${num(ld.distance_km ?? 0, 1)} km`, durHM(ld.duration_min)) : ""}
    ${ts ? recCard(`data-drive="${ts.id}"`, ic("speed"), t("rp.topSpeed", { d: md(ts.start_date) }), `${esc(ts.start_address)} → ${esc(ts.end_address)}`, `${ts.speed_max} km/h`) : ""}
    ${ec ? recCard(`data-charge="${ec.id}"`, ic("coin"), t("rp.priciest", { d: md(ec.start_date) }), esc(ec.address), fmtMoney(ec.cost, ec.currency), `${num(ec.energy_kwh ?? 0, 1)} kWh`) : ""}
    ${fc ? recCard(`data-charge="${fc.id}"`, ic("bolt"), t("rp.fastest", { d: md(fc.start_date) }), esc(fc.address), `${num(fc.peak_kw ?? 0)} kW`, `${fc.start_battery_level ?? "—"}%→${fc.end_battery_level ?? "—"}% ${durHM(fc.duration_min)}`) : ""}
    ${!ld && !ts && !ec && !fc ? `<div class="muted">${t("common.none")}</div>` : ""}`}`;
}

let gen = 0;
const cache = new Map<string, Report>();
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
/**
 * One persistent page shell (sticky header + month pill + sliding #rp-main). A month change only swaps what is
 * inside #rp-main — once, with one directional slide — and data fills in place afterwards (no second entrance
 * animation, no page re-render). Months already seen render instantly from the cache and refresh silently.
 */
export async function showReport(view: HTMLElement, carId: number, month: string, nav: ReportNav) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) month = nowMonth();   // month is interpolated into HTML below
  const g = ++gen, key = `${carId}:${month}`;
  let shell = view.querySelector<HTMLElement>("#rp-shell");
  const prevMonth = shell?.dataset.car === String(carId) ? shell.dataset.month : undefined;
  if (!shell || prevMonth === undefined) {
    view.innerHTML = `<div id="rp-shell" data-car="${carId}"><button class="back" data-title="${t("rp.pageTitle")}">${t("common.back")}</button>
      <div id="rp-sw">${switcher(month, null)}</div><div id="rp-main"><div id="rp-body"></div><div id="rp-extras"></div></div></div>`;
    shell = view.querySelector<HTMLElement>("#rp-shell")!;
  }
  shell.dataset.month = month;
  const sw = shell.querySelector<HTMLElement>("#rp-sw")!, main = shell.querySelector<HTMLElement>("#rp-main")!;
  const body = shell.querySelector<HTMLElement>("#rp-body")!, extras = shell.querySelector<HTMLElement>("#rp-extras")!;
  (shell.querySelector(".back") as HTMLElement).onclick = nav.back;
  let shown: Report | null = null;
  const setSwitcher = (r: Report | null) => {
    sw.innerHTML = switcher(month, r ?? cache.get(key) ?? null);
    sw.querySelectorAll<HTMLButtonElement>("button[data-m]").forEach(b => b.onclick = () => { if (!b.disabled) nav.month(b.dataset.m!); });
  };
  const fill = (r: Report) => {
    shown = r; setSwitcher(r);
    body.innerHTML = reportHTML(r);
    body.querySelectorAll<HTMLElement>("[data-drive]").forEach(el => el.onclick = () => nav.drive(Number(el.dataset.drive)));
    body.querySelectorAll<HTMLElement>("[data-charge]").forEach(el => el.onclick = () => nav.charge(Number(el.dataset.charge)));
    body.querySelectorAll<HTMLElement>("#rp-seg span").forEach(sp => sp.onclick = () => {
      body.querySelectorAll("#rp-seg span").forEach(x => x.classList.toggle("on", x === sp));
      body.querySelector("#rp-daily")!.innerHTML = sp.dataset.v === "cal" ? calendar(r) : bars(r);
    });
  };
  const hit = cache.get(key);
  if (prevMonth !== month) {
    if (hit) fill(hit); else { setSwitcher(null); body.innerHTML = bodySkeleton(); }
    if (nav.extras) loadReportExtras(extras, carId, month, nav.extras.setMap);
    if (prevMonth && !reduceMotion()) {
      const cls = month > prevMonth ? "mv-segR" : "mv-segL";
      main.classList.remove("mv-segR", "mv-segL"); void main.offsetWidth; main.classList.add(cls);
      main.addEventListener("animationend", () => main.classList.remove(cls), { once: true });
    }
  } else if (hit) fill(hit);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const load = () => api<Report>(`/api/cars/${carId}/report?month=${month}&tz=${encodeURIComponent(tz)}&currency=${defaultCurrency()}`)
    .then(r => {
      if (g !== gen) return;
      const same = shown != null && JSON.stringify(shown) === JSON.stringify(r);
      cache.set(key, r);
      if (!same) fill(r);   // in place: no re-animation
    })
    .catch(e => {
      if (g !== gen) return;
      body.querySelector(".card-error")?.remove();
      if (!cache.has(key)) body.innerHTML = "";
      body.insertAdjacentHTML("afterbegin", `<div class="error card-error">${ic("alert")} ${(e as { status?: number }).status === 404 ? esc(featureText("report")) : esc(t("rp.loadErr", { e: (e as Error).message }))} <button class="retry">${t("common.retry")}</button></div>`);
      (body.querySelector(".retry") as HTMLElement).onclick = () => { body.querySelector(".card-error")!.innerHTML = t("common.loading"); load(); };
    });
  load();
}
