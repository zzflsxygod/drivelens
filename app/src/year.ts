// SPDX-License-Identifier: AGPL-3.0-or-later
// Year in review page. Data: GET /api/cars/:id/year-review?year=YYYY&tz=..&currency=..
import { api, fmtMoney, defaultCurrency } from "./api";
import { ic } from "./icons";
import { featureText, lacks } from "./version";
import { t, currentLang, fmtDur, fmtMonthDay, monthLabel, fmtNum } from "./i18n";

interface Money { currency: string; amount: number }
interface Totals {
  distance_km: number; drive_count: number; drive_duration_min: number;
  energy_used_kwh: number; efficiency_wh_km: number | null;
  charge_count: number; energy_added_kwh: number; priced_kwh?: number;
  costs: Money[]; cost_per_kwh: Money[]; cost_per_100km: Money[];
  home_kwh: number; supercharger_kwh: number; other_kwh: number;
}
interface MonthRow {
  month: string; distance_km: number; drive_count: number; drive_duration_min: number;
  energy_used_kwh: number; energy_added_kwh: number; charge_count: number; costs: Money[];
}
interface DriveRec {
  id: number; start_date: string | null; start_address: string | null; end_address: string | null;
  distance_km: number; duration_min: number;
}
interface JourneyRec {
  id: number; name: string; start_date: string | null; end_date: string | null;
  start_address: string | null; end_address: string | null; distance_km: number; duration_min: number;
}
export interface YearReview {
  year: number; timezone: string; is_current: boolean; partial: boolean;
  data_from: string | null; data_to: string;
  totals: Totals; months: MonthRow[];
  highlights: {
    longest_drive: DriveRec | null;
    longest_journey: JourneyRec | null;
    busiest_month: { month: string; distance_km: number } | null;
    top_destinations: { name: string; visits: number }[];
    superchargers_visited: number;
    charge_split: { home_kwh: number; supercharger_kwh: number; other_kwh: number };
  };
  yoy: {
    distance_pct: number | null; drive_count_pct: number | null;
    energy_used_pct: number | null; energy_added_pct: number | null;
    previous: Totals;
  } | null;
}

export interface YearNav {
  back: () => void;
  year: (y: number) => void;
  drive: (id: number) => void;
  journey?: (id: number) => void;
  month?: (m: string) => void;
}

const esc = (s: unknown) => String(s ?? "—").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const num = (v: number, d = 0) => fmtNum(v, d);
const costTxt = (list: Money[]) => list.length ? list.map(m => fmtMoney(m.amount, m.currency)).join(" + ") : "—";
const COLORS = { home: "var(--mix-home)", supercharger: "var(--mix-sc)", other: "var(--mix-other)" };

export function nowYear() { return new Date().getFullYear(); }
export function yearOfMonth(m: string) { return Number(m.slice(0, 4)); }

/** Dec–Jan home entry for the year just ending (Dec) or just ended (Jan). */
export function seasonalYear(): number | null {
  const d = new Date();
  const mo = d.getMonth() + 1;
  if (mo === 12) return d.getFullYear();
  if (mo === 1) return d.getFullYear() - 1;
  return null;
}

function yoyChip(pct: number | null | undefined, goodUp: boolean) {
  if (pct == null) return "";
  const cls = pct === 0 ? "neu" : (pct > 0) === goodUp ? "up" : "dn";
  const arrow = pct > 0 ? "↑" : pct < 0 ? "↓" : "–";
  return `<div class="d ${cls}">${arrow} ${Math.abs(pct)}% <span class="neu">${t("yr.vsPrev")}</span></div>`;
}

