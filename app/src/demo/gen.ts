// SPDX-License-Identifier: AGPL-3.0-or-later
// Demo Mode data generator: a deterministic, TeslaMate-shaped dataset (~3 months ending "now") built from
// real road geometry (routes.json: OSRM / OpenStreetMap, ODbL) — no network. Everything is computed in memory.
import R from "./routes.json";

export const DEMO_CAR_ID = 901;
const EFF = 0.1345;              // kWh per rated km (car.efficiency)
const TZ_OFF = 9 * 3600e3;       // the demo car lives in Tokyo (JST, no DST)
const DAYS = 92;

export interface Addr { id: number; name: string; city: string; lat: number; lng: number; key: string }
export interface Pos { date: number; lat: number; lng: number; speed: number | null; elevation: number | null; battery_level: number; power: number | null; odometer: number; ideal: number; rated: number; drive_id: number | null }
export interface DDrive { id: number; start: number; end: number; sa: number; ea: number; sg: number | null; eg: number | null; distance: number; duration_min: number;
  speed_max: number; srr: number; err: number; temp: number; pos: Pos[]; route: string; precip: number }
export interface CPoint { date: number; battery_level: number; charge_energy_added: number; charger_power: number; charger_voltage: number; charger_actual_current: number; charger_phases: number | null; fast: boolean }
export interface DCharge { id: number; start: number; end: number; addr: number; geo: number | null; lat: number; lng: number; odometer: number; added: number; used: number;
  sl: number; el: number; srr: number; err: number; duration_min: number; temp: number; cost: number | null; points: CPoint[] }
export interface DB { now: number; car: { id: number; name: string; model: string; marketing_name: string | null; trim_badging: string; exterior_color: string; wheel_type: string; vin: string; efficiency: number };
  addresses: Addr[]; geofences: { id: number; name: string }[]; drives: DDrive[]; charges: DCharge[];
  journeys: { id: number; name: string; note: string | null; drive_ids: number[] }[]; manualCosts: Record<number, { amount: number; currency: string; note: string | null }>;
  software: { version: string; installed: number }; attribution: string }

