// api_level 12: battery degradation page + home card, report footprint map + 12-month trends.
// api_level 14: battery health with TeslaMate's "Battery Health" dashboard method (`tm` in /battery); older servers / too
// little data fall back to the range-based estimate below.
import { skey } from "./demo";
import { ic } from "./icons";
import { api, fmtMoney, defaultCurrency, type Car } from "./api";
import { DriveMap } from "./map";
import { t, monthLabel, fmtNum } from "./i18n";

const esc = (s: unknown) => String(s ?? "—").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const n = (v: number | null | undefined, d = 0) => fmtNum(v, d);

// ---------------- battery ----------------
interface BPoint { date: string; odometer_km: number | null; range100_km: number; end_level: number; capacity_kwh: number | null }
interface BMonth { month: string; range100_km: number; capacity_kwh: number | null; odometer_km: number | null; n: number }
export interface Battery { points: BPoint[]; months: BMonth[]; n_points: number; first_date: string | null;
  initial_range100_km: number | null; current_range100_km: number | null; retained_pct: number | null;
  capacity_from_range_kwh: number | null; capacity_from_energy_kwh: number | null; tm?: TmHealth }
/** api_level 14 — see tm_health() in api/src/insights.rs for the exact formulas. */
export interface TmHealth { method: string; efficiency_kwh_100km: number | null; efficiency_source: "derived" | "car" | null;
  capacity_now_kwh: number | null; now_samples: number; capacity_max_kwh: number | null; capacity_new_kwh: number | null; new_source: string;
  health_pct: number | null; degradation_pct: number | null; cycles: number | null; energy_added_kwh: number | null; charges: number;
  points: { date: string; odometer_km: number | null; capacity_kwh: number }[];
  half_months: { period: string; odometer_km: number | null; capacity_kwh: number; n: number }[] }

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