function monthBars(r: YearReview) {
  const W = 392, H = 160, L = 28, B = 22, T = 10, iw = W - L - 6, ih = H - T - B;
  const n = r.months.length, bw = iw / n;
  const max = Math.max(1, ...r.months.map(m => m.distance_km));
  const nice = (v: number) => {
    const s = [100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    return s.find(x => x >= v) ?? Math.ceil(v / 5000) * 5000;
  };
  const mk = nice(max);
  let g = "";
  [0, 0.5, 1].forEach(f => {
    const y = T + ih * (1 - f);
    g += `<line x1="${L}" x2="${W - 6}" y1="${y}" y2="${y}" class="cg"/><text class="ax" x="${L - 4}" y="${y + 3}" text-anchor="end">${Math.round(mk * f)}</text>`;
  });
  r.months.forEach((m, i) => {
    const x = L + i * bw;
    const fut = r.is_current && m.month > r.data_to;
    if (m.distance_km > 0) {
      const h = ih * m.distance_km / mk;
      g += `<rect x="${x + 2}" y="${T + ih - h}" width="${Math.max(bw - 4, 2)}" height="${h}" rx="2" style="fill:var(--accent)"><title>${m.month} ${m.distance_km} km</title></rect>`;
    }
    if (fut) g += `<rect x="${x}" y="${T}" width="${bw}" height="${ih}" style="fill:var(--grid)" opacity=".5"/>`;
    const lab = currentLang() === "en"
      ? new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(new Date(`${m.month}-01T00:00:00Z`))
      : String(Number(m.month.slice(5)));
    if (i % 2 === 0 || n <= 12) g += `<text class="ax" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${lab}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${t("yr.monthAria")}">${g}</svg>`;
}

function yearHTML(r: YearReview) {
  const o = r.totals, yoy = r.yoy, h = r.highlights;
  const empty = o.drive_count === 0 && o.charge_count === 0;
  const per100 = o.cost_per_100km;
  const perKwh = o.cost_per_kwh ?? [];
  const perKwhTxt = perKwh.length
    ? perKwh.map(m => `${fmtMoney(m.amount, m.currency, true)}`).join(" + ")
    : "—";
  const split = h.charge_split;
  const splitTot = split.home_kwh + split.supercharger_kwh + split.other_kwh;
  const splitRow = (k: "home" | "supercharger" | "other", kwh: number) => {
    const pct = splitTot > 0 ? Math.round(kwh / splitTot * 100) : 0;
    return `<div class="yr-split-row"><span><i style="background:${COLORS[k]}"></i>${t(`mix.${k}`)}</span><b>${num(kwh, 1)} kWh</b><span class="muted">${pct}%</span></div>`;
  };
  const hl = (icon: string, label: string, title: string, val: string, attr = "") =>
    `<div class="card best best-stack" ${attr}>
      <div class="ic">${icon}</div>
      <div class="t"><small>${label}</small><b class="best-title">${title}</b><div class="best-val">${val}</div></div>
      ${attr ? `<div class="chev">›</div>` : ""}
    </div>`;

  return `
    ${r.partial && r.data_from ? `<div class="muted small-note">${t("yr.partialSince", { m: monthLabel(r.data_from) })}</div>` : ""}
    ${r.is_current && !r.data_from ? `<div class="muted small-note">${t("yr.partialCur", { m: monthLabel(r.data_to) })}</div>` : ""}
    ${empty ? `<div class="pane muted" style="text-align:center;margin-top:10px">${t("yr.empty")}</div>` : `
    <div class="ov">
      <div><small>${t("yr.distance")}</small><b>${num(o.distance_km)}<i>km</i></b>${yoyChip(yoy?.distance_pct, true)}</div>
      <div><small>${t("yr.driveTime")}</small><b>${Math.floor(o.drive_duration_min / 60)}<i>${t("rp.unitH")}</i>${o.drive_duration_min % 60}<i>${t("rp.unitM")}</i></b></div>
      <div><small>${t("yr.driveCount")}</small><b>${o.drive_count}<i>${t("rp.unitTimes")}</i></b>${yoyChip(yoy?.drive_count_pct, true)}</div>
      <div><small>${t("yr.used")}</small><b>${num(o.energy_used_kwh, 1)}<i>kWh</i></b>${yoyChip(yoy?.energy_used_pct, false)}</div>
      <div><small>${t("yr.charged")}</small><b>${num(o.energy_added_kwh, 1)}<i>kWh</i></b>${yoyChip(yoy?.energy_added_pct, false)}</div>
      <div><small>${t("yr.charges")}</small><b>${o.charge_count}<i>${t("rp.unitTimes")}</i></b></div>
    </div>
    <div class="section-title">${t("yr.effCost")}</div>
    <div class="ov">
      <div><small>${t("yr.avgEff")}</small><b>${o.efficiency_wh_km != null ? num(o.efficiency_wh_km, 1) : "—"}<i>Wh/km</i></b></div>
      <div><small>${t("yr.cost")}</small><b class="${o.costs.length > 1 ? "multi" : ""}">${costTxt(o.costs)}</b></div>
      <div><small>${t("yr.perKwh")}</small><b class="${perKwh.length > 1 ? "multi" : ""}">${perKwh.length ? `${perKwhTxt}<i>/kWh</i>` : "—"}</b></div>
      <div><small>${t("yr.per100")}</small><b class="${per100.length > 1 ? "multi" : ""}">${per100.length ? per100.map(m => fmtMoney(m.amount, m.currency)).join(" + ") : "—"}<i>/100 km</i></b></div>
    </div>
    <div class="section-title">${t("yr.byMonth")}</div>
    <div class="pane">${monthBars(r)}</div>
    <div class="section-title">${t("yr.chargeMix")}</div>
    <div class="pane">
      ${splitRow("home", split.home_kwh)}
      ${splitRow("supercharger", split.supercharger_kwh)}
      ${splitRow("other", split.other_kwh)}
      <div class="muted small-note" style="margin-top:8px">${t("yr.sucVisited", { n: h.superchargers_visited })}</div>
    </div>
    <div class="section-title">${t("yr.highlights")}</div>
    ${h.busiest_month ? hl(ic("chart"), t("yr.busiest"), monthLabel(h.busiest_month.month), `${num(h.busiest_month.distance_km)} km`,
      h.busiest_month ? `data-month="${h.busiest_month.month}"` : "") : ""}
    ${h.longest_drive ? hl(ic("route"), t("yr.longestDrive", { d: h.longest_drive.start_date ? fmtMonthDay(h.longest_drive.start_date) : "" }),
      `${esc(h.longest_drive.start_address)} → ${esc(h.longest_drive.end_address)}`,
      `${num(h.longest_drive.distance_km, 1)} km · ${fmtDur(h.longest_drive.duration_min)}`,
      `data-drive="${h.longest_drive.id}"`) : ""}
    ${h.longest_journey ? hl(ic("flag"), t("yr.longestJourney"), esc(h.longest_journey.name),
      `${num(h.longest_journey.distance_km, 1)} km · ${fmtDur(h.longest_journey.duration_min)}`,
      `data-journey="${h.longest_journey.id}"`) : ""}
    ${h.top_destinations.length ? `<div class="pane"><div class="section-title" style="margin:0 0 8px">${t("yr.topPlaces")}</div>
      ${h.top_destinations.map((p, i) => `<div class="yr-place"><span class="muted">${i + 1}</span><b>${esc(p.name)}</b><span>${t("yr.visits", { n: p.visits })}</span></div>`).join("")}
    </div>` : ""}
    ${yoy ? `<div class="section-title">${t("yr.yoyTitle", { y: r.year - 1 })}</div>
      <div class="pane muted small-note">${t("yr.yoyNote", {
        dist: num(yoy.previous.distance_km),
        drives: yoy.previous.drive_count,
      })}</div>` : ""}
    `}`;
}

function switcher(year: number, canPrev: boolean, canNext: boolean) {
  const chev = (d: string) => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return `<div class="msw"><div class="msw-pill" role="group" aria-label="${year}">
    <button class="msw-arrow" data-y="${year - 1}" ${canPrev ? "" : "disabled"} aria-label="${t("yr.prev")}">${chev("m14.5 6-6 6 6 6")}</button>
    <b class="msw-label">${t("yr.titleYear", { y: year })}</b>
    <button class="msw-arrow" data-y="${year + 1}" ${canNext ? "" : "disabled"} aria-label="${t("yr.next")}">${chev("m9.5 6 6 6-6 6")}</button>
  </div></div>`;
}

let gen = 0;

export async function showYear(view: HTMLElement, carId: number, year: number, nav: YearNav) {
  if (!Number.isFinite(year) || year < 2000 || year > 2100) year = nowYear();
  const g = ++gen;
  const canNext = year < nowYear();
  view.innerHTML = `<div id="yr-shell" class="yr-page">
    <button class="back" data-title="${t("yr.pageTitle")}">${t("common.back")}</button>
    <div id="yr-sw">${switcher(year, true, canNext)}</div>
    <div id="yr-body"><div class="pane muted" style="text-align:center">${t("common.loading")}</div></div>
  </div>`;
  const shell = view.querySelector("#yr-shell")!;
  (shell.querySelector(".back") as HTMLElement).onclick = nav.back;
  const bindSw = () => {
    shell.querySelectorAll<HTMLButtonElement>("button[data-y]").forEach(b => {
      b.onclick = () => { if (!b.disabled) nav.year(Number(b.dataset.y)); };
    });
  };
  bindSw();
  const body = shell.querySelector<HTMLElement>("#yr-body")!;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  try {
    if (lacks("yearReview")) throw Object.assign(new Error("old"), { status: 404 });
    const r = await api<YearReview>(`/api/cars/${carId}/year-review?year=${year}&tz=${encodeURIComponent(tz)}&currency=${defaultCurrency()}`);
    if (g !== gen) return;
    const canPrev = true; // server returns empty for years with no data
    (shell.querySelector("#yr-sw") as HTMLElement).innerHTML = switcher(year, canPrev, canNext);
    bindSw();
    body.innerHTML = yearHTML(r);
    body.querySelectorAll<HTMLElement>("[data-drive]").forEach(el => el.onclick = () => nav.drive(Number(el.dataset.drive)));
    body.querySelectorAll<HTMLElement>("[data-journey]").forEach(el => {
      el.onclick = () => nav.journey?.(Number(el.dataset.journey));
    });
    body.querySelectorAll<HTMLElement>("[data-month]").forEach(el => {
      el.onclick = () => nav.month?.(el.dataset.month!);
    });
  } catch (e) {
    if (g !== gen) return;
    const err = e as { status?: number; message?: string };
    body.innerHTML = `<div class="error card-error">${ic("alert")} ${
      err.status === 404 ? esc(featureText("yearReview")) : esc(t("yr.loadErr", { e: err.message || "" }))
    } <button class="retry">${t("common.retry")}</button></div>`;
    (body.querySelector(".retry") as HTMLElement).onclick = () => showYear(view, carId, year, nav);
  }
}
