// SPDX-License-Identifier: AGPL-3.0-or-later
// api_level 12: battery degradation page + home card, report footprint map + 12-month trends.
// api_level 14: battery health with TeslaMate's "Battery Health" dashboard method (`tm` in /battery); older servers / too
// little data fall back to the range-based estimate below.
// api_level 18: charging cost stats (cross-month unit economics).
import { skey } from "./demo";
import { ic } from "./icons";
import { api, fmtMoney, defaultCurrency, type Car } from "./api";
import { featureText, lacks, serverReady } from "./version";
import { DriveMap } from "./map";
import { t, monthLabel, fmtNum, fmtDateTime, fmtTime } from "./i18n";

const esc = (s: unknown) => String(s ?? "—").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const n = (v: number | null | undefined, d = 0) => fmtNum(v, d);

// ---------------- battery ----------------
interface BPoint { date: string; odometer_km: number | null; range100_km: number; end_level: number; capacity_kwh: number | null }
interface BMonth { month: string; range100_km: number; capacity_kwh: number | null; odometer_km: number | null; n: number }
export interface Battery { points: BPoint[]; months: BMonth[]; n_points: number; first_date: string | null;
  initial_range100_km: number | null; current_range100_km: number | null; retained_pct: number | null;
  capacity_from_range_kwh: number | null; capacity_from_energy_kwh: number | null; tm?: TmHealth }
/** api_level 14 — see tm_health() in api/src/insights.rs for the exact formulas. */
export interface BatTrend {
  enough_time: boolean; enough_odo: boolean;
  pct_per_10k_km: number | null; pct_per_year: number | null;
  no_measurable_degradation: boolean;
  projections: { odometer_km: number; capacity_kwh: number; health_pct: number }[];
  spark: number[]; months_span: number; km_span: number; n_halves: number;
}
export interface TmHealth { method: string; efficiency_kwh_100km: number | null; efficiency_source: "derived" | "car" | null;
  capacity_now_kwh: number | null; now_samples: number; capacity_max_kwh: number | null; capacity_new_kwh: number | null; new_source: string;
  health_pct: number | null; degradation_pct: number | null; cycles: number | null; energy_added_kwh: number | null; charges: number;
  points: { date: string; odometer_km: number | null; capacity_kwh: number }[];
  half_months: { period: string; odometer_km: number | null; capacity_kwh: number; n: number }[];
  trend?: BatTrend | null }

// ----- new capacity (kWh, TeslaMate "custom_kwh_new") -----
const KWH_KEY = skey("drivelens-battery-new-kwh");
export function newKwhOverride(carId: number): number | null {
  try { const v = JSON.parse(localStorage.getItem(KWH_KEY) || "{}")[carId]; return typeof v === "number" && v > 0 ? v : null; } catch { return null; }
}
const MIG_KEY = skey("drivelens-battery-kwh-migrated-");
export function setNewKwhOverride(carId: number, kwh: number | null) {
  localStorage.removeItem(MIG_KEY + carId);   // an explicit save / reset hides the "converted from km" note
  let m: Record<string, number> = {}; try { m = JSON.parse(localStorage.getItem(KWH_KEY) || "{}"); } catch { /* reset */ }
  if (kwh == null) delete m[carId]; else m[carId] = kwh;
  localStorage.setItem(KWH_KEY, JSON.stringify(m));
}
export interface TmView { health: number; degradation: number; now: number; max: number | null; newKwh: number; custom: boolean; cycles: number | null; migrated: boolean }
/** Health numbers with the user's new-capacity value applied client-side (same formulas as the dashboard / API).
 *  A km baseline saved by ≤ 1.0.x (100 % range when new) is converted once: kWh = km × efficiency (kWh / 100 km) ÷ 100. */
export function tmView(b: Battery, carId: number): TmView | null {
  const tm = b.tm; if (!tm || tm.capacity_now_kwh == null) return null;
  let migrated = false;
  const km = baselineOverride(carId);
  if (km && newKwhOverride(carId) == null && tm.efficiency_kwh_100km) {
    const v = Math.round(km * tm.efficiency_kwh_100km / 100 * 10) / 10;
    if (v >= 20 && v <= 250) { setNewKwhOverride(carId, v); localStorage.setItem(MIG_KEY + carId, "1"); }
    setBaselineOverride(carId, null);
  }
  migrated = localStorage.getItem(MIG_KEY + carId) === "1" && newKwhOverride(carId) != null;
  const ov = newKwhOverride(carId);
  const newKwh = ov ?? tm.capacity_max_kwh; if (newKwh == null || newKwh <= 0) return null;
  const r = tm.capacity_now_kwh * 100 / newKwh, r1 = (v: number) => Math.round(v * 10) / 10;
  return { health: r1(Math.min(100, r)), degradation: r1(Math.max(0, 100 - r)), now: tm.capacity_now_kwh, max: tm.capacity_max_kwh, newKwh, custom: ov != null,
    cycles: tm.energy_added_kwh != null ? Math.floor(tm.energy_added_kwh / newKwh) : null, migrated };
}

// ----- baseline (100 %) -----
/** Factory rated full-charge range (km) as reported by Tesla's API when new — EPA figures (TeslaMate "rated").
 *  Other markets' cars may report a different constant (e.g. some Japanese/Chinese cars show more), hence:
 *  baseline = user override ?? max(factory value, highest estimate seen in TeslaMate). */
const FACTORY: { re: RegExp; km: number; label: string }[] = [
  { re: /model\s*3.*(performance|\bp\b)/i, km: 507, label: "Model 3 Performance (EPA 315 mi)" },
  { re: /model\s*3.*(long range|\blr\b|awd)/i, km: 576, label: "Model 3 Long Range (EPA 358 mi)" },
  { re: /model\s*3/i, km: 438, label: "Model 3 RWD (EPA 272 mi)" },
  { re: /model\s*y.*(performance|\bp\b)/i, km: 488, label: "Model Y Performance (EPA 303 mi)" },
  { re: /model\s*y.*(long range|\blr\b|awd)/i, km: 531, label: "Model Y Long Range (EPA 330 mi)" },
  { re: /model\s*y/i, km: 418, label: "Model Y RWD (EPA 260 mi)" },
];
const OV_KEY = skey("drivelens-battery-baseline");
export function baselineOverride(carId: number): number | null {
  try { const v = JSON.parse(localStorage.getItem(OV_KEY) || "{}")[carId]; return typeof v === "number" && v > 0 ? v : null; } catch { return null; }
}
export function setBaselineOverride(carId: number, km: number | null) {
  let m: Record<string, number> = {}; try { m = JSON.parse(localStorage.getItem(OV_KEY) || "{}"); } catch { /* reset */ }
  if (km == null) delete m[carId]; else m[carId] = km;
  localStorage.setItem(OV_KEY, JSON.stringify(m));
}
export interface Baseline { km: number; source: string; raw_pct: number | null; pct: number | null; factory: { km: number; label: string } }
export function baseline(b: Battery, car: Car | null, carId: number): Baseline | null {
  const name = `Model ${car?.model ?? "3"} ${car?.marketing_name ?? ""}`;
  const f = FACTORY.find(x => x.re.test(name)) ?? FACTORY[2];
  const ov = baselineOverride(carId);
  const seen = Math.max(b.initial_range100_km ?? 0, b.current_range100_km ?? 0);
  let km: number, source: string;
  if (ov) { km = ov; source = t("bat.srcManual", { km: ov }); }
  else if (seen > f.km) { km = seen; source = t("bat.srcSeen", { f: f.km, km: Math.round(seen) }); }
  else { km = f.km; source = t("bat.srcFactory", { label: f.label, km: f.km }); }
  const raw = b.current_range100_km != null ? b.current_range100_km / km * 100 : null;
  return { km, source, raw_pct: raw == null ? null : Math.round(raw * 10) / 10, pct: raw == null ? null : Math.min(100, Math.round(raw * 10) / 10), factory: f };
}