// ---------- utils ----------
function mulberry(seed: number) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function decode(s: string): [number, number][] {
  const out: [number, number][] = []; let i = 0, la = 0, lo = 0;
  while (i < s.length) { const v: number[] = [];
    for (let k = 0; k < 2; k++) { let sh = 0, r = 0, b: number; do { b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32); v.push(r & 1 ? ~(r >> 1) : r >> 1); }
    la += v[0]; lo += v[1]; out.push([la / 1e5, lo / 1e5]); }
  return out;
}
export function hav(a: [number, number], b: [number, number]) {
  const r = Math.PI / 180, la1 = a[0] * r, la2 = b[0] * r, dl = la2 - la1, dn = (b[1] - a[1]) * r;
  const h = Math.sin(dl / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dn / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}
/** Tokyo climatology (°C) by local time; elevation lapse rate applied by the caller. */
export function climate(ms: number, rnd = 0) {
  const d = new Date(ms + TZ_OFF), doy = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5;
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  return 16.3 - 10.6 * Math.cos(2 * Math.PI * (doy - 22) / 365) + 3.6 * Math.cos(2 * Math.PI * (h - 14.5) / 24) + rnd;
}
const r1 = (v: number) => Math.round(v * 10) / 10;

type Route = { pts: [number, number][]; spd: number[]; ele: number[]; seg: number[] };
const ROUTES: Record<string, Route> = {};
for (const [k, v] of Object.entries(R.routes as Record<string, { poly: string; spd: number[]; ele: number[] }>)) {
  const pts = decode(v.poly);
  // DEM samples along mountain roads are noisy: smooth (moving average) so climbs are not over-counted
  const ele = v.ele.map((_, i) => { let s = 0, n = 0; for (let k = Math.max(0, i - 3); k <= Math.min(v.ele.length - 1, i + 3); k++) { s += v.ele[k]; n++; } return s / n; });
  ROUTES[k] = { pts, spd: v.spd, ele, seg: pts.slice(1).map((p, i) => hav(pts[i], p)) };
}
const PL = R.places as Record<string, { lat: number; lng: number; address: string; geofence: string | null }>;

export function generate(nowMs: number = Date.now()): DB {
  const now = Math.floor(nowMs / 1000) * 1000;
  const addresses: Addr[] = Object.entries(PL).map(([key, p], i) => {
    const [name, ...city] = p.address.split(", ");
    return { id: 9001 + i, key, name, city: city.join(", "), lat: p.lat, lng: p.lng };
  });
  const addrOf = (k: string) => addresses.find(a => a.key === k)!;
  const geofences = [{ id: 901, name: PL.H.geofence! }];
  const drives: DDrive[] = [], charges: DCharge[] = [];
  const todayAbs = Math.floor((now + TZ_OFF) / 864e5);           // local day number
  const day0 = todayAbs - DAYS + 1;
  const localMs = (abs: number, hour: number) => abs * 864e5 - TZ_OFF + hour * 3600e3;
  // state
  let level = 78, odo = 18240.0, place = "H";
  const r100 = (t: number) => 440.6 - 4.2 * ((t - localMs(day0, 0)) / (DAYS * 864e5)); // gentle fade
  const cap = (t: number) => r100(t) * EFF;
  let lastT = localMs(day0, 0);
  const rainy = (abs: number) => mulberry(abs * 7 + 3)() < 0.27;

  function drive(abs: number, key: string, depart: number, seq: number, rnd: () => number): number {
    const rt = ROUTES[key]; const [a, b] = key.split(">");
    const t0 = Math.max(depart, lastT + 5 * 60e3);
    const rush = (() => { const h = new Date(t0 + TZ_OFF).getUTCHours(); return h >= 7 && h <= 9 || h >= 17 && h <= 19; })();
    const tempBase = climate(t0, (rnd() - 0.5) * 3) - (rainy(abs) ? 2 : 0);
    const climateFactor = tempBase < 8 ? 1.16 : tempBase < 14 ? 1.07 : tempBase > 28 ? 1.06 : 1.0;
    // segment speeds with traffic
    const sp = rt.spd.map(v => v >= 70 ? v * (0.86 + rnd() * 0.12) : v * (rush ? 0.42 : 0.55) * (0.85 + rnd() * 0.3));
    const pos: Pos[] = []; let t = t0, e = 0, dist = 0, vmax = 0; const step = 12; // s
    const startLevel = level, start = t0;
    const id = (abs % 100000) * 10 + seq;
    let segI = 0, segPos = 0; // km into current segment
    const push = (lat: number, lng: number, v: number | null, ele: number, pw: number | null) => {
      const lv = startLevel - e / cap(t) * 100;
      pos.push({ date: t, lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, speed: v == null ? null : Math.round(v), elevation: Math.round(ele),
        battery_level: Math.max(1, Math.round(lv)), power: pw == null ? null : Math.round(pw), odometer: Math.round((odo + dist) * 100) / 100,
        ideal: r1(lv / 100 * r100(t) * 1.02), rated: r1(lv / 100 * r100(t)), drive_id: id });
    };
    push(rt.pts[0][0], rt.pts[0][1], 0, rt.ele[0], 0);
    while (segI < rt.seg.length) {
      let left = step / 3600; // h
      let lastV = 0, gain = 0;
      while (left > 0 && segI < rt.seg.length) {
        const v = Math.max(6, sp[segI]), rem = rt.seg[segI] - segPos, dt = rem / v;
        if (dt <= left) { left -= dt; dist += rem; gain += rt.ele[segI + 1] - rt.ele[segI]; segI++; segPos = 0; lastV = v; }
        else { segPos += v * left; dist += v * left; gain += (rt.ele[segI + 1] - rt.ele[segI]) * (v * left / rt.seg[segI]); left = 0; lastV = v; }
      }
      const dtS = step - left * 3600; t += dtS * 1000;
      const v = segI < rt.seg.length ? lastV * (0.9 + rnd() * 0.2) : 0;
      const whkm = (112 + 0.0042 * lastV * lastV + (lastV < 35 ? 12 : 0)) * climateFactor;
      const km = lastV * dtS / 3600;
      const de = whkm * km / 1000 + (gain > 0 ? gain * 0.0044 : gain * 0.0052 * 0.65);
      e += Math.max(-0.02, de);
      vmax = Math.max(vmax, v);
      const i = Math.min(segI, rt.seg.length - 1), f = segI < rt.seg.length ? segPos / rt.seg[i] : 1;
      const p0 = rt.pts[i], p1 = rt.pts[Math.min(i + 1, rt.pts.length - 1)];
      push(p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f, v, rt.ele[i] + (rt.ele[Math.min(i + 1, rt.ele.length - 1)] - rt.ele[i]) * f, de / (dtS / 3600));
    }
    const end = t;
    const endLevel = startLevel - e / cap(end) * 100;
    const ele0 = rt.ele.reduce((s, x) => s + x, 0) / rt.ele.length;
    drives.push({ id, start, end, sa: addrOf(a).id, ea: addrOf(b).id, sg: a === "H" ? 901 : null, eg: b === "H" ? 901 : null,
      distance: Math.round(dist * 100) / 100, duration_min: Math.round((end - start) / 60e3), speed_max: Math.round(vmax),
      srr: r1(startLevel / 100 * r100(start)), err: r1(endLevel / 100 * r100(end)), temp: r1(tempBase - ele0 * 0.0065), pos, route: key, precip: rainy(abs) ? r1(0.4 + rnd() * 3) : 0 });
    level = endLevel; odo += dist; place = b; lastT = end;
    return end;
  }

  function charge(abs: number, at: number, seq: number, target: number, kind: "home" | "sc" | "dc" | "ac", rnd: () => number): number {
    const a = addrOf(place); const t0 = Math.max(at, lastT + 3 * 60e3);
    const id = (abs % 100000) * 10 + seq;
    const fast = kind === "sc" || kind === "dc";
    const pts: CPoint[] = []; let t = t0, lv = level, added = 0; const step = fast ? 30 : 90;
    const sl = Math.round(level);
    if (level >= target - 3) return lastT;
    while (lv < target) {
      let kw: number;
      if (kind === "home" || kind === "ac") kw = 5.6 + rnd() * 0.5;
      else if (kind === "dc") kw = Math.min(48, 30 + lv * 0.6) * (0.95 + rnd() * 0.05);
      else kw = (lv < 12 ? 125 + lv * 4 : lv < 40 ? 168 : lv < 60 ? 168 - (lv - 40) * 3 : lv < 80 ? 108 - (lv - 60) * 2.4 : 60 - (lv - 80) * 2.4) * (0.96 + rnd() * 0.06);
      const dkwh = kw * step / 3600 * 0.97;
      added += dkwh; lv += dkwh / cap(t) * 100; t += step * 1000;
      pts.push({ date: t, battery_level: Math.min(100, Math.round(lv)), charge_energy_added: Math.round(added * 100) / 100, charger_power: Math.round(kw),
        charger_voltage: fast ? 2 : 202, charger_actual_current: fast ? 0 : Math.round(kw * 1000 / 202), charger_phases: fast ? null : 1, fast });
      if (pts.length > 2000) break;
    }
    const end = t + 60e3;
    const used = added * (fast ? 1.03 : 1.09);
    const rate = kind === "home" ? 31 : 0;
    charges.push({ id, start: t0, end, addr: a.id, geo: place === "H" ? 901 : null, lat: a.lat, lng: a.lng, odometer: Math.round(odo * 100) / 100,
      added: Math.round(added * 100) / 100, used: Math.round(used * 100) / 100, sl, el: Math.round(lv), srr: r1(level / 100 * r100(t0)), err: r1(lv / 100 * r100(end)),
      duration_min: Math.round((end - t0) / 60e3), temp: r1(climate(t0)), cost: kind === "home" ? Math.round(used * rate) : kind === "ac" ? 0 : null, points: pts });
    level = lv; lastT = end;
    return end;
  }

  const special = new Map<number, string>([[todayAbs - 5, "hakone"], [todayAbs - 37, "fuji"], [todayAbs - 19, "shonan"], [todayAbs - 12, "bay"],
    [todayAbs - 29, "sck"], [todayAbs - 61, "sck"], [todayAbs - 73, "makuhari"], [todayAbs - 50, "hakone2"]]);
  const journeyDays: Record<string, number[]> = {};
  for (let abs = day0; abs <= todayAbs; abs++) {
    const rnd = mulberry(abs * 2654435761 % 2147483647);
    const H = (h: number) => localMs(abs, h);
    const dow = new Date(abs * 864e5).getUTCDay(); const weekend = dow === 0 || dow === 6;
    let seq = 0, cseq = 0; const firstDrive = drives.length;
    const go = (key: string, h: number) => drive(abs, key, H(h), seq++, rnd);
    const sp = special.get(abs);
    const homeNight = (tgt = 80) => { if (place === "H" && level < 62 && special.get(abs + 1) !== "sck" && special.get(abs + 2) !== "sck") charge(abs, Math.max(H(23), lastT), 5 + cseq++, tgt, "home", rnd); };
    if (sp === "hakone" || sp === "hakone2") {
      if (level < 60) charge(abs, H(4), 5 + cseq++, 78, "home", rnd);
      go("H>SCE", 8.2); charge(abs, lastT + 2 * 60e3, 5 + cseq++, Math.max(88, Math.min(95, level + 25)), "sc", rnd);
      go("SCE>HY", 0); go("HY>AS", lastT / 3600e3 - abs * 24 + 9 + 2.2); go("AS>H", lastT / 3600e3 - abs * 24 + 9 + 1.6);
      if (sp === "hakone") journeyDays.hakone = drives.slice(firstDrive).map(d => d.id);
    } else if (sp === "fuji") {
      if (level < 70) charge(abs, H(3.5), 5 + cseq++, 85, "home", rnd);
      go("H>SCH", 7.4); charge(abs, lastT + 2 * 60e3, 5 + cseq++, Math.max(90, Math.min(95, level + 25)), "sc", rnd);
      go("SCH>KW", 0); go("KW>DF", lastT / 3600e3 - abs * 24 + 9 + 2.4); charge(abs, lastT + 2 * 60e3, 5 + cseq++, Math.min(90, level + 14), "dc", rnd);
      go("DF>GO", 0); go("GO>H", lastT / 3600e3 - abs * 24 + 9 + 2.6);
      journeyDays.fuji = drives.slice(firstDrive).map(d => d.id);
    } else if (sp === "shonan") { go("H>KM", 9.6); go("KM>EN", lastT / 3600e3 - abs * 24 + 9 + 0.8); go("EN>H", lastT / 3600e3 - abs * 24 + 9 + 0.7); }
    else if (sp === "bay") { go("H>MM", 13.1); go("MM>OD", lastT / 3600e3 - abs * 24 + 9 + 0.65); go("OD>H", lastT / 3600e3 - abs * 24 + 9 + 0.85); }
    else if (sp === "sck") { go("H>SCK", 10 + rnd()); charge(abs, lastT + 60e3, 5 + cseq++, Math.max(85, Math.min(95, level + 30)), "sc", rnd); go("SCK>H", 0); }
    else if (sp === "makuhari") { go("H>MK", 9.2); go("MK>H", lastT / 3600e3 - abs * 24 + 9 + 4.5); }
    else if (!weekend) {
      if (rnd() < 0.78) {
        go("H>O", 7.9 + rnd() * 0.7);
        if (rnd() < 0.16) { go("O>SH", 18.4 + rnd() * 0.8); go("SH>H", 21 + rnd() * 1.2); }
        else go("O>H", 18.2 + rnd() * 1.6);
      } else if (rnd() < 0.4) { go("H>KJ", 10 + rnd() * 3); go("KJ>H", lastT / 3600e3 - abs * 24 + 9 + 1.5 + rnd()); }
    } else {
      const outings = [["H>FT", "FT>H", 2.2], ["H>KJ", "KJ>H", 1.8], ["H>MM", "MM>H", 3.5], ["H>SH", "SH>H", 2.6], ["H>OD", "OD>H", 3]] as const;
      const n = rnd() < 0.3 ? 2 : rnd() < 0.85 ? 1 : 0; let h = 10 + rnd() * 1.5;
      for (let k = 0; k < n; k++) {
        const o = outings[Math.floor(rnd() * outings.length)];
        go(o[0], h);
        if (o[0] === "H>FT" && rnd() < 0.5) charge(abs, lastT + 5 * 60e3, 5 + cseq++, Math.min(90, level + 9), "ac", rnd);
        go(o[1], lastT / 3600e3 - abs * 24 + 9 + o[2] + rnd() * 0.5);
        h = lastT / 3600e3 - abs * 24 + 9 + 1.5 + rnd() * 2;
      }
    }
    homeNight(rnd() < 0.15 ? 90 : 80);
  }
  // drop anything not finished yet ("now")
  const dv = drives.filter(d => d.end <= now), cv = charges.filter(c => c.end <= now);
  const manualCosts: DB["manualCosts"] = {};
  for (const c of cv) {
    const a = addresses.find(x => x.id === c.addr)!;
    if (/^Supercharger/.test(a.name)) manualCosts[c.id] = { amount: Math.round(c.added * 66), currency: "JPY", note: null };
    if (/急速/.test(a.name)) manualCosts[c.id] = { amount: Math.round(Math.max(1, c.duration_min / 30) * 1350), currency: "JPY", note: "30分 1,350円" };
  }
  const sc = cv.filter(c => manualCosts[c.id] && /^Supercharger/.test(addresses.find(x => x.id === c.addr)!.name));
  if (sc[0]) manualCosts[sc[0].id].note = "Tesla app receipt";
  const journeys = [
    { id: 1, name: "箱根日帰り", note: "Ashinoko & Hakone-Yumoto. Supercharger stop at Ebina.", drive_ids: (journeyDays.hakone ?? []).filter(i => dv.some(d => d.id === i)) },
    { id: 2, name: "富士五湖ドライブ", note: null, drive_ids: (journeyDays.fuji ?? []).filter(i => dv.some(d => d.id === i)) },
  ].filter(j => j.drive_ids.length);
  const sw = new Date(now - 21 * 864e5);
  return { now, car: { id: DEMO_CAR_ID, name: "Demo Car", model: "3", marketing_name: null, trim_badging: "RWD", exterior_color: "PearlWhite", wheel_type: "Photon18", vin: "DEMO00000000000001", efficiency: EFF },
    addresses, geofences, drives: dv, charges: cv, journeys, manualCosts,
    software: { version: `${sw.getUTCFullYear()}.${Math.max(2, Math.ceil(((sw.getTime() - Date.UTC(sw.getUTCFullYear(), 0, 1)) / 864e5) / 7) - 4)}.5`, installed: sw.getTime() },
    attribution: (R as { attribution: string }).attribution };
}
