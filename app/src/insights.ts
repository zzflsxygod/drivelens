// api_level 12: battery degradation page + home card, report footprint map + 12-month trends.
import { api, fmtMoney, defaultCurrency, type Car } from "./api";
import { DriveMap } from "./map";

const esc = (s: unknown) => String(s ?? "—").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const n = (v: number | null | undefined, d = 0) => v == null ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

// ---------------- battery ----------------
interface BPoint { date: string; odometer_km: number | null; range100_km: number; end_level: number; capacity_kwh: number | null }
interface BMonth { month: string; range100_km: number; capacity_kwh: number | null; odometer_km: number | null; n: number }
export interface Battery { points: BPoint[]; months: BMonth[]; n_points: number; first_date: string | null;
  initial_range100_km: number | null; current_range100_km: number | null; retained_pct: number | null;
  capacity_from_range_kwh: number | null; capacity_from_energy_kwh: number | null }

// ----- baseline (100 %) -----
/** Factory rated full-charge range (km) as reported by Tesla's API when new — EPA figures (TeslaMate "rated").
 *  Other markets' cars may report a different constant (e.g. some Japanese/Chinese cars show more), hence:
 *  baseline = user override ?? max(factory value, highest estimate seen in TeslaMate). */
const FACTORY: { re: RegExp; km: number; label: string }[] = [
  { re: /model\s*3.*(performance|\bp\b)/i, km: 507, label: "Model 3 Performance（EPA 315 mi）" },
  { re: /model\s*3.*(long range|\blr\b|awd)/i, km: 576, label: "Model 3 Long Range（EPA 358 mi）" },
  { re: /model\s*3/i, km: 438, label: "Model 3 RWD（EPA 272 mi）" },
  { re: /model\s*y.*(performance|\bp\b)/i, km: 488, label: "Model Y Performance（EPA 303 mi）" },
  { re: /model\s*y.*(long range|\blr\b|awd)/i, km: 531, label: "Model Y Long Range（EPA 330 mi）" },
  { re: /model\s*y/i, km: 418, label: "Model Y RWD（EPA 260 mi）" },
];
const OV_KEY = "drivelens-battery-baseline";
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
  if (ov) { km = ov; source = `手动设置 ${ov} km`; }
  else if (seen > f.km) { km = seen; source = `出厂值 ${f.km} km 低于记录到的最高值，按最高值 ${Math.round(seen)} km`; }
  else { km = f.km; source = `出厂值 ${f.label} ${f.km} km`; }
  const raw = b.current_range100_km != null ? b.current_range100_km / km * 100 : null;
  return { km, source, raw_pct: raw == null ? null : Math.round(raw * 10) / 10, pct: raw == null ? null : Math.min(100, Math.round(raw * 10) / 10), factory: f };
}

export function batteryCardHTML(b: Battery, car: Car | null, carId: number) {
  const bl = baseline(b, car, carId);
  if (!b.n_points || !bl || bl.pct == null) return `<div class="section-title">🔋 电池健康</div><div class="card" data-battery><div class="muted">充电记录还不够（需要充到 50% 以上的记录）</div></div>`;
  return `<div class="section-title">🔋 电池健康 <a class="link" data-battery>查看衰减曲线 ›</a></div>
    <div class="card bat-card" data-battery>
      <div class="bat-ring" style="--p:${bl.pct}"><b>${n(bl.pct, 1)}<small>%</small></b></div>
      <div class="bat-info"><div><small>满电续航（估算）</small><b>${n(b.current_range100_km)} km</b><span class="muted"> / 基准 ${n(bl.km)} km</span></div>
        <div><small>可用容量（估算）</small><b>${n(b.capacity_from_range_kwh, 1)} kWh</b></div>
        <div class="muted small-note">${b.first_date ? `数据自 ${b.first_date.slice(0, 7)} 起记录 · ` : ""}${b.n_points} 次充电<br>基准：${esc(bl.source)}</div></div>
    </div>`;
}

