// SPDX-License-Identifier: AGPL-3.0-or-later
// TPMS history page. Data: GET /api/cars/:id/tpms-history?days=7|30|90&tz=
import { api, loadSettings } from "./api";
import { ic } from "./icons";
import { featureText, lacks } from "./version";
import { t, fmtNum, ago } from "./i18n";

export type TpmsSnap = { date: string | null; fl: number | null; fr: number | null; rl: number | null; rr: number | null };
export type TpmsBucket = {
  t: string;
  fl_avg: number | null; fr_avg: number | null; rl_avg: number | null; rr_avg: number | null;
  fl_min: number | null; fr_min: number | null; rl_min: number | null; rr_min: number | null;
  outside_temp_avg: number | null; n: number;
};
export type TpmsHistory = {
  days: number; timezone: string; from: string; to: string;
  bucket: "hour" | "day"; unit: string;
  current: TpmsSnap | null; series: TpmsBucket[];
};

const WHEELS = ["fl", "fr", "rl", "rr"] as const;
type Wheel = typeof WHEELS[number];
/** Four distinct Telemetry colours; never --warn/--amber (reserved for low pressure). */
const COLORS: Record<Wheel, string> = {
  fl: "var(--accent)",   // cyan
  fr: "#f472b6",         // pink (clearly ≠ cyan; not warn-orange)
  rl: "var(--violet)",   // purple
  rr: "var(--green)",    // green
};
const esc = (s: unknown) => String(s ?? "—").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const n = (v: number, d = 1) => fmtNum(v, d);
const clampBar = (v: number) => Math.min(4, Math.max(1.5, Math.round(v * 10) / 10));
const warnOn = () => loadSettings().tpmsWarn !== false;
const warnBar = () => clampBar(loadSettings().tpmsWarnBar ?? 2.5);
const unit = () => t("set.tpmsUnit");

function avgOf(b: TpmsBucket, w: Wheel): number | null {
  return b[`${w}_avg` as keyof TpmsBucket] as number | null;
}

function parseBucketTime(raw: string): Date {
  if (raw.includes("T") || /Z$|[+-]\d{2}:\d{2}$/.test(raw)) return new Date(raw);
  return new Date(raw.replace(" ", "T") + "Z");
}

/** Nice 0.2-bar y ticks covering data + threshold. */
function yScale(vals: number[], thr: number | null) {
  const all = thr != null ? [...vals, thr] : vals;
  const rawLo = Math.min(...all), rawHi = Math.max(...all);
  let lo = Math.floor((rawLo - 0.05) * 5) / 5; // step 0.2
  let hi = Math.ceil((rawHi + 0.05) * 5) / 5;
  if (hi - lo < 0.6) { const mid = (lo + hi) / 2; lo = Math.max(1.5, mid - 0.3); hi = Math.min(4.0, mid + 0.3); }
  lo = Math.max(1.5, Math.round(lo * 10) / 10);
  hi = Math.min(4.0, Math.round(hi * 10) / 10);
  // snap to 0.2 grid
  lo = Math.floor(lo * 5) / 5;
  hi = Math.ceil(hi * 5) / 5;
  if (hi <= lo) hi = lo + 0.6;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + 1e-9; v = Math.round((v + 0.2) * 10) / 10) ticks.push(Math.round(v * 10) / 10);
  return { lo, hi, ticks };
}

/** Local calendar date key YYYY-M-D for tick dedupe. */
function localDayKey(d: Date) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function fmtDayTick(d: Date) {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** Pick ~4 clean local-midnight (or nearest bucket) indices for x labels. */
function dayTickIndices(series: TpmsBucket[], bucket: "hour" | "day"): number[] {
  if (!series.length) return [];
  if (series.length <= 4) return series.map((_, i) => i);
  const midnights: number[] = [];
  for (let i = 0; i < series.length; i++) {
    const d = parseBucketTime(series[i].t);
    if (bucket === "day") {
      midnights.push(i);
    } else if (d.getHours() === 0) {
      midnights.push(i);
    }
  }
  const pool = midnights.length >= 2 ? midnights : series.map((_, i) => i);
  // evenly pick up to 4, always include first & last from pool
  const n = Math.min(4, pool.length);
  if (n === 1) return [pool[0]];
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const idx = pool[Math.round(k * (pool.length - 1) / (n - 1))];
    if (!out.includes(idx)) out.push(idx);
  }
  return out;
}

