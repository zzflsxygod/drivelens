// SPDX-License-Identifier: AGPL-3.0-or-later
// Demo Mode "server": answers every DriveLens API endpoint from the generated dataset (gen.ts), mirroring the
// Rust API's response shapes and rules (api/src/*.rs). Writes live in memory and are persisted per demo session.
import { generate, hav, climate, DEMO_CAR_ID, type DB, type DDrive, type DCharge, type Pos } from "./gen";

// Demo always reports the newest server the app knows (set by ../demo.ts from FEATURE_LEVEL / LATEST_SERVER)
let DEMO_API_LEVEL = 12;
let DEMO_SERVER_VERSION = "0.10.1";
export function configure(level: number, version: string) { DEMO_API_LEVEL = level; DEMO_SERVER_VERSION = version; }
export const attribution = () => db?.attribution ?? "";

// ---------------- mutable demo state (persisted) ----------------
interface State { day: string; aliases: Record<number, { name: string; at: number }>; costs: Record<number, { amount: number; currency: string; note: string | null } | null>;
  journeys: { id: number; name: string; note: string | null; drive_ids: number[]; cover: string | null; cover_at: number | null }[]; nextJ: number; dismissed: number[] }
const SKEY = "drivelens-demo-state";
let db: DB; let st: State;
const tokyoDay = (ms: number) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
function fresh(): State {
  return { day: tokyoDay(db.now), aliases: {}, costs: {}, journeys: db.journeys.map(j => ({ ...j, cover: null, cover_at: null })), nextJ: 100, dismissed: [] };
}
function save() { try { localStorage.setItem(SKEY, JSON.stringify(st)); } catch { try { localStorage.setItem(SKEY, JSON.stringify({ ...st, journeys: st.journeys.map(j => ({ ...j, cover: null })) })); } catch { /* quota */ } } }
export function initDemo(nowMs = Date.now(), persist = true) {
  db = generate(nowMs);
  let s: State | null = null;
  if (persist) { try { s = JSON.parse(localStorage.getItem(SKEY) || "null"); } catch { s = null; } }
  // a new (Tokyo) day regenerates the timeline; earlier edits would point at shifted drives → start fresh
  st = s && s.day === tokyoDay(db.now) ? s : fresh();
  persistOn = persist; if (persist) save();
}
let persistOn = true;
const commit = () => { if (persistOn) save(); };
export function resetDemoState() { try { localStorage.removeItem(SKEY); } catch { /* ignore */ } }

