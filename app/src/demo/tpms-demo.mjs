// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared TPMS demo series: one underlying hourly series per wheel, then
// aggregated for 7d (hour) / 30|90d (day). Used by demo/server.ts and scripts/check-demo-tpms.mjs.

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const round01 = (v) => Math.round(v * 10) / 10;

const fmtCache = new Map();
export function parts(ms, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== "literal") o[p.type] = Number(p.value);
  return { y: o.year, m: o.month, d: o.day, h: o.hour % 24, mi: o.minute, s: o.second };
}

export function zoned(y, m, d, tz) {
  let g = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 3; i++) {
    const p = parts(g, tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    g += Date.UTC(y, m - 1, d) - asUtc;
  }
  return g;
}

const dayKey = (ms, tz) => {
  const p = parts(ms, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
};

const frac = (n) => {
  const x = Math.sin(n) * 43758.5453;
  return x - Math.floor(x);
};

/** Irregular multi-day weather: weak incommensurate waves + stronger smoothstepped noise (seeded). */
function weatherBar(dayFloat) {
  const i0 = Math.floor(dayFloat);
  const f = dayFloat - i0;
  const u = f * f * (3 - 2 * f);
  // Daily targets with several hash octaves so the envelope is not a single period.
  const noiseAt = (i) => {
    const a = frac(i * 1.71 + 0.37) - 0.5;
    const b = frac(i * 2.29 + 1.13) - 0.5;
    const c = frac(i * 0.93 + 4.21) - 0.5;
    const d = frac(i * 3.17 + 2.7) - 0.5;
    return a * 0.45 + b * 0.3 + c * 0.15 + d * 0.1;
  };
  // Hermite across today/tomorrow, with a little look-behind for slower drift.
  const nPrev = noiseAt(i0 - 1), n0 = noiseAt(i0), n1 = noiseAt(i0 + 1);
  const smooth = (nPrev * (1 - u) + n0) * 0.35 + (n0 * (1 - u) + n1 * u) * 0.65;
  const wave =
    0.02 * Math.sin(dayFloat * 0.53 + 0.8) +
    0.018 * Math.sin(dayFloat * 0.91 + 2.1) +
    0.015 * Math.sin(dayFloat * 1.37 + 0.4) +
    0.012 * Math.sin(dayFloat * 0.27 + 3.5) +
    0.01 * Math.sin(dayFloat * 2.03 + 1.6);
  return wave + 0.11 * smooth;
}

const BASE = { fl: 2.88, fr: 2.84, rl: 2.72, rr: 2.78 };
const TARGET = { fl: 2.3, fr: 2.8, rl: 2.7, rr: 2.8 };

/** One sensor reading at `ts` (deterministic). */
function sensorAt(ts, t1, tz) {
  const p = parts(ts, tz);
  const ageDays = Math.max(0, (t1 - ts) / 864e5);
  const dayFrac = (p.h + p.mi / 60) / 24;
  const dayFloat = ts / 864e5;
  const dayNight = 0.10 * Math.sin((dayFrac - 0.2) * Math.PI * 2);
  const weather = weatherBar(dayFloat);
  const drive = (p.h >= 7 && p.h < 9 ? 0.04 : 0) + (p.h >= 17 && p.h < 19 ? 0.05 : 0);
  const temp = 12 + 10 * (0.55 + 0.45 * Math.sin((dayFrac - 0.2) * Math.PI * 2)) + 4 * weatherBar(dayFloat + 0.15);
  const noise = (seed) => frac(seed) * 0.08 - 0.04;
  // Soft pull toward home-tile currents in the last ~1.5 days so the final hour lands near TARGET.
  const pull = Math.max(0, Math.min(1, 1 - ageDays / 1.5));
  const leak = ageDays < 14 ? (14 - ageDays) / 14 : 0; // 0 far ago → 1 at now
  const flRaw = BASE.fl + dayNight * 0.9 + weather * 0.85 + drive * 0.9 - 0.58 * leak;
  const frRaw = BASE.fr + dayNight * 1.0 + weather * 1.05 + drive * 1.0 + 0.015 * Math.sin(ts / 1.7e7);
  const rlRaw = BASE.rl + dayNight * 0.95 + weather * 0.9 + drive * 0.95 + 0.018 * Math.sin(ts / 1.9e7 + 1.2);
  const rrRaw = BASE.rr + dayNight * 1.05 + weather * 1.0 + drive * 1.05 + 0.015 * Math.sin(ts / 2.1e7 + 2.1);
  const blend = (raw, tgt) => raw * (1 - 0.85 * pull) + tgt * (0.85 * pull);
  return {
    fl: round01(Math.max(2.15, blend(flRaw, TARGET.fl) + noise(ts * 1.01 + 11))),
    fr: round01(blend(frRaw, TARGET.fr) + noise(ts * 1.03 + 23)),
    rl: round01(blend(rlRaw, TARGET.rl) + noise(ts * 1.07 + 37)),
    rr: round01(blend(rrRaw, TARGET.rr) + noise(ts * 1.11 + 53)),
    temp,
  };
}

/**
 * Build the canonical hourly series covering [t0, t1).
 * Each hour: average of 4 fixed sub-samples → 2-decimal avg, 0.1 min.
 */
export function buildHourlySeries(t0, t1, tz) {
  const hourMs = 3600e3;
  const out = [];
  // Align to hour boundaries in the local timezone by walking UTC hours from t0.
  const start = Math.floor(t0 / hourMs) * hourMs;
  for (let hStart = start; hStart < t1; hStart += hourMs) {
    if (hStart + hourMs <= t0) continue;
    const end = Math.min(hStart + hourMs, t1);
    if (end <= hStart) continue;
    const fls = [], frs = [], rls = [], rrs = [], temps = [];
    const n = 4;
    for (let s = 0; s < n; s++) {
      const ts = hStart + (end - hStart) * (s + 0.5) / n;
      const v = sensorAt(ts, t1, tz);
      fls.push(v.fl); frs.push(v.fr); rls.push(v.rl); rrs.push(v.rr); temps.push(v.temp);
    }
    const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    const mn = (a) => Math.min(...a);
    out.push({
      tMs: hStart,
      day: dayKey(hStart, tz),
      fl_avg: r2(avg(fls)), fr_avg: r2(avg(frs)), rl_avg: r2(avg(rls)), rr_avg: r2(avg(rrs)),
      fl_min: round01(mn(fls)), fr_min: round01(mn(frs)), rl_min: round01(mn(rls)), rr_min: round01(mn(rrs)),
      outside_temp_avg: r1(avg(temps)),
      n,
    });
  }
  return out;
}

/** Aggregate hourly points into local-day buckets (mean of that day's hours). */
export function aggregateDaily(hours) {
  const byDay = new Map();
  for (const h of hours) {
    let g = byDay.get(h.day);
    if (!g) { g = { tMs: h.tMs, day: h.day, hours: [] }; byDay.set(h.day, g); }
    // Keep earliest hour ms as the day bucket timestamp (matches API "day start").
    if (h.tMs < g.tMs) g.tMs = h.tMs;
    g.hours.push(h);
  }
  const out = [];
  for (const g of byDay.values()) {
    const hs = g.hours;
    const avg = (key) => r2(hs.reduce((s, h) => s + h[key], 0) / hs.length);
    const mn = (key) => round01(Math.min(...hs.map(h => h[key])));
    out.push({
      tMs: g.tMs,
      day: g.day,
      fl_avg: avg("fl_avg"), fr_avg: avg("fr_avg"), rl_avg: avg("rl_avg"), rr_avg: avg("rr_avg"),
      fl_min: mn("fl_min"), fr_min: mn("fr_min"), rl_min: mn("rl_min"), rr_min: mn("rr_min"),
      outside_temp_avg: r1(hs.reduce((s, h) => s + h.outside_temp_avg, 0) / hs.length),
      n: hs.reduce((s, h) => s + h.n, 0),
    });
  }
  out.sort((a, b) => a.tMs - b.tMs);
  return out;
}

export function snapLastToCurrent(series, cur) {
  if (!series.length) return;
  const last = series[series.length - 1];
  last.fl_avg = cur.fl; last.fr_avg = cur.fr; last.rl_avg = cur.rl; last.rr_avg = cur.rr;
  last.fl_min = cur.fl; last.fr_min = cur.fr; last.rl_min = cur.rl; last.rr_min = cur.rr;
}

/**
 * Build demo TPMS history for a range from one shared hourly series.
 * @returns {{ bucket: 'hour'|'day', series: object[] }}
 */
export function buildTpmsDemoHistory({ days, tz, nowMs, current }) {
  const raw = days === 7 || days === 30 || days === 90 ? days : 30;
  const bucket = raw <= 7 ? "hour" : "day";
  const pNow = parts(nowMs, tz);
  const dayStart = zoned(pNow.y, pNow.m, pNow.d, tz);
  const t0 = dayStart - (raw - 1) * 864e5;
  const t1 = nowMs;
  // Always materialise hourly points for this window, then aggregate if needed.
  const hours = buildHourlySeries(t0, t1, tz);
  const series = bucket === "hour" ? hours.map(h => ({ ...h })) : aggregateDaily(hours);
  snapLastToCurrent(series, current);
  return { days: raw, bucket, t0, t1, dayStart, series, hours };
}

/**
 * Assert 7d hourly daily-means match 30d daily buckets for the overlapping days
 * (excluding the newest day, whose last point is snapped to `current`).
 */
export function checkTpmsRangeAgreement({ nowMs, tz = "Asia/Tokyo", current = TARGET }) {
  const h7 = buildTpmsDemoHistory({ days: 7, tz, nowMs, current });
  const h30 = buildTpmsDemoHistory({ days: 30, tz, nowMs, current });
  const fromHourly = aggregateDaily(h7.hours);
  const byDay30 = new Map(h30.series.map(s => [s.day, s]));
  const issues = [];
  const wheels = ["fl_avg", "fr_avg", "rl_avg", "rr_avg"];
  // Skip the last (partial / snapped) day — agreement is about historical levels.
  const lastDay = dayKey(nowMs, tz);
  for (const d of fromHourly) {
    if (d.day === lastDay) continue;
    const b = byDay30.get(d.day);
    if (!b) { issues.push(`30d missing day ${d.day}`); continue; }
    for (const w of wheels) {
      if (Math.abs(d[w] - b[w]) > 0.011) {
        issues.push(`${d.day} ${w}: 7d-mean ${d[w]} != 30d ${b[w]}`);
      }
    }
  }
  // Last point equals current tiles.
  for (const hist of [h7, h30]) {
    const last = hist.series[hist.series.length - 1];
    for (const w of ["fl", "fr", "rl", "rr"]) {
      if (last[`${w}_avg`] !== current[w]) {
        issues.push(`${hist.days}d last ${w}_avg ${last[`${w}_avg`]} != current ${current[w]}`);
      }
    }
  }
  return { ok: issues.length === 0, issues, overlapDays: fromHourly.filter(d => d.day !== lastDay).length };
}

export const TPMS_DEMO_CURRENT = TARGET;