export function batteryCardHTML(b: Battery, car: Car | null, carId: number) {
  const v = tmView(b, carId);
  if (v) return `<div class="section-title">${t("bat.title")} <a class="link" data-battery>${t("bat.openCurve")}</a></div>
    <div class="card bat-card" data-battery>
      <div class="bat-ring" style="--p:${v.health}"><b>${n(v.health, 1)}<small>%</small></b></div>
      <div class="bat-info tm">
        <div class="bat-kv"><div><small>${t("bat.now")}</small><b>${n(v.now, 1)}<i>kWh</i></b></div><div><small>${t("bat.new")}${v.custom ? "*" : ""}</small><b>${n(v.newKwh, 1)}<i>kWh</i></b></div>
          <div><small>${t("bat.degr")}</small><b>${n(v.degradation, 1)}<i>%</i></b></div><div><small>${t("bat.cycles")}</small><b>${v.cycles == null ? "—" : n(v.cycles)}</b></div></div>
        ${trendBlock(b.tm?.trend, "card")}
        <div class="muted small-note">${t("bat.tmSame")}</div></div>
    </div>`;
  const bl = baseline(b, car, carId);
  if (!b.n_points || !bl || bl.pct == null) return `<div class="section-title">${t("bat.title")}</div><div class="card" data-battery><div class="muted">${t("bat.notEnough")}</div></div>`;
  return `<div class="section-title">${t("bat.title")} <a class="link" data-battery>${t("bat.openCurve")}</a></div>
    <div class="card bat-card" data-battery>
      <div class="bat-ring" style="--p:${bl.pct}"><b>${n(bl.pct, 1)}<small>%</small></b></div>
      <div class="bat-info"><div><small>${t("bat.range100")}</small><b>${n(b.current_range100_km)} km</b><span class="muted">${t("bat.vsBase", { km: n(bl.km) })}</span></div>
        <div><small>${t("bat.capacity")}</small><b>${n(b.capacity_from_range_kwh, 1)} kWh</b></div>
        <div class="muted small-note">${b.first_date ? t("bat.since", { m: monthLabel(b.first_date) }) : ""}${t("bat.nCharges", { n: b.n_points })}<br>${esc(t("bat.baselineIs", { s: bl.source }))}</div></div>
    </div>`;
}


function fmtRate(v: number | null | undefined): string {
  if (v == null) return "—";
  if (Math.abs(v) < 0.05) return "0";
  const s = n(v, 1);
  return v > 0 ? `+${s}` : s;
}
/** Compact sparkline for half-month capacity medians (home card). */
function batSpark(vals: number[]): string {
  if (vals.length < 2) return "";
  const W = 120, H = 28, P = 2;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = Math.max(0.2, hi - lo);
  const X = (i: number) => P + (W - 2 * P) * i / (vals.length - 1);
  const Y = (v: number) => H - P - (H - 2 * P) * (v - lo) / span;
  const d = vals.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("");
  return `<svg class="bat-spark" viewBox="0 0 ${W} ${H}" width="120" height="28" aria-hidden="true"><path d="${d}" class="bat-spark-line"/></svg>`;
}
function trendBlock(tr: BatTrend | null | undefined, kind: "page" | "card"): string {
  if (!tr) return "";
  if (kind === "card") {
    const spark = batSpark(tr.spark);
    const chip = tr.no_measurable_degradation ? t("bat.noDegrade")
      : tr.pct_per_year != null ? t("bat.rateChip", { v: fmtRate(tr.pct_per_year) })
      : "";
    if (!spark && !chip) return "";
    return `<div class="bat-trend-row">${spark}${chip ? `<span class="bat-rate-chip">${esc(chip)}</span>` : ""}</div>`;
  }
  const hasRate = tr.enough_time || tr.enough_odo;
  let body: string;
  if (!hasRate) {
    body = `<div class="muted">${t("bat.trendNeed")} · ${t("bat.trendShort")}</div>`;
  } else if (tr.no_measurable_degradation) {
    body = `<div class="bat-kv"><div><small>${t("bat.trend")}</small><b>${t("bat.noDegrade")}</b></div></div>`;
  } else {
    body = `<div class="bat-kv">
      <div><small>${t("bat.rate10k")}</small><b>${tr.pct_per_10k_km == null ? "—" : fmtRate(tr.pct_per_10k_km)}</b></div>
      <div><small>${t("bat.rateYear")}</small><b>${tr.pct_per_year == null ? "—" : fmtRate(tr.pct_per_year)}</b></div>
    </div>`;
  }
  let proj = "";
  if (tr.enough_odo && tr.projections.length) {
    proj = `<div class="section-title" style="margin-top:10px">${t("bat.proj")}</div><div class="bat-kv">` +
      tr.projections.map(p => {
        const kmLabel = p.odometer_km >= 1000 ? `${n(p.odometer_km / 1000, 0)}k` : n(p.odometer_km);
        return `<div><small>${t("bat.projAt", { km: kmLabel })}</small><b>${t("bat.projVal", { kwh: n(p.capacity_kwh, 1), pct: n(p.health_pct, 1) })}</b></div>`;
      }).join("") + `</div>`;
  }
  return `<div class="pane bat-trend-pane"><div class="pane-t">${t("bat.trend")}</div>${body}${proj}
    <div class="muted small-note">${hasRate ? t("bat.trendNote") : t("bat.trendShort")}</div></div>`;
}