// ---------------- helpers ----------------
const TS = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(ms: number, tz: string) {
  let f = fmtCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); fmtCache.set(tz, f); }
  const o: Record<string, number> = {}; for (const p of f.formatToParts(new Date(ms))) if (p.type !== "literal") o[p.type] = Number(p.value);
  return { y: o.year, m: o.month, d: o.day, h: o.hour % 24, mi: o.minute, s: o.second };
}
const validTz = (tz: string) => { try { parts(0, tz); return true; } catch { return false; } };
/** local wall time in tz → UTC ms */
function zoned(y: number, m: number, d: number, tz: string) {
  let g = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 3; i++) { const p = parts(g, tz); const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s); g += Date.UTC(y, m - 1, d) - asUtc; }
  return g;
}
const ym = (ms: number, tz: string) => { const p = parts(ms, tz); return `${p.y}-${String(p.m).padStart(2, "0")}`; };
const ymd = (ms: number, tz: string) => { const p = parts(ms, tz); return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`; };
const shiftM = (m: string, by: number) => { const [y, mo] = m.split("-").map(Number); const d = new Date(Date.UTC(y, mo - 1 + by, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
const monthStart = (m: string, tz: string) => { const [y, mo] = m.split("-").map(Number); return zoned(y, mo, 1, tz); };
const validMonth = (m: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
const curParam = (c: string | null) => { const u = (c ?? "").trim().toUpperCase(); return /^[A-Z]{3}$/.test(u) ? u : "JPY"; };

const addr = (id: number | null) => db.addresses.find(a => a.id === id) ?? null;
const geo = (id: number | null) => db.geofences.find(g => g.id === id) ?? null;
const aliasOf = (id: number | null) => id != null ? st.aliases[id]?.name ?? null : null;
const place = (aid: number | null, gid: number | null) => aliasOf(aid) ?? geo(gid)?.name ?? (() => { const a = addr(aid); return a ? [a.name, a.city].filter(Boolean).join(", ") : null; })();
const energy = (d: DDrive) => (d.srr - d.err) * db.car.efficiency;
const journeyOf = (driveId: number) => st.journeys.find(j => j.drive_ids.includes(driveId)) ?? null;
const driveById = (id: number) => db.drives.find(d => d.id === id) ?? null;
const chargeById = (id: number) => db.charges.find(c => c.id === id) ?? null;

function driveJson(d: DDrive) {
  const j = journeyOf(d.id), s = d.pos[0], e = d.pos[d.pos.length - 1];
  return { id: d.id, car_id: DEMO_CAR_ID, start_date: TS(d.start), end_date: TS(d.end), start_address: place(d.sa, d.sg), end_address: place(d.ea, d.eg),
    start_address_id: d.sa, end_address_id: d.ea, start_alias: aliasOf(d.sa), end_alias: aliasOf(d.ea), distance_km: d.distance, duration_min: d.duration_min,
    speed_max: d.speed_max, start_battery_level: s.battery_level, end_battery_level: e.battery_level, energy_kwh: energy(d),
    efficiency_wh_km: d.distance > 0 ? energy(d) * 1000 / d.distance : null, outside_temp_avg: d.temp,
    start_lat: s.lat, start_lng: s.lng, end_lat: e.lat, end_lng: e.lng, journey_id: j?.id ?? null, journey_name: j?.name ?? null };
}
/** effective cost: manual (demo edits > bundled manual) > TeslaMate */
function costOf(c: DCharge) {
  const m = c.id in st.costs ? st.costs[c.id] : db.manualCosts[c.id] ?? null;
  if (m) return { cost: m.amount, currency: m.currency, cost_source: "manual" as const, cost_note: m.note };
  if (c.cost != null) return { cost: c.cost, currency: "JPY", cost_source: "teslamate" as const, cost_note: null };
  return { cost: null, currency: null, cost_source: null, cost_note: null };
}
function chargeJson(c: DCharge) {
  const k = costOf(c);
  return { id: c.id, car_id: DEMO_CAR_ID, start_date: TS(c.start), end_date: TS(c.end), address: place(c.addr, c.geo), geofence: geo(c.geo)?.name ?? null,
    address_id: c.addr, alias: aliasOf(c.addr), latitude: c.lat, longitude: c.lng, charge_energy_added: c.added, charge_energy_used: c.used,
    cost: k.cost, currency: k.currency, cost_source: k.cost_source, cost_note: k.cost_note, teslamate_cost: c.cost, default_currency: "JPY",
    start_battery_level: c.sl, end_battery_level: c.el, duration_min: c.duration_min, outside_temp_avg: c.temp };
}
function chargePoints(c: DCharge) {
  return c.points.map(p => ({ date: TS(p.date), battery_level: p.battery_level, charge_energy_added: p.charge_energy_added, charger_power: p.charger_power,
    charger_voltage: p.charger_voltage, charger_actual_current: p.charger_actual_current, charger_phases: p.charger_phases, fast_charger_present: p.fast,
    power_kw: p.charger_power, power_source: "reported" }));
}
const isFast = (c: DCharge) => c.points.some(p => p.fast);
function kindOf(c: DCharge, home: number | null) {
  const a = addr(c.addr); const txt = [aliasOf(c.addr), geo(c.geo)?.name, a?.name].filter(Boolean).join(" ");
  if (isFast(c) && /(supercharger|超充|スーパーチャージャー|tesla)/i.test(txt)) return "supercharger";
  if (!isFast(c) && (/(home|自宅|家|うち|house)/i.test([aliasOf(c.addr), geo(c.geo)?.name].filter(Boolean).join(" ")) || c.addr === home)) return "home";
  return "other";
}
function homeAddr(before: number) {
  const n = new Map<number, number>();
  for (const c of db.charges) if (c.start >= before - 365 * 864e5 && c.duration_min > 0 && c.added * 60 / c.duration_min < 22) n.set(c.addr, (n.get(c.addr) ?? 0) + 1);
  let best: number | null = null, bn = 0; for (const [k, v] of n) if (v > bn) { best = k; bn = v; } return best;
}
type Money = { currency: string; amount: number };
function addMoney(v: Money[], cur: string, a: number) { const m = v.find(x => x.currency === cur); if (m) m.amount += a; else { v.push({ currency: cur, amount: a }); v.sort((x, y) => x.currency.localeCompare(y.currency)); } }
const roundMoney = (v: Money[]) => v.forEach(m => m.amount = r2(m.amount));
const byStartDesc = <T extends { start: number; id: number }>(a: T, b: T) => b.start - a.start || b.id - a.id;

// ---------------- endpoints ----------------
type Res = { status: number; body?: unknown };
const ok = (body: unknown): Res => ({ status: 200, body });
const err = (status: number, error: string): Res => ({ status, body: { error } });

function health() {
  return { status: "ok", version: DEMO_SERVER_VERSION, api_level: DEMO_API_LEVEL };
}
const cars = () => [{ id: DEMO_CAR_ID, name: db.car.name, model: db.car.model, marketing_name: db.car.marketing_name, vin: db.car.vin, efficiency: db.car.efficiency }];

function lastEvent() {
  const d = db.drives[db.drives.length - 1], c = db.charges[db.charges.length - 1];
  return { d, c };
}
function status() {
  const { d, c } = lastEvent();
  const lastPos: Pos = d.pos[d.pos.length - 1];
  const charged = c && c.start >= d.end;
  const lvl = charged ? c.el : lastPos.battery_level;
  const r100 = lastPos.rated / Math.max(1, lastPos.battery_level) * 100;
  const end = charged ? c.end : d.end;
  const asleep = db.now - end > 25 * 60e3;
  return { car: { ...db.car, id: DEMO_CAR_ID },
    state: { state: asleep ? "asleep" : "online", since: TS(asleep ? end + 25 * 60e3 : end) },
    position: { date: TS(end), latitude: charged ? c.lat : lastPos.lat, longitude: charged ? c.lng : lastPos.lng, battery_level: lvl, usable_battery_level: lvl,
      rated_battery_range_km: r1(lvl / 100 * r100), ideal_battery_range_km: r1(lvl / 100 * r100 * 1.02), est_battery_range_km: r1(lvl / 100 * r100 * 0.89),
      odometer_km: charged ? c.odometer : lastPos.odometer, outside_temp: r1(climate(db.now)), inside_temp: asleep ? r1(climate(db.now) + 3) : 21.5, speed: null },
    software: { version: db.software.version, installed_at: TS(db.software.installed) } };
}
function lastActivity() {
  const d = [...db.drives].sort(byStartDesc)[0], c = [...db.charges].sort(byStartDesc)[0];
  const dj = d ? driveJson(d) : null, cj = c ? chargeJson(c) : null;
  let location = null;
  if (dj && cj && cj.start_date >= dj.end_date) location = { name: cj.address, address_id: cj.address_id, source: "charge" };
  else if (dj) location = { name: dj.end_address, address_id: dj.end_address_id, source: "drive" };
  else if (cj) location = { name: cj.address, address_id: cj.address_id, source: "charge" };
  return { location, last_drive: dj, last_charge: cj };
}
function stats(q: URLSearchParams) {
  const tz = q.get("tz") || "UTC"; if (!validTz(tz)) return err(400, "unknown tz");
  const cur = curParam(q.get("currency"));
  const m = ym(db.now, tz), m0 = monthStart(m, tz);
  const sum = <T>(a: T[], f: (x: T) => number) => a.reduce((s, x) => s + f(x), 0);
  const dm = db.drives.filter(d => d.start >= m0), cm = db.charges.filter(c => c.start >= m0);
  const costs: (Money & { count: number })[] = [], monthCosts: (Money & { count: number })[] = [];
  const groups = new Map<string, { amount: number; count: number; m: boolean }>();
  for (const c of db.charges) { const k = costOf(c); if (k.cost == null) continue; const key = `${k.currency ?? cur}|${c.start >= m0}`;
    const g = groups.get(key) ?? { amount: 0, count: 0, m: c.start >= m0 }; g.amount += k.cost; g.count++; groups.set(key, g); }
  for (const [key, g] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const currency = key.split("|")[0], ca = { currency, amount: r2(g.amount), count: g.count };
    const t = costs.find(x => x.currency === currency); if (t) { t.amount += ca.amount; t.count += ca.count; } else costs.push({ ...ca });
    if (g.m) monthCosts.push(ca);
  }
  const tmCost = (a: DCharge[]) => { const v = a.filter(c => c.cost != null); return v.length ? sum(v, c => c.cost!) : null; };
  return ok({ stats: { total_distance_km: sum(db.drives, d => d.distance), drive_count: db.drives.length, charge_count: db.charges.length,
      total_energy_added_kwh: sum(db.charges, c => c.added), total_cost: tmCost(db.charges), costs },
    this_month: { month: m, distance_km: dm.length ? sum(dm, d => d.distance) : null, drive_count: dm.length, drive_energy_kwh: dm.length ? sum(dm, energy) : null,
      charge_count: cm.length, charge_energy_added_kwh: cm.length ? sum(cm, c => c.added) : null, charge_cost: tmCost(cm), charge_costs: monthCosts },
    timezone: tz });
}
function months(q: URLSearchParams) {
  const tz = q.get("tz") || "UTC"; if (!validTz(tz)) return err(400, "unknown tz");
  const by = new Map<string, { month: string; drive_count: number; distance_km: number; duration_min: number; charge_count: number; energy_added_kwh: number }>();
  const g = (m: string) => { let o = by.get(m); if (!o) { o = { month: m, drive_count: 0, distance_km: 0, duration_min: 0, charge_count: 0, energy_added_kwh: 0 }; by.set(m, o); } return o; };
  for (const d of db.drives) { const o = g(ym(d.start, tz)); o.drive_count++; o.distance_km += d.distance; o.duration_min += d.duration_min; }
  for (const c of db.charges) { const o = g(ym(c.start, tz)); o.charge_count++; o.energy_added_kwh += c.added; }
  return ok([...by.values()].sort((a, b) => b.month.localeCompare(a.month)).map(o => ({ ...o, distance_km: r1(o.distance_km), energy_added_kwh: r1(o.energy_added_kwh) })));
}
function cursor(q: URLSearchParams): [number | null, number] {
  const b = q.get("before"); if (!b) return [null, Number.MAX_SAFE_INTEGER];
  const i = b.lastIndexOf("~"); const d = i >= 0 ? b.slice(0, i) : b; const id = i >= 0 ? Number(b.slice(i + 1)) || Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(d) ? d : d.length <= 10 ? d + "T00:00:00Z" : d + "Z");
  return [isNaN(t) ? null : t, id];
}
function list<T extends { start: number; id: number }>(rows: T[], q: URLSearchParams, json: (x: T) => { start_date: string; id: number }) {
  const limit = Math.min(500, Math.max(1, Number(q.get("limit") ?? 50) || 50)), offset = Math.max(0, Number(q.get("offset") ?? 0) || 0);
  const [bt, bid] = cursor(q);
  const out = rows.filter(r => bt == null || r.start < bt || (Math.floor(r.start / 1000) * 1000 === bt && r.id < bid)).sort(byStartDesc).slice(offset, offset + limit).map(json);
  if (q.get("paged") !== "true") return ok(out);
  const last = out[out.length - 1];
  return ok({ items: out, next_cursor: out.length === limit && last ? `${last.start_date}~${last.id}` : null });
}
function drivePath(id: number) {
  const d = driveById(id); if (!d) return ok([]);
  return ok(d.pos.map(p => ({ date: TS(p.date), lat: p.lat, lng: p.lng, speed: p.speed, elevation: p.elevation, battery_level: p.battery_level })));
}

// ----- report / trends -----
function reportRows(t0: number, t1: number, cur0: number, tz: string) {
  const home = homeAddr(t1);
  const drives = db.drives.filter(d => d.start >= t0 && d.start < t1).map(d => ({ d, day: ymd(d.start, tz), cur: d.start >= cur0 }));
  const charges = db.charges.filter(c => c.start >= t0 && c.start < t1).map(c => ({ c, day: ymd(c.start, tz), cur: c.start >= cur0, kind: kindOf(c, home), k: costOf(c),
    peak: c.points.length ? Math.max(...c.points.map(p => p.charger_power)) : null }));
  return { drives, charges };
}
function report(q: URLSearchParams) {
  const tz = q.get("tz") || "UTC"; if (!validTz(tz)) return err(400, "unknown tz");
  const mp = q.get("month"); if (mp && !validMonth(mp)) return err(400, "month must be YYYY-MM");
  const defCur = curParam(q.get("currency"));
  const nowM = ym(db.now, tz), month = mp || nowM;
  if (month > nowM) return err(400, "month is in the future");
  const p0 = monthStart(shiftM(month, -1), tz), m0 = monthStart(month, tz), m1 = monthStart(shiftM(month, 1), tz);
  const [yy, mm] = month.split("-").map(Number); const dim = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const np = parts(db.now, tz); const elapsedRaw = Math.floor((Date.UTC(np.y, np.m - 1, np.d) - Date.UTC(yy, mm - 1, 1)) / 864e5) + 1;
  const { drives, charges } = reportRows(p0, m1, m0, tz);
  const ov = () => ({ distance_km: 0, drive_duration_min: 0, drive_count: 0, energy_used_kwh: 0, energy_added_kwh: 0, charge_count: 0, costs: [] as Money[], efficiency_wh_km: null as number | null });
  const o = ov(), pr = ov();
  const days = new Map<string, [number, number]>(); for (let i = 1; i <= dim; i++) days.set(`${month}-${String(i).padStart(2, "0")}`, [0, 0]);
  for (const x of drives) { const t = x.cur ? o : pr; t.distance_km += x.d.distance; t.drive_duration_min += x.d.duration_min; t.drive_count++; t.energy_used_kwh += Math.max(0, energy(x.d)); if (x.cur) { const e = days.get(x.day); if (e) e[0] += x.d.distance; } }
  const split = ["home", "supercharger", "other"].map(kind => ({ kind, count: 0, energy_kwh: 0, costs: [] as Money[] }));
  for (const x of charges) { const cur = x.k.currency ?? defCur, t = x.cur ? o : pr;
    t.energy_added_kwh += x.c.added; t.charge_count++; if (x.k.cost != null) addMoney(t.costs, cur, x.k.cost);
    if (x.cur) { const e = days.get(x.day); if (e) e[1] += x.c.added; const b = split.find(s => s.kind === x.kind)!; b.count++; b.energy_kwh += x.c.added; if (x.k.cost != null) addMoney(b.costs, cur, x.k.cost); } }
  for (const t of [o, pr]) { t.efficiency_wh_km = t.distance_km > 0 ? r1(t.energy_used_kwh * 1000 / t.distance_km) : null; t.distance_km = r1(t.distance_km); t.energy_used_kwh = r1(t.energy_used_kwh); t.energy_added_kwh = r1(t.energy_added_kwh); roundMoney(t.costs); }
  for (const b of split) { b.energy_kwh = r1(b.energy_kwh); roundMoney(b.costs); }
  const cd = drives.filter(x => x.cur), cc = charges.filter(x => x.cur);
  const dr = (x: typeof cd[0]) => { const j = driveJson(x.d); return { id: j.id, start_date: j.start_date, start_address: j.start_address, end_address: j.end_address, distance_km: j.distance_km, duration_min: j.duration_min, speed_max: j.speed_max }; };
  const cr = (x: typeof cc[0]) => ({ id: x.c.id, start_date: TS(x.c.start), address: place(x.c.addr, x.c.geo), energy_kwh: x.c.added, cost: x.k.cost, currency: x.k.cost != null ? x.k.currency ?? defCur : null,
    peak_kw: x.peak, start_battery_level: x.c.sl, end_battery_level: x.c.el, duration_min: x.c.duration_min });
  const maxBy = <T>(a: T[], f: (x: T) => number) => a.reduce<T | null>((b, x) => b == null || f(x) >= f(b) ? x : b, null);
  const withCost = cc.filter(x => x.k.cost != null);
  const exp = maxBy(withCost.filter(x => (x.k.currency ?? defCur) === defCur), x => x.k.cost!) ?? maxBy(withCost, x => x.k.cost!);
  const fastest = maxBy(cc.filter(x => (x.peak ?? 0) > 0), x => x.peak!);
  const first = db.drives.length ? ym(Math.min(...db.drives.map(d => d.start)), tz) : null;
  return ok({ month, timezone: tz, is_current: month === nowM, first_month: first, days_in_month: dim, days_elapsed: Math.min(Math.max(elapsedRaw, 0), dim),
    overview: o, previous: pr, split, daily: [...days].map(([date, [km, kwh]]) => ({ date, distance_km: r1(km), energy_added_kwh: r1(kwh) })),
    records: { longest_drive: (x => x ? dr(x) : null)(maxBy(cd, x => x.d.distance)), top_speed_drive: (x => x ? dr(x) : null)(maxBy(cd, x => x.d.speed_max)),
      most_expensive_charge: exp ? cr(exp) : null, fastest_charge: fastest ? cr(fastest) : null } });
}
function trends(q: URLSearchParams) {
  const tz = q.get("tz") || "UTC"; if (!validTz(tz)) return err(400, "unknown tz");
  const mp = q.get("month"); if (mp && !validMonth(mp)) return err(400, "month must be YYYY-MM");
  const defCur = curParam(q.get("currency")); const month = mp || ym(db.now, tz);
  const ms = Array.from({ length: 12 }, (_, i) => shiftM(month, i - 11));
  const t0 = monthStart(ms[0], tz), t1 = monthStart(shiftM(month, 1), tz);
  const { drives, charges } = reportRows(t0, t1, t0, tz);
  const by = new Map(ms.map(m => [m, { month: m, distance_km: 0, energy_used_kwh: 0, energy_added_kwh: 0, efficiency_wh_km: null as number | null, drive_count: 0, charge_count: 0, costs: [] as Money[], home_kwh: 0, supercharger_kwh: 0, other_kwh: 0 }]));
  for (const x of drives) { const m = by.get(x.day.slice(0, 7)); if (!m) continue; m.distance_km += x.d.distance; m.energy_used_kwh += Math.max(0, energy(x.d)); m.drive_count++; }
  for (const x of charges) { const m = by.get(x.day.slice(0, 7)); if (!m) continue; m.energy_added_kwh += x.c.added; m.charge_count++;
    if (x.kind === "home") m.home_kwh += x.c.added; else if (x.kind === "supercharger") m.supercharger_kwh += x.c.added; else m.other_kwh += x.c.added;
    if (x.k.cost != null) addMoney(m.costs, x.k.currency ?? defCur, x.k.cost); }
  const out = [...by.values()].map(m => ({ ...m, efficiency_wh_km: m.distance_km > 1 ? r1(m.energy_used_kwh * 1000 / m.distance_km) : null, distance_km: r1(m.distance_km), energy_used_kwh: r1(m.energy_used_kwh),
    energy_added_kwh: r1(m.energy_added_kwh), home_kwh: r1(m.home_kwh), supercharger_kwh: r1(m.supercharger_kwh), other_kwh: r1(m.other_kwh), costs: (roundMoney(m.costs), m.costs) }));
  return ok({ months: out, timezone: tz });
}
function footprint(q: URLSearchParams) {
  const tz = q.get("tz") || "UTC"; if (!validTz(tz)) return err(400, "unknown tz");
  const mp = q.get("month"); if (mp && !validMonth(mp)) return err(400, "month must be YYYY-MM");
  const month = mp || ym(db.now, tz), t0 = monthStart(month, tz), t1 = monthStart(shiftM(month, 1), tz);
  const rows = db.drives.flatMap(d => d.pos.filter(p => p.date >= t0 && p.date < t1)).sort((a, b) => (a.drive_id! - b.drive_id!) || a.date - b.date);
  const dist = (a: [number, number], b: [number, number]) => { const k = Math.cos(a[1] * Math.PI / 180); return Math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * 111320; };
  const thin = (step: number) => {
    const lines: [number, number][][] = []; let cd = -1, last: [number, number] = [0, 0], pend: [number, number] | null = null;
    for (const r of rows) { const pt: [number, number] = [r.lng, r.lat];
      if (r.drive_id !== cd) { if (lines.length && pend) lines[lines.length - 1].push(pend); pend = null; lines.push([pt]); cd = r.drive_id!; last = pt; continue; }
      if (dist(pt, last) >= step) { lines[lines.length - 1].push(pt); last = pt; pend = null; } else pend = pt; }
    if (lines.length && pend) lines[lines.length - 1].push(pend);
    return lines.filter(l => l.length > 1);
  };
  let step = 25, lines = thin(step);
  const total = () => lines.reduce((s, l) => s + l.length, 0);
  while (total() > 8000 && step < 1600) { step *= 2; lines = thin(step); }
  if (total() > 8000) { const k = Math.ceil(total() / 8000); lines = lines.map(l => l.filter((_, i) => i % k === 0 || i === l.length - 1)); }
  lines = lines.map(l => l.map(p => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5] as [number, number]));
  return ok({ lines, points: total(), raw_points: rows.length });
}
function battery(q: URLSearchParams) {
  const pts = db.charges.filter(c => c.el >= 50 && c.err > 0).sort((a, b) => a.end - b.end).map(c => ({ date: TS(c.end), odometer_km: c.odometer, range100_km: c.err / c.el * 100, end_level: c.el,
    capacity_kwh: c.el - c.sl >= 30 && c.added > 0 ? c.added / (c.el - c.sl) * 100 : null }));
  const med = (v: number[]) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const k = Math.min(10, pts.length);
  const initial = med(pts.slice(0, k).map(p => p.range100_km)), current = med(pts.slice(pts.length - k).map(p => p.range100_km));
  const monthsOut: { month: string; range100_km: number; capacity_kwh: number | null; odometer_km: number | null; n: number }[] = [];
  for (let i = 0; i < pts.length;) { const m = pts[i].date.slice(0, 7); let j = i; while (j < pts.length && pts[j].date.slice(0, 7) === m) j++; const g = pts.slice(i, j);
    const cm = med(g.map(p => p.capacity_kwh).filter((x): x is number => x != null));
    monthsOut.push({ month: m, range100_km: r1(med(g.map(p => p.range100_km)) ?? 0), capacity_kwh: cm == null ? null : r1(cm), odometer_km: Math.max(...g.map(p => p.odometer_km)), n: g.length }); i = j; }
  const capNow = med(pts.slice().reverse().map(p => p.capacity_kwh).filter((x): x is number => x != null).slice(0, 10));
  const eff = db.car.efficiency, summary = q.get("summary") === "true";
  return ok({ points: summary ? [] : pts, months: summary ? [] : monthsOut, n_points: pts.length, first_date: pts[0]?.date ?? null,
    initial_range100_km: initial == null ? null : r1(initial), current_range100_km: current == null ? null : r1(current),
    retained_pct: initial && current ? r1(current / initial * 100) : null, efficiency_kwh_km: eff, capacity_from_range_kwh: current != null ? r1(current * eff) : null,
    capacity_from_energy_kwh: capNow == null ? null : r1(capNow), tm: tmHealth(summary) });
}
/** api_level 14 mock of the TeslaMate "Battery Health" numbers (same formulas as tm_health() in the API, on the demo sessions:
 *  one "last sample" per session = end rated range × efficiency ÷ end level, with a little sensor jitter). */
function tmHealth(summary: boolean) {
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const counts = new Map<number, number>();
  for (const c of db.charges) if (c.duration_min > 10 && c.el <= 95 && c.added > 0 && c.err - c.srr !== 0) { const v = Math.round(c.added / (c.err - c.srr) * 1000) / 1000; counts.set(v, (counts.get(v) ?? 0) + 1); }
  const mode = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
  const eff = mode ? Math.round(mode[0] * 1000) / 10 : db.car.efficiency * 100;
  const jit = (id: number) => (((id * 2654435761) >>> 0) % 1000 / 1000 - 0.5) * 1.2;
  const q = db.charges.filter(c => c.end < db.now && c.added >= eff && c.el > 0).sort((a, b) => a.end - b.end)
    .map(c => ({ c, cap: c.err * eff / c.el + jit(c.id) })).filter(x => x.cap >= 20 && x.cap <= 150);
  if (!q.length) return { method: "teslamate-battery-health", efficiency_kwh_100km: r2(eff), efficiency_source: mode ? "derived" : "car", capacity_now_kwh: null, now_samples: 0,
    capacity_max_kwh: null, capacity_new_kwh: null, new_source: "max", health_pct: null, degradation_pct: null, cycles: null, energy_added_kwh: null, charges: 0, points: [], half_months: [] };
  const last = q.slice(-3), now = last.reduce((a, x) => a + x.cap, 0) / last.length, max = Math.max(...q.map(x => x.cap));
  const tot = db.charges.filter(c => c.added > 0.01), kwh = tot.reduce((a, c) => a + c.added, 0), ratio = now * 100 / max;
  const day = (ms: number) => tokyoDay(ms), byDay = new Map<string, typeof q>(), byHalf = new Map<string, typeof q>();
  for (const x of q) { const d = day(x.c.end); byDay.set(d, [...(byDay.get(d) ?? []), x]); const h = d.slice(0, 4) + d.slice(5, 7) + (Number(d.slice(8, 10)) <= 15 ? "1" : "2"); byHalf.set(h, [...(byHalf.get(h) ?? []), x]); }
  const avg = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const pct50 = (v: number[]) => { const s2 = [...v].sort((a, b) => a - b), i = (s2.length - 1) / 2, lo = Math.floor(i); return s2[lo] + (s2[Math.ceil(i)] - s2[lo]) * (i - lo); };
  return { method: "teslamate-battery-health", efficiency_kwh_100km: r2(eff), efficiency_source: mode ? "derived" : "car", capacity_now_kwh: r2(now), now_samples: 100,
    capacity_max_kwh: r2(max), capacity_new_kwh: r2(max), new_source: "max", health_pct: r1(Math.min(100, ratio)), degradation_pct: r1(Math.max(0, 100 - ratio)),
    cycles: Math.floor(kwh / max), energy_added_kwh: r1(kwh), charges: tot.length,
    points: summary ? [] : [...byDay].map(([d, g]) => ({ date: d, odometer_km: r1(avg(g.map(x => x.c.odometer))), capacity_kwh: r2(avg(g.map(x => x.cap))) })),
    half_months: summary ? [] : [...byHalf].map(([h, g]) => ({ period: h, odometer_km: Math.round(Math.min(...g.map(x => x.c.odometer))), capacity_kwh: r1(pct50(g.map(x => x.cap))), n: g.length })) };
}

// ----- journeys -----
function journeyRow(j: State["journeys"][0]) {
  const ds = j.drive_ids.map(driveById).filter((d): d is DDrive => !!d).sort((a, b) => a.start - b.start);
  const f = ds[0], l = ds[ds.length - 1];
  return { id: j.id, car_id: DEMO_CAR_ID, name: j.name, note: j.note, start_date: f ? TS(f.start) : null, end_date: l ? TS(Math.max(...ds.map(d => d.end))) : null,
    start_address: f ? place(f.sa, f.sg) : null, end_address: l ? place(l.ea, l.eg) : null, drive_count: ds.length,
    distance_km: ds.length ? r1(ds.reduce((s, d) => s + d.distance, 0)) : null, duration_min: ds.length ? ds.reduce((s, d) => s + d.duration_min, 0) : null,
    energy_kwh: ds.length ? r1(ds.reduce((s, d) => s + energy(d), 0)) : null, _s0: f?.start ?? -Infinity };
}
function journeyList(q: URLSearchParams) {
  const limit = Math.min(500, Math.max(1, Number(q.get("limit") ?? 50) || 50)), offset = Math.max(0, Number(q.get("offset") ?? 0) || 0);
  return ok(st.journeys.map(journeyRow).sort((a, b) => b._s0 - a._s0 || b.id - a.id).slice(offset, offset + limit).map(({ _s0, ...r }) => { void _s0; return r; }));
}
function journeyDetail(id: number): Res {
  const j = st.journeys.find(x => x.id === id); if (!j) return err(404, "journey not found");
  const ds = j.drive_ids.map(driveById).filter((d): d is DDrive => !!d).sort((a, b) => a.start - b.start);
  const drives = ds.map(driveJson);
  const t0 = ds[0]?.start, t1 = ds.length ? ds[ds.length - 1].end : undefined;
  const charges = t0 != null && t1 != null ? db.charges.filter(c => c.start >= Math.floor(t0 / 1000) * 1000 && c.start <= t1).sort((a, b) => a.start - b.start).map(chargeJson) : [];
  const candidates = t0 != null && t1 != null ? db.drives.filter(d => d.start >= t0 - 864e5 && d.start <= t1 + 864e5 && !j.drive_ids.includes(d.id)).sort((a, b) => a.start - b.start).map(driveJson) : [];
  const sm = { start_date: drives[0]?.start_date ?? null, end_date: drives[drives.length - 1]?.end_date ?? null, start_address: drives[0]?.start_address ?? null, end_address: drives[drives.length - 1]?.end_address ?? null,
    distance_km: 0, driving_min: 0, stop_min: 0, elapsed_min: ds.length ? Math.floor((Math.floor(ds[ds.length - 1].end / 1000) - Math.floor(ds[0].start / 1000)) / 60) : 0, energy_used_kwh: 0, charged_kwh: 0, charge_count: 0,
    costs: [] as Money[], efficiency_wh_km: null as number | null, speed_max: null as number | null };
  for (const d of drives) { sm.distance_km += d.distance_km; sm.driving_min += d.duration_min; sm.energy_used_kwh += Math.max(0, d.energy_kwh); sm.speed_max = Math.max(sm.speed_max ?? 0, d.speed_max); }
  sm.stop_min = Math.max(0, sm.elapsed_min - sm.driving_min);
  for (const c of charges) { sm.charged_kwh += c.charge_energy_added; sm.charge_count++; if (c.cost != null) { const cur = c.currency ?? c.default_currency ?? "JPY"; const m = sm.costs.find(x => x.currency === cur); if (m) m.amount += c.cost; else sm.costs.push({ currency: cur, amount: c.cost }); } }
  roundMoney(sm.costs);
  sm.efficiency_wh_km = sm.distance_km > 0 ? r1(sm.energy_used_kwh * 1000 / sm.distance_km) : null;
  sm.distance_km = r1(sm.distance_km); sm.energy_used_kwh = r1(sm.energy_used_kwh); sm.charged_kwh = r1(sm.charged_kwh);
  const ep = (s: string) => Math.floor(Date.parse(s) / 1000);
  const stops = drives.slice(1).map((b, i) => { const a = drives[i]; const ta = ep(a.end_date), tb = ep(b.start_date);
    const ch = charges.filter(c => { const t = ep(c.start_date); return t >= ta - 120 && t <= tb; });
    return { after_drive_id: a.id, before_drive_id: b.id, start_date: a.end_date, end_date: b.start_date, duration_min: Math.max(0, Math.floor((tb - ta) / 60)), address: a.end_address,
      lat: a.end_lat, lng: a.end_lng, charge_ids: ch.map(c => c.id), charged_kwh: r1(ch.reduce((s, c) => s + c.charge_energy_added, 0)) }; });
  return ok({ id: j.id, car_id: DEMO_CAR_ID, name: j.name, note: j.note, has_cover: !!j.cover, summary: sm, drives, charges, stops, candidates });
}
function cleanName(n: unknown) { const s = typeof n === "string" ? n.trim() : ""; return s && [...s].length <= 200 ? s : null; }
function cleanNote(n: unknown) { const s = typeof n === "string" ? n.trim() : ""; return s || null; }
function checkDrives(ids: unknown, own: number | null): Res | null {
  if (!Array.isArray(ids) || !ids.length || ids.length > 500) return err(400, "drive_ids must contain 1-500 drives");
  if (ids.some(i => !driveById(Number(i)))) return err(404, "some drives were not found");
  const taken = ids.filter(i => { const j = journeyOf(Number(i)); return j && j.id !== own; });
  if (taken.length) return { status: 409, body: { error: "some drives already belong to another journey", drive_ids: taken } };
  return null;
}
function suggestions(q: URLSearchParams) {
  const gap = Math.min(1440, Math.max(1, Number(q.get("gap_min") ?? 60) || 60)) * 60, cgap = Math.min(1440, Math.max(1, Number(q.get("charge_gap_min") ?? 120) || 120)) * 60;
  const limit = Math.min(50, Math.max(1, Number(q.get("limit") ?? 10) || 10));
  const ds = [...db.drives].sort(byStartDesc).slice(0, 400).reverse().map(driveJson);
  const ep = (s: string | null) => s ? Math.floor(Date.parse(s) / 1000) : 0;
  const cs = db.charges.map(c => Math.floor(c.start / 1000));
  const between = (a: number, b: number) => cs.filter(t => t >= a - 120 && t <= b).length;
  const groups: [number[], number][] = []; let cur: number[] = [], cc = 0;
  for (let i = 0; i < ds.length; i++) {
    if (ds[i].journey_id != null || st.dismissed.includes(ds[i].id)) { if (cur.length > 1) groups.push([cur, cc]); cur = []; cc = 0; continue; }
    if (cur.length) { const last = cur[cur.length - 1], a = ep(ds[last].end_date), b = ep(ds[i].start_date), n = between(a, b);
      const span = ep(ds[i].end_date) - ep(ds[cur[0]].start_date) <= 3 * 86400;
      if (span && ((b - a) < gap || (n > 0 && (b - a) < cgap))) { cur.push(i); cc += n; continue; }
      if (cur.length > 1) groups.push([cur, cc]); }
    cur = [i]; cc = 0;
  }
  if (cur.length > 1) groups.push([cur, cc]);
  return ok(groups.reverse().slice(0, limit).map(([g, n]) => { const xs = g.map(i => ds[i]), f = xs[0], l = xs[xs.length - 1];
    const o: [number, number] = [f.start_lat, f.start_lng];
    const far = xs.reduce<{ d: number; x: typeof f } | null>((b, x) => { const d = hav(o, [x.end_lat, x.end_lng]); return !b || d > b.d ? { d, x } : b; }, null);
    const round = hav(o, [l.end_lat, l.end_lng]) < 1;
    return { drive_ids: xs.map(x => x.id), name: `${f.start_address ?? "?"} → ${(far ? far.x.end_address : l.end_address) ?? "?"}${round ? "（往返）" : ""}`, start_date: f.start_date, end_date: l.end_date,
      start_address: f.start_address, end_address: l.end_address, distance_km: r1(xs.reduce((s, x) => s + x.distance_km, 0)), duration_min: xs.reduce((s, x) => s + x.duration_min, 0), charge_count: n }; }));
}
function journeyPath(id: number) {
  const j = st.journeys.find(x => x.id === id); if (!j) return err(404, "journey not found");
  const rows = j.drive_ids.map(driveById).filter((d): d is DDrive => !!d).flatMap(d => d.pos).sort((a, b) => a.date - b.date);
  const total = rows.length, step = Math.max(1, Math.ceil(total / 3000)); let km = 0; const out = [];
  for (let i = 0; i < total; i++) { const p = rows[i]; const same = i > 0 && rows[i - 1].drive_id === p.drive_id;
    if (same) km += hav([rows[i - 1].lat, rows[i - 1].lng], [p.lat, p.lng]);
    const edge = !same || i + 1 === total || rows[i + 1].drive_id !== p.drive_id;
    if (edge || i % step === 0) out.push({ drive_id: p.drive_id, lat: p.lat, lng: p.lng, speed: p.speed, elevation: p.elevation, km: r2(km) }); }
  return ok({ points: out, total_points: total, downsampled: step > 1 });
}
function weather(id: number) {
  const j = st.journeys.find(x => x.id === id); if (!j) return ok({ drives: [], partial: false, attribution: "Demo data (synthetic weather)" });
  const ds = j.drive_ids.map(driveById).filter((d): d is DDrive => !!d).sort((a, b) => a.start - b.start);
  return ok({ drives: ds.map(d => ({ drive_id: d.id, temp_c: r1(climate(Math.floor(d.start / 3600e3) * 3600e3) - d.pos[0].elevation! * 0.0065 + ((d.id % 7) - 3) * 0.3), precip_mm: d.precip,
    source: db.now - d.start < 4 * 864e5 ? "forecast" : "archive" })), partial: false, attribution: "Demo data (synthetic weather, no Open-Meteo request)" });
}
function speedBands(id: number) {
  const j = st.journeys.find(x => x.id === id); if (!j || !j.drive_ids.length) return ok({ bands: [], method: "none" });
  const dist = [0, 0, 0], en = [0, 0, 0], dur = [0, 0, 0]; let measured = 0;
  for (const d of j.drive_ids.map(driveById).filter((d): d is DDrive => !!d)) {
    const segs: { b: number; km: number; kwh: number; dt: number }[] = [];
    for (let i = 1; i < d.pos.length; i++) { const p = d.pos[i], q = d.pos[i - 1]; const dt = (p.date - q.date) / 1000; if (dt >= 600) continue;
      const v = ((p.speed ?? q.speed ?? 0) + (q.speed ?? p.speed ?? 0)) / 2; const km = hav([q.lat, q.lng], [p.lat, p.lng]);
      segs.push({ b: v < 40 ? 0 : v <= 80 ? 1 : 2, km, kwh: p.power != null && q.power != null ? (p.power + q.power) / 2 * dt / 3600 : 0, dt }); }
    const te = Math.max(0, energy(d)), sum = segs.reduce((s, x) => s + x.kwh, 0), segkm = segs.reduce((s, x) => s + x.km, 0); measured += segkm;
    const scale = te > 0 && sum > 0 ? te / sum : 1, dscale = d.distance > 0 && segkm > 0 ? d.distance / segkm : 1;
    for (const s of segs) { dist[s.b] += s.km * dscale; en[s.b] += s.kwh * scale; dur[s.b] += s.dt; }
  }
  const tot = dist.reduce((a, b) => a + b, 0); const names = [["city", "市区"], ["suburb", "郊外"], ["highway", "高速"]];
  return ok({ bands: [0, 1, 2].map(b => ({ key: names[b][0], label: names[b][1], distance_km: r1(dist[b]), energy_kwh: r2(en[b]), wh_km: dist[b] >= 0.5 ? Math.round(en[b] * 1000 / dist[b]) : null,
    duration_min: r1(dur[b] / 60), share: tot > 0 ? Math.round(dist[b] / tot * 1000) / 10 : 0 })), method: tot > 0 && measured / tot > 0.5 ? "power" : "distance", thresholds_kmh: [40, 80] });
}

// ---------------- router ----------------
export function handle(method: string, url: string, body: unknown): Res {
  if (!db) initDemo();
  const u = new URL(url, "https://demo.invalid"); const p = u.pathname.replace(/\/+$/, ""), q = u.searchParams;
  let m: RegExpMatchArray | null;
  const M = method.toUpperCase();
  const B = (body ?? {}) as Record<string, unknown>;
  if (p === "/health" || p === "/api/health") return ok(health());
  if (p === "/api/cars" && M === "GET") return ok(cars());
  if ((m = p.match(/^\/api\/cars\/(\d+)\/(status|last-activity|stats|months|report|trends|footprint|battery)$/))) {
    // the demo has a single car: any car id (e.g. one remembered from a real server) is answered as the demo car
    switch (m[2]) { case "status": return ok(status()); case "last-activity": return ok(lastActivity()); case "stats": return stats(q); case "months": return months(q);
      case "report": return report(q); case "trends": return trends(q); case "footprint": return footprint(q); case "battery": return battery(q); }
  }
  if (p === "/api/drives") return list(db.drives, q, driveJson);
  if ((m = p.match(/^\/api\/drives\/(\d+)$/))) { const d = driveById(Number(m[1])); return d ? ok(driveJson(d)) : err(404, "not found"); }
  if ((m = p.match(/^\/api\/drives\/(\d+)\/path$/))) return drivePath(Number(m[1]));
  if (p === "/api/charges") return list(db.charges, q, chargeJson);
  if ((m = p.match(/^\/api\/charges\/(\d+)$/))) { const c = chargeById(Number(m[1])); return c ? ok({ ...chargeJson(c), points: chargePoints(c) }) : err(404, "not found"); }
  if ((m = p.match(/^\/api\/charges\/(\d+)\/cost$/))) {
    const c = chargeById(Number(m[1])); if (!c) return err(404, "charge not found");
    if (M === "PUT") { const amount = Number(B.amount), cur = String(B.currency ?? "").trim().toUpperCase();
      if (!isFinite(amount) || amount < 0 || amount >= 1e9) return err(400, "amount must be 0..1e9");
      if (!/^[A-Z]{3}$/.test(cur)) return err(400, "currency must be a 3-letter ISO 4217 code");
      st.costs[c.id] = { amount: Math.round(amount * 100) / 100, currency: cur, note: cleanNote(B.note) }; commit(); return ok(chargeJson(c)); }
    if (M === "DELETE") { st.costs[c.id] = null; commit(); return ok(chargeJson(c)); }
  }
  if (p === "/api/addresses/aliases") return ok(Object.entries(st.aliases).map(([id, a]) => ({ address_id: Number(id), name: a.name, original_name: addr(Number(id))?.name ?? null, updated_at: TS(a.at) })).sort((a, b) => a.name.localeCompare(b.name)));
  if ((m = p.match(/^\/api\/addresses\/(\d+)\/alias$/))) {
    const id = Number(m[1]); if (!addr(id)) return err(404, "address not found");
    if (M === "PUT") { const n = cleanName(B.name); if (!n) return err(400, "name must be 1-200 characters"); st.aliases[id] = { name: n, at: Date.now() }; commit();
      return ok({ address_id: id, name: n, original_name: addr(id)!.name, updated_at: TS(Date.now()) }); }
    if (M === "DELETE") { if (!st.aliases[id]) return err(404, "no alias"); delete st.aliases[id]; commit(); return { status: 204 }; }
  }
  if (p === "/api/journeys" && M === "GET") return journeyList(q);
  if (p === "/api/journeys" && M === "POST") {
    const n = cleanName(B.name); if (!n) return err(400, "name must be 1-200 characters");
    const bad = checkDrives(B.drive_ids, null); if (bad) return bad;
    const id = st.nextJ++; st.journeys.push({ id, name: n, note: cleanNote(B.note), drive_ids: [...new Set((B.drive_ids as unknown[]).map(Number))], cover: null, cover_at: null }); commit();
    return journeyDetail(id);
  }
  if (p === "/api/journeys/suggestions") return suggestions(q);
  if (p === "/api/journeys/suggestions/dismiss" && M === "POST") { const ids = (Array.isArray(B.drive_ids) ? B.drive_ids : []).map(Number).filter(i => driveById(i) && !st.dismissed.includes(i));
    if (!Array.isArray(B.drive_ids) || !B.drive_ids.length) return err(400, "drive_ids must contain 1-1000 drives"); st.dismissed.push(...ids); commit(); return ok({ dismissed: ids.length }); }
  if (p === "/api/journeys/suggestions/dismissed" && M === "DELETE") { const n = st.dismissed.length; st.dismissed = []; commit(); return ok({ restored: n }); }
  if ((m = p.match(/^\/api\/journeys\/(\d+)$/))) {
    const id = Number(m[1]), j = st.journeys.find(x => x.id === id);
    if (M === "GET") return journeyDetail(id);
    if (!j) return err(404, "journey not found");
    if (M === "PATCH") { if ("name" in B) { const n = cleanName(B.name); if (!n) return err(400, "name must be 1-200 characters"); j.name = n; } if ("note" in B) j.note = cleanNote(B.note); commit(); return journeyDetail(id); }
    if (M === "DELETE") { st.journeys = st.journeys.filter(x => x.id !== id); commit(); return { status: 204 }; }
  }
  if ((m = p.match(/^\/api\/journeys\/(\d+)\/drives$/)) && M === "PUT") {
    const id = Number(m[1]), j = st.journeys.find(x => x.id === id); if (!j) return err(404, "journey not found");
    const bad = checkDrives(B.drive_ids, id); if (bad) return bad; j.drive_ids = [...new Set((B.drive_ids as unknown[]).map(Number))]; commit(); return journeyDetail(id);
  }
  if ((m = p.match(/^\/api\/journeys\/(\d+)\/path$/))) return journeyPath(Number(m[1]));
  if ((m = p.match(/^\/api\/journeys\/(\d+)\/weather$/))) return weather(Number(m[1]));
  if ((m = p.match(/^\/api\/journeys\/(\d+)\/speed-bands$/))) return speedBands(Number(m[1]));
  if ((m = p.match(/^\/api\/journeys\/(\d+)\/cover$/))) {
    const j = st.journeys.find(x => x.id === Number(m![1])); if (!j) return err(404, "journey not found");
    if (M === "GET") return ok({ image: j.cover, updated_at: j.cover_at ? TS(j.cover_at) : null });
    if (M === "PUT") { const img = String(B.image ?? ""); if (!/^data:image\/(jpeg|png|webp);base64,/.test(img)) return err(400, "image must be a JPEG/PNG/WebP data URL");
      if (img.length > 1_500_000) return err(413, "image too large (max ~1 MB)"); j.cover = img; j.cover_at = Date.now(); commit(); return { status: 204 }; }
    if (M === "DELETE") { j.cover = null; j.cover_at = null; commit(); return { status: 204 }; }
  }
  if (p.startsWith("/api/auth/")) return auth(M, p, q, B);
  return err(404, "not found");
}

// ---------------- device auth (api/src/auth.rs), in memory only: a reload starts over ----------------
interface DDevice { id: number; name: string; scope: "full" | "read"; created_via: "owner_key" | "pairing"; created_at: string; expires_at: string | null;
  last_used_at: string | null; last_ip: string | null; user_agent: string | null; current: boolean }
let devs: DDevice[] | null = null;
const DEMO_DEVICE = 1;
function demoDevices(): DDevice[] {
  if (devs) return devs;
  const now = Date.now(), d = 864e5;
  return devs = [
    { id: DEMO_DEVICE, name: "Demo phone", scope: "full", created_via: "owner_key", created_at: TS(now - 40 * d), expires_at: null, last_used_at: TS(now), last_ip: "192.0.2.10", user_agent: "Demo", current: true },
    { id: 2, name: "Mac · Safari", scope: "full", created_via: "pairing", created_at: TS(now - 25 * d), expires_at: null, last_used_at: TS(now - 3 * 3600e3), last_ip: "192.0.2.24", user_agent: "Demo", current: false },
    { id: 3, name: "iPad · Safari", scope: "read", created_via: "pairing", created_at: TS(now - 9 * d), expires_at: TS(now + 21 * d), last_used_at: TS(now - 2 * d), last_ip: "198.51.100.7", user_agent: "Demo", current: false },
  ];
}
const devName = (v: unknown) => { const n = String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim(); return n && [...n].length <= 60 ? n : null; };
function auth(M: string, p: string, q: URLSearchParams, B: Record<string, unknown>): Res {
  const list = demoDevices();
  const bad = (status: number, code: string, error: string): Res => ({ status, body: { error, code } });
  const find = (id: string) => list.find(d => id === "current" ? d.current : d.id === Number(id));
  if (p === "/api/auth/me" && M === "GET") return ok({ kind: "device", device: find("current") ?? null, device_auth: true, owner_key_mode: "full" });
  if (p === "/api/auth/devices" && M === "GET") return ok([...list].sort((a, b) => b.created_at.localeCompare(a.created_at)));
  if (p === "/api/auth/devices" && M === "POST") return bad(403, "owner_key_required", "the server token is required to create a device");
  if (p === "/api/auth/devices" && M === "DELETE") {
    if (q.get("except") !== "current") return bad(400, "bad_request", "use ?except=current");
    const n = list.filter(d => !d.current).length; devs = list.filter(d => d.current); return ok({ revoked: n });
  }
  let m: RegExpMatchArray | null;
  if ((m = p.match(/^\/api\/auth\/devices\/(current|\d+)$/))) {
    const d = find(m[1]); if (!d) return bad(404, "not_found", "device not found");
    if (M === "PATCH") { const n = devName(B.name); if (!n) return bad(400, "invalid_name", "name must be 1-60 characters"); d.name = n; return ok(d); }
    if (M === "DELETE") { devs = list.filter(x => x !== d); return { status: 204 }; }
  }
  if (p === "/api/auth/pairings" && M === "POST") {
    const scope = B.scope === "read" ? "read" : B.scope === "full" || B.scope == null ? "full" : null;
    if (!scope) return bad(400, "invalid_scope", "scope must be \"full\" or \"read\"");
    return { status: 201, body: { code: "7KQ2-M9XD", expires_at: TS(Date.now() + 600e3) } };
  }
  if (p === "/api/auth/pair" && M === "POST") return bad(400, "invalid_code", "invalid or expired pairing code");
  return err(404, "not found");
}