/** Split a continuous series into coloured path segments (wheel colour vs warn below thr). */
function pathSegments(
  pts: { x: number; y: number; v: number }[],
  thr: number | null,
  wheelColor: string,
): { color: string; d: string }[] {
  if (pts.length === 0) return [];
  if (pts.length === 1 || thr == null) {
    const d = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    return [{ color: wheelColor, d }];
  }
  const segs: { color: string; d: string }[] = [];
  let curColor = pts[0].v < thr ? "var(--warn)" : wheelColor;
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const aLow = a.v < thr, bLow = b.v < thr;
    if (aLow === bLow) {
      const col = bLow ? "var(--warn)" : wheelColor;
      if (col !== curColor) {
        segs.push({ color: curColor, d });
        curColor = col;
        d = `M${a.x.toFixed(1)},${a.y.toFixed(1)}`;
      }
      d += ` L${b.x.toFixed(1)},${b.y.toFixed(1)}`;
    } else {
      // cross threshold: interpolate crossing point
      const t = (thr - a.v) / (b.v - a.v);
      const cx = a.x + (b.x - a.x) * t;
      const cy = a.y + (b.y - a.y) * t;
      d += ` L${cx.toFixed(1)},${cy.toFixed(1)}`;
      segs.push({ color: curColor, d });
      curColor = bLow ? "var(--warn)" : wheelColor;
      d = `M${cx.toFixed(1)},${cy.toFixed(1)} L${b.x.toFixed(1)},${b.y.toFixed(1)}`;
    }
  }
  segs.push({ color: curColor, d });
  return segs.filter(s => /\sL/.test(s.d) || s.d.includes(" L"));
}

function chartSVG(h: TpmsHistory, thr: number | null) {
  const W = 392, H = 228, L = 34, R = 12, T = 12, B = 30;
  const iw = W - L - R, ih = H - T - B;
  const series = h.series;
  if (!series.length) return `<div class="muted" style="text-align:center;padding:24px 0">${t("tpmsHist.empty")}</div>`;

  const vals: number[] = [];
  for (const b of series) for (const w of WHEELS) {
    const a = avgOf(b, w); if (a != null) vals.push(a);
  }
  if (thr != null) vals.push(thr);
  if (!vals.length) return `<div class="muted" style="text-align:center;padding:24px 0">${t("tpmsHist.empty")}</div>`;
  const { lo, hi, ticks } = yScale(vals, thr);
  const y = (v: number) => T + ih * (1 - (v - lo) / (hi - lo));
  const x = (i: number) => L + (series.length <= 1 ? iw / 2 : iw * i / (series.length - 1));

  let g = "";
  // faint band below threshold (low-pressure zone)
  if (thr != null && thr > lo && thr < hi) {
    const yThr = y(thr), yBot = y(lo);
    g += `<rect x="${L}" y="${yThr}" width="${iw}" height="${Math.max(0, yBot - yThr)}" fill="var(--warn)" opacity="0.08"/>`;
  }
  // grid + y labels
  for (const v of ticks) {
    const yy = y(v);
    g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" class="cg"/>`;
    g += `<text class="ax" x="${L - 4}" y="${yy + 3}" text-anchor="end">${v.toFixed(1)}</text>`;
  }
  // threshold dashed line + label
  if (thr != null && thr >= lo && thr <= hi) {
    const yy = y(thr);
    g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="var(--warn)" stroke-dasharray="4 3" stroke-width="1.2"/>`;
    g += `<text class="ax" x="${W - R}" y="${yy - 4}" text-anchor="end" fill="var(--warn)">${thr.toFixed(1)}</text>`;
  }
  // wheel lines (segments below thr drawn in warn colour)
  for (const w of WHEELS) {
    const pts: { x: number; y: number; v: number }[] = [];
    series.forEach((b, i) => {
      const v = avgOf(b, w);
      if (v == null) return;
      pts.push({ x: x(i), y: y(v), v });
    });
    for (const seg of pathSegments(pts, thr, COLORS[w])) {
      if (pts.length === 1) {
        g += `<circle cx="${pts[0].x.toFixed(1)}" cy="${pts[0].y.toFixed(1)}" r="2.5" fill="${COLORS[w]}"/>`;
      } else {
        g += `<path fill="none" stroke="${seg.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" d="${seg.d}"/>`;
      }
    }
  }
  // clean local-day x ticks
  const tickIdx = dayTickIndices(series, h.bucket);
  const seen = new Set<string>();
  for (const i of tickIdx) {
    const d = parseBucketTime(series[i].t);
    const key = localDayKey(d);
    if (seen.has(key)) continue;
    seen.add(key);
    g += `<text class="ax" x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(fmtDayTick(d))}</text>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${t("tpmsHist.chartAria")}">${g}</svg>`;
}