/** least-squares line y = a + b·x */
function fit(xs: number[], ys: number[]) {
  const m = xs.length; if (m < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / m, my = ys.reduce((a, b) => a + b, 0) / m;
  let sxy = 0, sxx = 0; for (let i = 0; i < m; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  if (!sxx) return null; const b = sxy / sxx; return { a: my - b * mx, b };
}

function scatter(pts: { x: number; y: number }[], med: { x: number; y: number }[], o: { xLabel: (x: number) => string; yUnit: string; ref?: number }) {
  if (pts.length < 2) return `<div class="chart-empty">数据不足</div>`;
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
  const f = fit(xs, ys);
  const tl = f ? `<line x1="${X(x0)}" y1="${Y(f.a + f.b * x0)}" x2="${X(x1)}" y2="${Y(f.a + f.b * x1)}" class="btrend"/>` : "";
  const rl = o.ref != null ? `<line x1="${L}" x2="${W - R}" y1="${Y(o.ref)}" y2="${Y(o.ref)}" class="bref"/><text x="${W - R}" y="${Y(o.ref) - 4}" text-anchor="end" class="ct">基准 ${Math.round(o.ref)}</text>` : "";
  return `<div class="chart-box"><svg viewBox="0 0 ${W} ${H}" width="100%">${g}${rl}${dots}${mline}${tl}</svg>
    <div class="legend"><span><i class="lg-dot"></i>单次充电</span><span><i class="lg-med"></i>月中位数</span><span><i class="lg-trend"></i>趋势线</span>${o.yUnit ? `<span>${o.yUnit}</span>` : ""}</div></div>`;
}

export async function showBattery(view: HTMLElement, carId: number, back: () => void, car: Car | null = null) {
  view.innerHTML = `<button class="back">← 返回</button><h2>🔋 电池衰减</h2><div class="muted">加载中…</div>`;
  (view.querySelector(".back") as HTMLElement).onclick = back;
  let b: Battery;
  try { b = await api<Battery>(`/api/cars/${carId}/battery`); }
  catch (e) { view.insertAdjacentHTML("beforeend", `<div class="error">⚠️ ${esc((e as Error).message)}</div>`); return; }
  const bl = baseline(b, car, carId)!;
  const t = (d: string) => new Date(d).getTime(), day = 864e5;
  const pts = b.points.map(p => ({ x: t(p.date), y: p.range100_km }));
  const med = b.months.map(m => ({ x: t(m.month + "-15T00:00:00Z"), y: m.range100_km }));
  const f = fit(pts.map(p => p.x / day / 365), pts.map(p => p.y));
  const perYear = f ? f.b / bl.km * 100 : null;
  const odo = b.points.filter(p => p.odometer_km != null).map(p => ({ x: p.odometer_km!, y: p.range100_km }));
  const odoMed = b.months.filter(m => m.odometer_km != null).map(m => ({ x: m.odometer_km!, y: m.range100_km }));
  const capPts = b.points.filter(p => p.capacity_kwh != null && p.capacity_kwh > 20 && p.capacity_kwh < 150).map(p => ({ x: t(p.date), y: p.capacity_kwh! }));
  const capMed = b.months.filter(m => m.capacity_kwh != null).map(m => ({ x: t(m.month + "-15T00:00:00Z"), y: m.capacity_kwh! }));
  const ym = (x: number) => { const d = new Date(x); return `${d.getFullYear()}/${d.getMonth() + 1}`; };
  const odoSpan = odo.length ? Math.max(...odo.map(p => p.x)) - Math.min(...odo.map(p => p.x)) : 0;
  view.innerHTML = `<button class="back">← 返回</button><h2>🔋 电池衰减</h2>
    <div class="ov">
      <div><small>保持率</small><b>${n(bl.pct, 1)}<i>%</i></b><div class="d neu">当前 / 基准 ${n(bl.km)} km${bl.raw_pct != null && bl.raw_pct > 100 ? `（实算 ${n(bl.raw_pct, 1)}%）` : ""}</div></div>
      <div><small>满电续航（估算）</small><b>${n(b.current_range100_km)}<i>km</i></b><div class="d neu">记录初期 ${n(b.initial_range100_km)} km</div></div>
      <div><small>可用容量（续航 × 能耗系数）</small><b>${n(b.capacity_from_range_kwh, 1)}<i>kWh</i></b></div>
      <div><small>每年变化（趋势）</small><b class="${perYear != null && perYear < 0 ? "dn" : ""}">${perYear == null ? "—" : `${perYear > 0 ? "+" : ""}${n(perYear, 1)}`}<i>%/年</i></b></div>
    </div>
    <div class="pane bl-box"><div class="pane-t">100% 基准</div>
      <div class="muted">${esc(bl.source)}${b.first_date ? ` · TeslaMate 数据自 ${b.first_date.slice(0, 7)} 起` : ""}</div>
      <div class="bl-row"><input id="bl-km" type="number" min="100" max="1000" step="1" placeholder="新车时 100% 显示的续航（km）" value="${baselineOverride(carId) ?? ""}">
        <button id="bl-save" class="primary small">保存</button>${baselineOverride(carId) ? `<button id="bl-reset" class="ghost small">恢复默认</button>` : ""}</div>
      <div class="muted small-note">默认用出厂额定值（${esc(bl.factory.label)} ${bl.factory.km} km，EPA 口径）；若记录到的值更高则用记录值。知道新车时充满显示的续航，可以在这里填写（只保存在本机）。</div></div>
    <div class="section-title">满电续航 · 随时间</div>${scatter(pts, med, { xLabel: ym, yUnit: "km", ref: bl.km })}
    <div class="section-title">满电续航 · 随里程</div>${odoSpan > 100 ? scatter(odo, odoMed, { xLabel: x => `${n(x / 1000, 0)}k km`, yUnit: "km" }) : `<div class="chart-empty">里程数据不足</div>`}
    <div class="section-title">容量估算（充入电量 ÷ 充电百分比）</div>${capPts.length > 2 ? scatter(capPts, capMed, { xLabel: ym, yUnit: "kWh" }) : `<div class="chart-empty">需要单次充电 ≥ 30% 的记录</div>`}
    <div class="muted small-note">满电续航 = 充电结束时的额定续航 ÷ 电量百分比 × 100，只用结束电量 ≥ 50% 的充电；初始 / 当前 = 最早 / 最近 10 次的中位数。
      容量估算包含充电损耗，通常偏高几个 kWh${b.capacity_from_energy_kwh ? `（最近：${n(b.capacity_from_energy_kwh, 1)} kWh）` : ""}。温度、BMS 校准都会让数值波动，看趋势比看单点更有意义。</div>`;
  (view.querySelector(".back") as HTMLElement).onclick = back;
  const again = () => showBattery(view, carId, back, car);
  (view.querySelector("#bl-save") as HTMLElement).onclick = () => {
    const v = Number((view.querySelector("#bl-km") as HTMLInputElement).value);
    if (!(v >= 100 && v <= 1000)) return alert("请输入 100–1000 之间的公里数");
    setBaselineOverride(carId, Math.round(v)); again();
  };
  const rs = view.querySelector<HTMLElement>("#bl-reset"); if (rs) rs.onclick = () => { setBaselineOverride(carId, null); again(); };
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
    return `<rect x="${x.toFixed(1)}" y="${(T + ih - h).toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${Math.max(h, v ? 1 : 0).toFixed(1)}" rx="4" fill="${color}" opacity="${on ? 1 : 0.45}"/>
      <text x="${(L + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="ct${on ? " on" : ""}">${Number(m.month.slice(5))}</text>
      ${on && vs[i] != null ? `<text x="${(L + i * bw + bw / 2).toFixed(1)}" y="${(T + ih - h - 4).toFixed(1)}" text-anchor="middle" class="ct on">${n(vs[i], d)}</text>` : ""}`; }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">${bars}</svg><div class="muted small-note" style="text-align:right">${unit}</div>`;
}
function lineChart(ms: TM[], val: (m: TM) => number | null, cur: string, unit: string) {
  const W = 392, H = 150, L = 34, R = 10, T = 16, B = 20, iw = W - L - R, ih = H - T - B;
  const pts = ms.map((m, i) => ({ i, v: val(m), m }));
  const vs = pts.filter(p => p.v != null).map(p => p.v!);
  if (vs.length < 2) return `<div class="chart-empty">数据不足</div>`;
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
  const C = { home: "#22c58b", supercharger: "#ff5c8a", other: "#f7b733" };
  const bars = ms.map((m, i) => {
    const tot = m.home_kwh + m.supercharger_kwh + m.other_kwh, x = L + i * bw + bw * 0.18, w = bw * 0.64;
    let y = T + ih, out = "";
    if (tot > 0) for (const [k, v] of [["home", m.home_kwh], ["supercharger", m.supercharger_kwh], ["other", m.other_kwh]] as [keyof typeof C, number][]) {
      const h = ih * v / tot; y -= h; if (h > 0) out += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${C[k]}"/>`; }
    else out = `<rect x="${x.toFixed(1)}" y="${T + ih - 2}" width="${w.toFixed(1)}" height="2" fill="#8884"/>`;
    return out + `<text x="${(L + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="ct${m.month === cur ? " on" : ""}">${Number(m.month.slice(5))}</text>`; }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">${bars}</svg>
    <div class="lg"><span><i style="background:${C.home}"></i>家充</span><span><i style="background:${C.supercharger}"></i>超充</span><span><i style="background:${C.other}"></i>其他</span><span>按充入电量占比</span></div>`;
}

export function trendsHTML(ms: TM[], cur: string) {
  const curs = [...new Set(ms.flatMap(m => m.costs.map(c => c.currency)))];
  const main = curs.includes(defaultCurrency()) ? defaultCurrency() : curs[0];
  const costOf = (m: TM, c: string) => m.costs.find(x => x.currency === c)?.amount ?? 0;
  const sum = (f: (m: TM) => number) => ms.reduce((a, m) => a + f(m), 0);
  const km = sum(m => m.distance_km), kwh = sum(m => m.energy_used_kwh);
  return `<div class="section-title">近 12 个月趋势</div>
    <div class="pane"><div class="kpi"><div><small>12 个月里程</small><b>${n(km)} km</b></div><div><small>耗电</small><b>${n(kwh)} kWh</b></div>
      <div><small>平均能耗</small><b>${km > 0 ? n(kwh * 1000 / km) : "—"} Wh/km</b></div></div></div>
    <div class="pane"><div class="pane-t">里程</div>${barChart(ms, m => m.distance_km, cur, "km", "#7b5cff")}</div>
    <div class="pane"><div class="pane-t">耗电</div>${barChart(ms, m => m.energy_used_kwh, cur, "kWh", "#5c9dff")}</div>
    <div class="pane"><div class="pane-t">平均能耗</div>${lineChart(ms, m => m.efficiency_wh_km, cur, "Wh/km")}</div>
    ${curs.length ? curs.map(c => `<div class="pane"><div class="pane-t">充电费用 · ${esc(c)} <span class="muted">合计 ${fmtMoney(sum(m => costOf(m, c)), c)}</span></div>${barChart(ms, m => costOf(m, c), cur, c, c === main ? "#ff5c8a" : "#f7b733")}</div>`).join("")
      : `<div class="pane"><div class="pane-t">充电费用</div><div class="chart-empty">没有费用记录</div></div>`}
    <div class="pane"><div class="pane-t">充电类型占比</div>${mixChart(ms, cur)}</div>`;
}

/** Appends 足迹 + 趋势 to the report body. Returns the created map (for cleanup by the caller). */
export async function loadReportExtras(body: HTMLElement, carId: number, month: string, setMap: (m: DriveMap | null) => void) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  body.insertAdjacentHTML("beforeend", `<div id="rp-foot"><div class="section-title">本月足迹</div><div id="fmap" class="foot-map"><div class="map-ph sk" style="height:100%"></div></div><div class="muted small-note" id="fnote"></div></div>
    <div id="rp-trends"><div class="section-title">近 12 个月趋势</div><div class="pane"><span class="sk" style="width:100%;height:140px;display:block"></span></div></div>`);
  const alive = () => document.body.contains(body) && body.querySelector("#rp-foot") != null;
  api<{ lines: [number, number][][]; points: number; raw_points: number }>(`/api/cars/${carId}/footprint?month=${month}&tz=${encodeURIComponent(tz)}`).then(f => {
    if (!alive()) return;
    const el = body.querySelector<HTMLElement>("#fmap")!;
    if (!f.lines.length) { el.outerHTML = `<div class="chart-empty">本月没有轨迹</div>`; return; }
    el.innerHTML = "";
    const m = new DriveMap(el, { lines: f.lines.map(l => ({ coords: l, speeds: l.map(() => null) })), speedColor: false, noPins: true });
    setMap(m);
    body.querySelector("#fnote")!.textContent = `${f.lines.length} 段行程${f.raw_points > f.points ? ` · 已简化显示（${n(f.points)}/${n(f.raw_points)} 点）` : ""}`;
  }).catch(e => { const el = body.querySelector("#fmap"); if (el) el.outerHTML = `<div class="error">足迹加载失败：${esc((e as Error).message)}</div>`; });
  api<{ months: TM[] }>(`/api/cars/${carId}/trends?month=${month}&tz=${encodeURIComponent(tz)}&currency=${defaultCurrency()}`).then(t => {
    if (!alive()) return; body.querySelector("#rp-trends")!.innerHTML = trendsHTML(t.months, month);
  }).catch(e => { const el = body.querySelector("#rp-trends"); if (el) el.innerHTML = `<div class="error">趋势加载失败：${esc((e as Error).message)}</div>`; });
}