/** least-squares line y = a + b·x */
function fit(xs: number[], ys: number[]) {
  const m = xs.length; if (m < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / m, my = ys.reduce((a, b) => a + b, 0) / m;
  let sxy = 0, sxx = 0; for (let i = 0; i < m; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  if (!sxx) return null; const b = sxy / sxx; return { a: my - b * mx, b };
}

function scatter(pts: { x: number; y: number }[], med: { x: number; y: number }[], o: { xLabel: (x: number) => string; yUnit: string; ref?: number; refText?: string; lg?: [string, string]; trend?: boolean }) {
  if (pts.length < 2) return `<div class="chart-empty">${t("chart.notEnough")}</div>`;
  const W = 392, H = 200, L = 40, R = 10, T = 12, B = 24, iw = W - L - R, ih = H - T - B;
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const sorted = [...ys].sort((a, b) => a - b), q = (f: number) => sorted[Math.floor(f * (sorted.length - 1))];
  let lo = Math.min(q(0.02), ...med.map(m => m.y), o.ref ?? Infinity), hi = Math.max(q(0.98), ...med.map(m => m.y), o.ref ?? -Infinity);
  const pad = Math.max(2, (hi - lo) * 0.12); lo = Math.floor(lo - pad); hi = Math.ceil(hi + pad);
  const X = (x: number) => L + iw * (x1 > x0 ? (x - x0) / (x1 - x0) : 0.5), Y = (y: number) => T + ih * (1 - (y - lo) / (hi - lo));
  let g = "";
  [0, 0.5, 1].forEach(f => { const v = lo + (hi - lo) * f; g += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" class="cg"/><text x="${L - 4}" y="${Y(v) + 3}" text-anchor="end" class="ct">${Math.round(v)}</text>`; });
  [0, 0.5, 1].forEach(f => { const x = x0 + (x1 - x0) * f; g += `<text x="${X(x)}" y="${H - 6}" text-anchor="${f === 0 ? "start" : f === 1 ? "end" : "middle"}" class="ct">${o.xLabel(x)}</text>`; });
  const dots = pts.map(p => p.y >= lo && p.y <= hi ? `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="2" class="bdot"/>` : "").join("");
  const mline = med.length > 1 ? `<path d="${med.map((m, i) => `${i ? "L" : "M"}${X(m.x).toFixed(1)},${Y(m.y).toFixed(1)}`).join("")}" class="bmed"/>` : "";
  const f = o.trend === false ? null : fit(xs, ys);
  const tl = f ? `<line x1="${X(x0)}" y1="${Y(f.a + f.b * x0)}" x2="${X(x1)}" y2="${Y(f.a + f.b * x1)}" class="btrend"/>` : "";
  const rl = o.ref != null ? `<line x1="${L}" x2="${W - R}" y1="${Y(o.ref)}" y2="${Y(o.ref)}" class="bref"/><text x="${W - R}" y="${Y(o.ref) - 4}" text-anchor="end" class="ct">${o.refText ?? t("bat.ref", { v: Math.round(o.ref) })}</text>` : "";
  return `<div class="chart-box"><svg viewBox="0 0 ${W} ${H}" width="100%">${g}${rl}${dots}${mline}${tl}</svg>
    <div class="legend"><span><i class="lg-dot"></i>${o.lg?.[0] ?? t("bat.lgPoint")}</span><span><i class="lg-med"></i>${o.lg?.[1] ?? t("bat.lgMedian")}</span>${f ? `<span><i class="lg-trend"></i>${t("bat.lgTrend")}</span>` : ""}${o.yUnit ? `<span>${o.yUnit}</span>` : ""}</div></div>`;
}

export async function showBattery(view: HTMLElement, carId: number, back: () => void, car: Car | null = null) {
  view.innerHTML = `<button class="back" data-title="${t("bat.pageTitle")}">${t("common.back")}</button><div class="muted">${t("common.loading")}</div>`;
  (view.querySelector(".back") as HTMLElement).onclick = back;
  let b: Battery;
  try { b = await api<Battery>(`/api/cars/${carId}/battery?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC")}`); }
  catch (e) { view.insertAdjacentHTML("beforeend", `<div class="error">${ic("alert")} ${esc((e as Error).message)}</div>`); return; }
  const v = tmView(b, carId);
  if (v) { tmPage(view, b, v, carId, back, car); return; }
  const bl = baseline(b, car, carId)!;
  const tms = (d: string) => new Date(d).getTime(), day = 864e5;
  const pts = b.points.map(p => ({ x: tms(p.date), y: p.range100_km }));
  const med = b.months.map(m => ({ x: tms(m.month + "-15T00:00:00Z"), y: m.range100_km }));
  const f = fit(pts.map(p => p.x / day / 365), pts.map(p => p.y));
  const perYear = f ? f.b / bl.km * 100 : null;
  const odo = b.points.filter(p => p.odometer_km != null).map(p => ({ x: p.odometer_km!, y: p.range100_km }));
  const odoMed = b.months.filter(m => m.odometer_km != null).map(m => ({ x: m.odometer_km!, y: m.range100_km }));
  const capPts = b.points.filter(p => p.capacity_kwh != null && p.capacity_kwh > 20 && p.capacity_kwh < 150).map(p => ({ x: tms(p.date), y: p.capacity_kwh! }));
  const capMed = b.months.filter(m => m.capacity_kwh != null).map(m => ({ x: tms(m.month + "-15T00:00:00Z"), y: m.capacity_kwh! }));
  const ym = (x: number) => { const d = new Date(x); return `${d.getFullYear()}/${d.getMonth() + 1}`; };
  const odoSpan = odo.length ? Math.max(...odo.map(p => p.x)) - Math.min(...odo.map(p => p.x)) : 0;
  view.innerHTML = `<button class="back" data-title="${t("bat.pageTitle")}">${t("common.back")}</button>
    <div class="ov">
      <div><small>${t("bat.retention")}</small><b>${n(bl.pct, 1)}<i>%</i></b><div class="d neu">${t("bat.curVsBase", { km: n(bl.km) })}${bl.raw_pct != null && bl.raw_pct > 100 ? t("bat.rawPct", { v: n(bl.raw_pct, 1) }) : ""}</div></div>
      <div><small>${t("bat.range100")}</small><b>${n(b.current_range100_km)}<i>km</i></b><div class="d neu">${t("bat.initial", { km: n(b.initial_range100_km) })}</div></div>
      <div><small>${t("bat.capRange")}</small><b>${n(b.capacity_from_range_kwh, 1)}<i>kWh</i></b></div>
      <div><small>${t("bat.perYear")}</small><b class="${perYear != null && perYear < 0 ? "dn" : ""}">${perYear == null ? "—" : `${perYear > 0 ? "+" : ""}${n(perYear, 1)}`}<i>${t("bat.perYearUnit")}</i></b></div>
    </div>
    <div class="pane bl-box"><div class="pane-t">${t("bat.base100")}</div>
      <div class="muted bl-src">${esc(bl.source)}${b.first_date ? t("bat.tmSince", { m: monthLabel(b.first_date) }) : ""}</div>
      <div class="bl-row"><input id="bl-km" type="number" min="100" max="1000" step="1" placeholder="${t("bat.basePh")}" value="${baselineOverride(carId) ?? ""}">
        <button id="bl-save" class="primary small">${t("common.save")}</button>${baselineOverride(carId) ? `<button id="bl-reset" class="ghost small">${t("bat.reset")}</button>` : ""}</div>
      <details class="bl-more"><summary>${t("common.details")}</summary><div class="muted small-note">${esc(t("bat.baseHint", { label: bl.factory.label, km: bl.factory.km }))}</div></details></div>
    <div class="section-title">${t("bat.overTime")}</div>${scatter(pts, med, { xLabel: ym, yUnit: "km", ref: bl.km })}
    <div class="section-title">${t("bat.overOdo")}</div>${odoSpan > 100 ? scatter(odo, odoMed, { xLabel: x => `${n(x / 1000, 0)}k km`, yUnit: "km" }) : `<div class="chart-empty">${t("bat.noOdo")}</div>`}
    <div class="section-title">${t("bat.capEst")}</div>${capPts.length > 2 ? scatter(capPts, capMed, { xLabel: ym, yUnit: "kWh" }) : `<div class="chart-empty">${t("bat.needBig")}</div>`}
    <div class="muted small-note bat-method">${t("bat.method")}
      ${t("bat.method2", { recent: b.capacity_from_energy_kwh ? t("bat.recent", { v: n(b.capacity_from_energy_kwh, 1) }) : "" })}</div>`;
  (view.querySelector(".back") as HTMLElement).onclick = back;
  const again = () => showBattery(view, carId, back, car);
  (view.querySelector("#bl-save") as HTMLElement).onclick = () => {
    const v = Number((view.querySelector("#bl-km") as HTMLInputElement).value);
    const box = view.querySelector(".bl-box")!; box.querySelector(".bl-err")?.remove();
    if (!(v >= 100 && v <= 1000)) {
      box.querySelector(".bl-row")!.insertAdjacentHTML("afterend", `<div class="error bl-err" role="alert">${esc(t("bat.invalid"))}</div>`);
      (view.querySelector("#bl-km") as HTMLInputElement).focus(); return;
    }
    setBaselineOverride(carId, Math.round(v)); again();
  };
  const rs = view.querySelector<HTMLElement>("#bl-reset"); if (rs) rs.onclick = () => { setBaselineOverride(carId, null); again(); };
}

/** Battery page, TeslaMate method (api_level 14). */
function tmPage(view: HTMLElement, b: Battery, v: TmView, carId: number, back: () => void, car: Car | null) {
  const tm = b.tm!;
  const half = (p: string) => Date.UTC(Number(p.slice(0, 4)), Number(p.slice(4, 6)) - 1, p.endsWith("1") ? 8 : 23);
  const odo = tm.points.filter(p => p.odometer_km != null).map(p => ({ x: p.odometer_km!, y: p.capacity_kwh }));
  const odoMed = tm.half_months.filter(h => h.odometer_km != null).map(h => ({ x: h.odometer_km!, y: h.capacity_kwh }));
  const time = tm.points.map(p => ({ x: Date.parse(p.date + "T12:00:00Z"), y: p.capacity_kwh }));
  const timeMed = tm.half_months.map(h => ({ x: half(h.period), y: h.capacity_kwh }));
  const odoSpan = odo.length ? Math.max(...odo.map(p => p.x)) - Math.min(...odo.map(p => p.x)) : 0;
  const ym = (x: number) => { const d = new Date(x); return `${d.getFullYear()}/${d.getMonth() + 1}`; };
  const lg: [string, string] = [t("bat.lgDay"), t("bat.lgHalf")];
  const ovv = newKwhOverride(carId);
  view.innerHTML = `<button class="back" data-title="${t("bat.pageTitle")}">${t("common.back")}</button>
    <div class="ov">
      <div><small>${t("bat.health")}</small><b>${n(v.health, 1)}<i>%</i></b><div class="d neu">${t("bat.nowVsNew")}</div></div>
      <div><small>${t("bat.degr")}</small><b class="${v.degradation > 0 ? "dn" : ""}">${n(v.degradation, 1)}<i>%</i></b><div class="d neu">${t("bat.lost", { v: n(Math.max(0, v.newKwh - v.now), 1) })}</div></div>
      <div><small>${t("bat.now")}</small><b>${n(v.now, 1)}<i>kWh</i></b><div class="d neu">${t("bat.nowNote", { n: tm.now_samples })}</div></div>
      <div><small>${t(v.custom ? "bat.newSet" : "bat.new")}</small><b>${n(v.newKwh, 1)}<i>kWh</i></b><div class="d neu">${v.custom && v.max != null ? t("bat.tmMax", { v: n(v.max, 1) }) : t("bat.maxNote")}</div></div>
      <div><small>${t("bat.cycles")}</small><b>${v.cycles == null ? "—" : n(v.cycles)}</b><div class="d neu">${t("bat.added", { v: n(tm.energy_added_kwh) })}</div></div>
      <div><small>${t("bat.eff")}</small><b>${n(tm.efficiency_kwh_100km, 1)}<i>kWh/100km</i></b><div class="d neu">${t(tm.efficiency_source === "car" ? "bat.effCar" : "bat.effDerived")}</div></div>
    </div>
    ${trendBlock(tm.trend, "page")}
    <div class="pane bl-box"><div class="pane-t">${t("bat.newTitle")}</div>
      <div class="muted bl-src">${esc(v.custom ? t("bat.srcKwhManual", { v: n(v.newKwh, 1) }) : t("bat.srcKwhMax", { v: n(v.max, 1) }))}${v.migrated ? `<br>${esc(t("bat.migrated"))}` : ""}</div>
      <div class="bl-row"><input id="bl-kwh" type="number" inputmode="decimal" min="20" max="250" step="0.1" placeholder="${t("bat.newPh")}" value="${ovv ?? ""}" aria-label="${t("bat.newPh")}">
        <button id="bl-save" class="primary small">${t("common.save")}</button>${ovv ? `<button id="bl-reset" class="ghost small">${t("bat.reset")}</button>` : ""}</div>
      <details class="bl-more"><summary>${t("common.details")}</summary><div class="muted small-note">${esc(t("bat.newHint"))}</div></details></div>
    <div class="section-title">${t("bat.capOdo")}</div>${odoSpan > 100 && odo.length > 1 ? scatter(odo, odoMed, { xLabel: x => `${n(x / 1000, 0)}k km`, yUnit: "kWh", ref: v.newKwh, refText: t("bat.refNew", { v: n(v.newKwh, 1) }), lg, trend: false }) : `<div class="chart-empty">${t("bat.noOdo")}</div>`}
    <div class="section-title">${t("bat.capTime")}</div>${scatter(time, timeMed, { xLabel: ym, yUnit: "kWh", ref: v.newKwh, refText: t("bat.refNew", { v: n(v.newKwh, 1) }), lg })}
    <div class="muted small-note bat-method"><b>${t("bat.tmSame")}</b><br>${t("bat.tmMethod")}<br>${t("bat.tmSanity")}</div>`;
  (view.querySelector(".back") as HTMLElement).onclick = back;
  const again = () => showBattery(view, carId, back, car);
  (view.querySelector("#bl-save") as HTMLElement).onclick = () => {
    const inp = view.querySelector("#bl-kwh") as HTMLInputElement, x = Number(inp.value.replace(",", "."));
    const box = view.querySelector(".bl-box")!; box.querySelector(".bl-err")?.remove();
    if (!inp.value.trim() || !(x >= 20 && x <= 250)) {
      box.querySelector(".bl-row")!.insertAdjacentHTML("afterend", `<div class="error bl-err" role="alert">${esc(t("bat.invalidKwh"))}</div>`);
      inp.focus(); return;
    }
    setNewKwhOverride(carId, Math.round(x * 10) / 10); again();
  };
  const rs = view.querySelector<HTMLElement>("#bl-reset"); if (rs) rs.onclick = () => { setNewKwhOverride(carId, null); again(); };
}

// ---------------- report: footprint + trends ----------------
interface Money { currency: string; amount: number }
interface TM { month: string; distance_km: number; energy_used_kwh: number; energy_added_kwh: number; efficiency_wh_km: number | null;
  drive_count: number; charge_count: number; costs: Money[]; home_kwh: number; supercharger_kwh: number; other_kwh: number }

function barChart(ms: TM[], val: (m: TM) => number | null, cur: string, unit: string, color: string, d = 0) {
  const W = 392, H = 150, L = 6, R = 6, T = 18, B = 20, iw = W - L - R, ih = H - T - B;
  const vs = ms.map(val), max = Math.max(...vs.map(v => v ?? 0), 1e-9);
  const bw = iw / ms.length;
  const bars = ms.map((m, i) => { const v = vs[i] ?? 0, h = ih * v / max, x = L + i * bw + bw * 0.18, on = m.month === cur;
    return `<rect x="${x.toFixed(1)}" y="${(T + ih - h).toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${Math.max(h, v ? 1 : 0).toFixed(1)}" rx="3" style="fill:${color}" opacity="${on ? 1 : 0.4}"/>
      <text x="${(L + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="ct${on ? " on" : ""}">${Number(m.month.slice(5))}</text>
      ${on && vs[i] != null ? `<text x="${(L + i * bw + bw / 2).toFixed(1)}" y="${(T + ih - h - 4).toFixed(1)}" text-anchor="middle" class="ct on">${n(vs[i], d)}</text>` : ""}`; }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">${bars}</svg><div class="muted small-note" style="text-align:right">${unit}</div>`;
}
function lineChart(ms: TM[], val: (m: TM) => number | null, cur: string, unit: string) {
  const W = 392, H = 150, L = 34, R = 10, T = 16, B = 20, iw = W - L - R, ih = H - T - B;
  const pts = ms.map((m, i) => ({ i, v: val(m), m }));
  const vs = pts.filter(p => p.v != null).map(p => p.v!);
  if (vs.length < 2) return `<div class="chart-empty">${t("chart.notEnough")}</div>`;
  let lo = Math.min(...vs), hi = Math.max(...vs); const pad = Math.max(5, (hi - lo) * 0.2); lo = Math.floor(lo - pad); hi = Math.ceil(hi + pad);
  const X = (i: number) => L + iw * (i + 0.5) / ms.length, Y = (v: number) => T + ih * (1 - (v - lo) / (hi - lo));
  const path = pts.filter(p => p.v != null).map((p, k) => `${k ? "L" : "M"}${X(p.i).toFixed(1)},${Y(p.v!).toFixed(1)}`).join("");
  let g = ""; [0, 0.5, 1].forEach(f => { const v = lo + (hi - lo) * f; g += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" class="cg"/><text x="${L - 4}" y="${Y(v) + 3}" text-anchor="end" class="ct">${Math.round(v)}</text>`; });
  const dots = pts.map(p => p.v == null ? "" : `<circle cx="${X(p.i)}" cy="${Y(p.v)}" r="${p.m.month === cur ? 4.5 : 3}" class="${p.m.month === cur ? "ldot on" : "ldot"}"/>`).join("");
  const labels = pts.map(p => `<text x="${X(p.i)}" y="${H - 6}" text-anchor="middle" class="ct${p.m.month === cur ? " on" : ""}">${Number(p.m.month.slice(5))}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">${g}<path d="${path}" class="lline"/>${dots}${labels}</svg><div class="muted small-note" style="text-align:right">${unit}</div>`;
}
function mixChart(ms: TM[], cur: string) {
  const W = 392, H = 150, L = 6, R = 6, T = 8, B = 20, iw = W - L - R, ih = H - T - B, bw = iw / ms.length;
  const C = { home: "var(--mix-home)", supercharger: "var(--mix-sc)", other: "var(--mix-other)" };
  const bars = ms.map((m, i) => {
    const tot = m.home_kwh + m.supercharger_kwh + m.other_kwh, x = L + i * bw + bw * 0.18, w = bw * 0.64;
    let y = T + ih, out = "";
    if (tot > 0) for (const [k, v] of [["home", m.home_kwh], ["supercharger", m.supercharger_kwh], ["other", m.other_kwh]] as [keyof typeof C, number][]) {
      const h = ih * v / tot; y -= h; if (h > 0) out += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" style="fill:${C[k]}"/>`; }
    else out = `<rect x="${x.toFixed(1)}" y="${T + ih - 2}" width="${w.toFixed(1)}" height="2" style="fill:var(--track)"/>`;
    return out + `<text x="${(L + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="ct${m.month === cur ? " on" : ""}">${Number(m.month.slice(5))}</text>`; }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">${bars}</svg>
    <div class="lg"><span><i style="background:${C.home}"></i>${t("mix.home")}</span><span><i style="background:${C.supercharger}"></i>${t("mix.supercharger")}</span><span><i style="background:${C.other}"></i>${t("mix.other")}</span><span>${t("mix.byEnergy")}</span></div>`;
}

export function trendsHTML(ms: TM[], cur: string) {
  const curs = [...new Set(ms.flatMap(m => m.costs.map(c => c.currency)))];
  const main = curs.includes(defaultCurrency()) ? defaultCurrency() : curs[0];
  const costOf = (m: TM, c: string) => m.costs.find(x => x.currency === c)?.amount ?? 0;
  const sum = (f: (m: TM) => number) => ms.reduce((a, m) => a + f(m), 0);
  const km = sum(m => m.distance_km), kwh = sum(m => m.energy_used_kwh);
  return `<div class="section-title">${t("tr.title")}</div>
    <div class="pane"><div class="kpi"><div><small>${t("tr.km12")}</small><b>${n(km)} km</b></div><div><small>${t("tr.used")}</small><b>${n(kwh)} kWh</b></div>
      <div><small>${t("tr.avgEff")}</small><b>${km > 0 ? n(kwh * 1000 / km) : "—"} Wh/km</b></div></div></div>
    <div class="pane"><div class="pane-t">${t("tr.distance")}</div>${barChart(ms, m => m.distance_km, cur, "km", "var(--ch-1)")}</div>
    <div class="pane"><div class="pane-t">${t("tr.used")}</div>${barChart(ms, m => m.energy_used_kwh, cur, "kWh", "var(--violet)")}</div>
    <div class="pane"><div class="pane-t">${t("tr.avgEff")}</div>${lineChart(ms, m => m.efficiency_wh_km, cur, "Wh/km")}</div>
    ${curs.length ? curs.map(c => `<div class="pane"><div class="pane-t">${t("tr.cost")} · ${esc(c)} <span class="muted">${t("tr.total", { v: fmtMoney(sum(m => costOf(m, c)), c) })}</span></div>${barChart(ms, m => costOf(m, c), cur, c, c === main ? "var(--red)" : "var(--amber)")}</div>`).join("")
      : `<div class="pane"><div class="pane-t">${t("tr.cost")}</div><div class="chart-empty">${t("tr.noCost")}</div></div>`}
    <div class="pane"><div class="pane-t">${t("tr.mix")}</div>${mixChart(ms, cur)}</div>`;
}

type Foot = { lines: [number, number][][]; points: number; raw_points: number };
const footCache = new Map<string, Foot>();
let trendWin: { car: number; months: TM[] } | null = null;
let extrasGen = 0;
/** 足迹 + 趋势 into `box` (persistent across month changes). Cached per month; the 12-month trends are only
 *  re-highlighted when the month is inside the window already shown (no refetch, no re-entrance). */
export async function loadReportExtras(box: HTMLElement, carId: number, month: string, setMap: (m: DriveMap | null) => void) {
  const g = ++extrasGen, tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const alive = () => g === extrasGen && document.body.contains(box);
  if (!box.querySelector("#rp-foot")) box.innerHTML = `<div id="rp-foot"></div><div id="rp-trends"><div class="section-title">${t("tr.title")}</div><div class="pane"><span class="sk" style="width:100%;height:140px;display:block"></span></div></div>`;
  const foot = box.querySelector<HTMLElement>("#rp-foot")!, trends = box.querySelector<HTMLElement>("#rp-trends")!;
  const fkey = `${carId}:${month}`;
  const drawFoot = (f: Foot) => {
    if (!f.lines.length) { foot.innerHTML = `<div class="section-title">${t("fp.title")}</div><div class="chart-empty">${t("fp.none")}</div>`; setMap(null); return; }
    foot.innerHTML = `<div class="section-title">${t("fp.title")}</div><div id="fmap" class="foot-map"></div><div class="muted small-note" id="fnote"></div>`;
    const m = new DriveMap(foot.querySelector<HTMLElement>("#fmap")!, { lines: f.lines.map(l => ({ coords: l, speeds: l.map(() => null) })), speedColor: false, noPins: true });
    setMap(m);
    foot.querySelector("#fnote")!.textContent = t("fp.note", { n: f.lines.length }) + (f.raw_points > f.points ? t("fp.simplified", { a: n(f.points), b: n(f.raw_points) }) : "");
  };
  const fc = footCache.get(fkey);
  if (fc) drawFoot(fc);
  else {
    foot.innerHTML = `<div class="section-title">${t("fp.title")}</div><div id="fmap" class="foot-map"><div class="map-ph sk" style="height:100%"></div></div><div class="muted small-note" id="fnote"></div>`;
    api<Foot>(`/api/cars/${carId}/footprint?month=${month}&tz=${encodeURIComponent(tz)}`).then(f => { footCache.set(fkey, f); if (alive()) drawFoot(f); })
      .catch(e => { if (alive()) foot.innerHTML = `<div class="section-title">${t("fp.title")}</div><div class="error">${esc(t("fp.err", { e: (e as Error).message }))}</div>`; });
  }
  if (trendWin && trendWin.car === carId && trendWin.months.some(m => m.month === month)) {
    trends.innerHTML = trendsHTML(trendWin.months, month);   // same window: just move the highlight
    return;
  }
  if (trends.querySelector("svg")) trends.style.opacity = ".55";
  api<{ months: TM[] }>(`/api/cars/${carId}/trends?month=${month}&tz=${encodeURIComponent(tz)}&currency=${defaultCurrency()}`).then(r => {
    if (!alive()) return; trendWin = { car: carId, months: r.months }; trends.style.opacity = ""; trends.innerHTML = trendsHTML(r.months, month);
  }).catch(e => { if (alive()) { trends.style.opacity = ""; trends.innerHTML = `<div class="error">${esc(t("tr.err", { e: (e as Error).message }))}</div>`; } });
}


// ---------------- Vampire drain (api_level ≥ 17) ----------------
export type Vampire = {
  days: number;
  timezone: string;
  from: string;
  summary: {
    parked_hours: number;
    soc_lost_pct: number | null;
    range_lost_km: number | null;
    avg_soc_per_day: number | null;
    avg_range_km_per_day: number | null;
    period_count: number;
  };
  periods: {
    start: string; end: string; duration_hours: number;
    start_soc: number | null; end_soc: number | null; soc_lost: number | null;
    start_rated_km: number | null; end_rated_km: number | null; range_lost_km: number | null;
    ongoing: boolean;
  }[];
};

function fmtHours(h: number) {
  if (h >= 24) return `${n(h / 24, 1)} d`;
  return `${n(h, 1)} h`;
}

/** Same calendar day → "11/4 12:12 → 19:42"; ongoing → "… → now"; else full short datetimes. */
export function fmtParkSpan(start: string, end: string, ongoing: boolean) {
  const a = new Date(start), b = new Date(end);
  if (Number.isNaN(a.getTime())) return "—";
  const left = fmtDateTime(start);
  if (ongoing) return `${left} → ${t("vamp.now")}`;
  if (Number.isNaN(b.getTime())) return left;
  const sameDay = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  return sameDay ? `${left} → ${fmtTime(end)}` : `${left} → ${fmtDateTime(end)}`;
}

function lostSummary(s: Vampire["summary"]) {
  if (s.soc_lost_pct == null && s.range_lost_km == null) return "";
  const pct = s.soc_lost_pct == null ? "—" : String(s.soc_lost_pct);
  const km = s.range_lost_km == null ? "—" : n(s.range_lost_km, 1);
  return t("vamp.lostSummary", { pct, km, n: s.period_count });
}

function ringPct(avg: number | null) {
  // Map ~0–5 %/d into the ring fill (higher drain → less fill left).
  if (avg == null) return 90;
  return Math.max(8, 100 - Math.min(100, Math.round(avg * 20)));
}

export function vampireCardHTML(v: Vampire) {
  const s = v.summary;
  const avg = s.avg_soc_per_day;
  const lost = lostSummary(s);
  return `<div class="section-title">${t("vamp.title")} <a class="link" data-vampire>${t("vamp.open")}</a></div>
    <div class="card bat-card vamp-card" data-vampire>
      <div class="bat-ring" style="--p:${ringPct(avg)}"><b>${avg == null ? "—" : n(avg, 1)}<small>%/d</small></b></div>
      <div class="bat-info tm">
        <div class="bat-kv">
          <div><small>${t("vamp.avgDay")}</small><b>${avg == null ? "—" : `${n(avg, 1)}%`}</b></div>
          <div><small>${t("vamp.parked")}</small><b>${fmtHours(s.parked_hours)}</b></div>
          <div><small>${t("vamp.days", { n: v.days })}</small><b>${t("vamp.periods", { n: s.period_count })}</b></div>
          <div><small>${t("vamp.range")}</small><b>${s.range_lost_km == null ? "—" : `−${n(s.range_lost_km, 1)} km`}</b></div>
        </div>
        ${lost ? `<div class="vamp-lost-sum">${esc(lost)}</div>` : ""}
        <div class="muted small-note">${t("vamp.hint")}</div>
      </div>
    </div>`;
}

export async function showVampire(view: HTMLElement, carId: number, back: () => void) {
  view.innerHTML = `<button class="back" data-title="${t("vamp.pageTitle")}">${t("common.back")}</button><div class="muted">${t("common.loading")}</div>`;
  (view.querySelector(".back") as HTMLElement).onclick = back;
  await serverReady();
  if (lacks("vampire")) {
    view.insertAdjacentHTML("beforeend", `<div class="error card-error">${ic("alert")} ${esc(featureText("vampire"))}</div><div class="muted">${t("vamp.needServer")}</div>`);
    return;
  }
  let v: Vampire;
  try {
    v = await api<Vampire>(`/api/cars/${carId}/vampire?days=30&tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC")}`);
  } catch (e) {
    view.insertAdjacentHTML("beforeend", `<div class="error">${ic("alert")} ${esc(t("vamp.err", { e: (e as Error).message }))}</div>`);
    return;
  }
  const s = v.summary;
  const lost = lostSummary(s);
  const rows = v.periods.length === 0
    ? `<div class="empty"><span>${t("vamp.empty")}</span></div>`
    : v.periods.map(p => {
      const soc = p.soc_lost == null ? "—" : `−${p.soc_lost}%`;
      const range = p.range_lost_km == null ? "" : ` · −${n(p.range_lost_km, 1)} km`;
      const socLine = (p.start_soc != null && p.end_soc != null)
        ? `${p.start_soc}% → ${p.end_soc}%`
        : "—";
      return `<div class="card vamp-period">
        <div class="row"><b>${fmtHours(p.duration_hours)}</b>${p.ongoing ? `<span class="muted">${t("vamp.ongoing")}</span>` : ""}
          <b class="vamp-lost">${soc}${range}</b></div>
        <div class="row muted">${esc(fmtParkSpan(p.start, p.end, p.ongoing))}</div>
        <div class="stats"><span>${ic("battery")} ${t("vamp.soc")} ${socLine}</span>
          ${p.start_rated_km != null && p.end_rated_km != null ? `<span>${ic("route")} ${t("vamp.range")} ${n(p.start_rated_km, 1)} → ${n(p.end_rated_km, 1)} km</span>` : ""}</div>
      </div>`;
    }).join("");
  view.innerHTML = `<button class="back" data-title="${t("vamp.pageTitle")}">${t("common.back")}</button>
    <div class="pane" style="margin-top:12px">
      <div class="card bat-card vamp-card">
        <div class="bat-ring" style="--p:${ringPct(s.avg_soc_per_day)}">
          <b>${s.avg_soc_per_day == null ? "—" : n(s.avg_soc_per_day, 1)}<small>%/d</small></b></div>
        <div class="bat-info tm"><div class="bat-kv">
          <div><small>${t("vamp.avgDay")}</small><b>${s.avg_soc_per_day == null ? "—" : `${n(s.avg_soc_per_day, 1)}%`}</b></div>
          <div><small>${t("vamp.parked")}</small><b>${fmtHours(s.parked_hours)}</b></div>
          <div><small>${t("vamp.days", { n: v.days })}</small><b>${t("vamp.periods", { n: s.period_count })}</b></div>
          <div><small>${t("vamp.range")}</small><b>${s.range_lost_km == null ? "—" : `−${n(s.range_lost_km, 1)} km`}</b></div>
        </div>
        ${lost ? `<div class="vamp-lost-sum">${esc(lost)}</div>` : ""}
        <div class="muted small-note">${t("vamp.hint")}</div></div>
      </div>
      <div class="section-title" style="margin-top:16px"><span>${t("vamp.periods", { n: s.period_count })}</span></div>
      ${rows}
    </div>`;
  (view.querySelector(".back") as HTMLElement).onclick = back;
}


// ---------------- Charging costs (api_level ≥ 18) ----------------
export type ChargingCosts = {
  months: number;
  timezone: string;
  from_month: string;
  to_month: string;
  summary: {
    distance_km: number;
    energy_added_kwh: number;
    charge_count: number;
    priced_count: number;
    priced_kwh: number;
    costs: Money[];
    cost_per_kwh: Money[];
    cost_per_100km: Money[];
    coverage_pct: number | null;
  };
  split: { kind: string; count: number; energy_kwh: number; costs: Money[]; cost_per_kwh: Money[] }[];
  monthly: {
    month: string; distance_km: number; energy_added_kwh: number; charge_count: number; priced_count: number;
    costs: Money[]; cost_per_kwh: Money[]; cost_per_100km: Money[];
  }[];
};

function mainMoney(list: Money[]): Money | null {
  if (!list.length) return null;
  const pref = defaultCurrency();
  return list.find(m => m.currency === pref) ?? [...list].sort((a, b) => b.amount - a.amount)[0];
}
function moneyLine(list: Money[]) {
  if (!list.length) return "—";
  return list.map(m => fmtMoney(m.amount, m.currency)).join(" + ");
}
function kindLabel(k: string) {
  // Short labels so the split table stays on one line at 390 px (en "Supercharger" / ja full name are too wide).
  return k === "home" ? t("cc.kindHome") : k === "supercharger" ? t("cc.kindSc") : t("cc.kindOther");
}

function fmtPerKwh(m: Money | null) {
  return m ? `${fmtMoney(m.amount, m.currency, true)}<i>/kWh</i>` : "—";
}

/** One-line note when some sessions in the window have no cost. Empty when fully priced. */
function missingCostNote(s: ChargingCosts["summary"]) {
  const miss = s.charge_count - s.priced_count;
  if (miss <= 0) return "";
  return `<div class="muted small-note">${t("cc.missingCost", { n: miss })}</div>`;
}

export function chargingCostCardHTML(c: ChargingCosts) {
  const s = c.summary;
  const spent = mainMoney(s.costs);
  const per100 = mainMoney(s.cost_per_100km);
  const perKwh = mainMoney(s.cost_per_kwh);
  return `<div class="section-title">${t("cc.title")} <a class="link" data-cc>${t("cc.open")}</a></div>
    <div class="card cc-card" data-cc>
      <div class="ov cc-ov">
        <div><small>${t("cc.spent")}</small><b>${spent ? fmtMoney(spent.amount, spent.currency) : "—"}</b></div>
        <div><small>${t("cc.perKwh")}</small><b>${fmtPerKwh(perKwh)}</b></div>
        <div><small>${t("cc.per100")}</small><b>${per100 ? fmtMoney(per100.amount, per100.currency) : "—"}</b></div>
        <div><small>${t("cc.charged")}</small><b>${n(s.energy_added_kwh, 0)}<i>kWh</i></b></div>
      </div>
      <div class="muted small-note">${t("cc.months", { n: c.months })} · ${t("cc.hint")}</div>
      ${missingCostNote(s)}
    </div>`;
}

function ccBar(ms: ChargingCosts["monthly"], val: (m: ChargingCosts["monthly"][0]) => number | null, unit: string, color: string, d = 0) {
  const W = 392, H = 150, L = 6, R = 6, T = 18, B = 20, iw = W - L - R, ih = H - T - B;
  const vs = ms.map(val), max = Math.max(...vs.map(v => v ?? 0), 1e-9);
  const bw = iw / Math.max(ms.length, 1);
  const cur = ms.length ? ms[ms.length - 1].month : "";
  const bars = ms.map((m, i) => {
    const v = vs[i] ?? 0, h = ih * v / max, x = L + i * bw + bw * 0.18, on = m.month === cur;
    return `<rect x="${x.toFixed(1)}" y="${(T + ih - h).toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${Math.max(h, v ? 1 : 0).toFixed(1)}" rx="3" style="fill:${color}" opacity="${on ? 1 : 0.45}"/>
      <text x="${(L + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="ct${on ? " on" : ""}">${Number(m.month.slice(5))}</text>
      ${on && vs[i] != null ? `<text x="${(L + i * bw + bw / 2).toFixed(1)}" y="${(T + ih - h - 4).toFixed(1)}" text-anchor="middle" class="ct on">${n(vs[i], d)}</text>` : ""}`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">${bars}</svg><div class="muted small-note" style="text-align:right">${unit}</div>`;
}

export async function showChargingCosts(view: HTMLElement, carId: number, back: () => void) {
  view.innerHTML = `<button class="back" data-title="${t("cc.pageTitle")}">${t("common.back")}</button><div class="muted">${t("common.loading")}</div>`;
  (view.querySelector(".back") as HTMLElement).onclick = back;
  await serverReady();
  if (lacks("chargingCost")) {
    view.insertAdjacentHTML("beforeend", `<div class="error card-error">${ic("alert")} ${esc(featureText("chargingCost"))}</div><div class="muted">${t("cc.needServer")}</div>`);
    return;
  }
  let c: ChargingCosts;
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    c = await api<ChargingCosts>(`/api/cars/${carId}/charging-costs?months=12&tz=${encodeURIComponent(tz)}&currency=${defaultCurrency()}`);
  } catch (e) {
    view.insertAdjacentHTML("beforeend", `<div class="error">${ic("alert")} ${esc(t("cc.err", { e: (e as Error).message }))}</div>`);
    return;
  }
  const s = c.summary;
  const spent = mainMoney(s.costs);
  const per100 = mainMoney(s.cost_per_100km);
  const perKwh = mainMoney(s.cost_per_kwh);
  const hasCost = s.costs.length > 0;
  const splitRows = c.split.map(b => {
    const u = mainMoney(b.cost_per_kwh);
    // Headers carry units (kWh, /kWh); cells stay bare so the row fits at 390 px.
    return `<tr><td class="kind">${esc(kindLabel(b.kind))}</td><td class="num">${b.count}</td><td class="num">${n(b.energy_kwh, 1)}</td>
      <td class="num">${moneyLine(b.costs)}</td><td class="num">${u ? fmtMoney(u.amount, u.currency, true) : "—"}</td></tr>`;
  }).join("");
  const monthly = c.monthly;
  const costOf = (m: ChargingCosts["monthly"][0]) => mainMoney(m.costs)?.amount ?? 0;
  const per100Of = (m: ChargingCosts["monthly"][0]) => mainMoney(m.cost_per_100km)?.amount ?? null;
  const charts = hasCost ? `
    <div class="pane"><div class="pane-t">${t("cc.spent")}${spent ? ` · ${esc(spent.currency)}` : ""}</div>${ccBar(monthly, m => costOf(m) || null, spent?.currency ?? "", "var(--red)")}</div>
    <div class="pane"><div class="pane-t">${t("cc.per100")}</div>${ccBar(monthly, per100Of, spent?.currency ?? "", "var(--accent)", 0)}</div>`
    : `<div class="pane"><div class="chart-empty">${t("cc.noCost")}</div></div>`;
  const body = s.charge_count === 0
    ? `<div class="empty"><span>${t("cc.empty")}</span></div>`
    : `<div class="ov cc-ov" style="margin-top:12px">
        <div><small>${t("cc.spent")}</small><b>${spent ? fmtMoney(spent.amount, spent.currency) : "—"}</b></div>
        <div><small>${t("cc.perKwh")}</small><b>${fmtPerKwh(perKwh)}</b></div>
        <div><small>${t("cc.per100")}</small><b>${per100 ? fmtMoney(per100.amount, per100.currency) : "—"}</b></div>
        <div><small>${t("cc.driven")}</small><b>${n(s.distance_km, 0)}<i>km</i></b></div>
        <div><small>${t("cc.charged")}</small><b>${n(s.energy_added_kwh, 0)}<i>kWh</i></b></div>
        <div><small>${t("cc.charges")}</small><b>${s.charge_count}</b></div>
      </div>
      <div class="muted small-note">${t("cc.months", { n: c.months })} · ${t("cc.hintDetail")}</div>
      ${missingCostNote(s)}
      <div class="section-title" style="margin-top:16px"><span>${t("cc.split")}</span></div>
      <div class="card" style="padding:0;overflow:auto"><table class="cc-table">
        <thead><tr><th></th><th>#</th><th>kWh</th><th>${t("cc.spent")}</th><th>${t("cc.unit")}</th></tr></thead>
        <tbody>${splitRows}</tbody>
      </table></div>
      <div class="section-title" style="margin-top:16px"><span>${t("cc.monthly")}</span></div>
      ${charts}`;
  view.innerHTML = `<button class="back" data-title="${t("cc.pageTitle")}">${t("common.back")}</button>
    <div class="pane">${body}</div>`;
  (view.querySelector(".back") as HTMLElement).onclick = back;
}