function currentTiles(cur: TpmsSnap | null, thr: number | null) {
  return `<div class="ov tpms-cur">
    ${WHEELS.map(w => {
      const v = cur?.[w] ?? null;
      const low = v != null && thr != null && v < thr;
      return `<div class="${low ? "is-low" : ""}"><small>${t(`tpms.${w}`)}</small><b>${v != null ? n(v, 1) : "—"}<i>${esc(unit())}</i></b></div>`;
    }).join("")}
  </div>`;
}

function legend(thr: number | null) {
  const wheels = WHEELS.map(w =>
    `<span class="tpms-leg"><i style="background:${COLORS[w]}"></i>${t(`tpms.${w}`)}</span>`).join("");
  const thrNote = thr != null ? `<span class="tpms-leg thr"><i></i>${t("tpmsHist.threshold", { v: n(thr, 1) })}</span>` : "";
  return `<div class="tpms-legend">${wheels}${thrNote}</div>`;
}

function rangeSwitcher(days: number) {
  return `<div class="seg" id="tpms-seg">${[7, 30, 90].map(d =>
    `<span data-d="${d}" class="${d === days ? "on" : ""}">${t("tpmsHist.days", { n: d })}</span>`).join("")}</div>`;
}

export async function showTpmsHistory(view: HTMLElement, carId: number, back: () => void, days = 30) {
  if (![7, 30, 90].includes(days)) days = 30;
  view.innerHTML = `<button class="back" data-title="${t("tpmsHist.pageTitle")}">${t("common.back")}</button>
    <div id="tpms-body" class="tpms-hist-page"><div class="pane muted" style="text-align:center">${t("common.loading")}</div></div>`;
  (view.querySelector(".back") as HTMLElement).onclick = back;
  const body = view.querySelector("#tpms-body")!;
  if (lacks("tpmsHistory")) {
    body.innerHTML = `<div class="error card-error">${ic("alert")} ${esc(featureText("tpmsHistory"))}</div>`;
    return;
  }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  let h: TpmsHistory;
  try {
    h = await api<TpmsHistory>(`/api/cars/${carId}/tpms-history?days=${days}&tz=${encodeURIComponent(tz)}`);
  } catch (e) {
    body.innerHTML = `<div class="error card-error">${ic("alert")} ${esc(t("tpmsHist.err", { e: (e as Error).message || "" }))}
      <button class="retry">${t("common.retry")}</button></div>`;
    (body.querySelector(".retry") as HTMLElement).onclick = () => showTpmsHistory(view, carId, back, days);
    return;
  }
  const thr = warnOn() ? warnBar() : null;
  const age = h.current?.date ? ago(h.current.date) : "";
  const lows = thr == null ? [] : WHEELS
    .map(w => ({ w, v: h.current?.[w] ?? null }))
    .filter((x): x is { w: Wheel; v: number } => x.v != null && x.v < thr);
  const lowNote = lows.length
    ? `<div class="warn tpms-warn" role="status">${ic("alert")} ${esc(t("tpms.warn"))}: ${esc(lows.map(x => t("tpms.wheel", { w: t(`tpms.${x.w}`), v: n(x.v, 1) })).join(" · "))}</div>`
    : "";
  body.innerHTML = `
    <div class="msw"><div class="msw-pill" style="justify-content:center">${rangeSwitcher(h.days)}</div></div>
    <div class="section-title">${t("tpmsHist.current")}${age ? `<span class="muted" style="font-weight:500;margin-left:8px">${esc(age)}</span>` : ""}</div>
    ${currentTiles(h.current, thr)}
    ${lowNote}
    <div class="section-title">${t("tpmsHist.chart")} <span class="muted" style="font-weight:500">${esc(unit())}</span></div>
    <div class="pane tpms-chart-pane">
      ${chartSVG(h, thr)}
      ${legend(thr)}
      <div class="muted small-note">${t("tpmsHist.bucketNote", { b: h.bucket === "hour" ? t("tpmsHist.hourly") : t("tpmsHist.daily") })}</div>
    </div>`;
  body.querySelectorAll<HTMLElement>("#tpms-seg [data-d]").forEach(el => {
    el.onclick = () => showTpmsHistory(view, carId, back, Number(el.dataset.d));
  });
}
