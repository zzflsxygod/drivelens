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
const COLORS: Record<Wheel, string> = {
  fl: "var(--accent)", fr: "var(--ch-1)", rl: "var(--violet)", rr: "var(--amber)",
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
function minOf(b: TpmsBucket, w: Wheel): number | null {
  return b[`${w}_min` as keyof TpmsBucket] as number | null;
}

function chartSVG(h: TpmsHistory, thr: number | null) {
  const W = 392, H = 220, L = 36, R = 10, T = 14, B = 28;
  const iw = W - L - R, ih = H - T - B;
  const series = h.series;
  if (!series.length) return `<div class="muted" style="text-align:center;padding:24px 0">${t("tpmsHist.empty")}</div>`;

  const vals: number[] = [];
  for (const b of series) for (const w of WHEELS) {
    const a = avgOf(b, w); if (a != null) vals.push(a);
    const m = minOf(b, w); if (m != null) vals.push(m);
  }
  if (thr != null) vals.push(thr);
  if (!vals.length) return `<div class="muted" style="text-align:center;padding:24px 0">${t("tpmsHist.empty")}</div>`;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max(0.05, (hi - lo) * 0.15);
  lo = Math.max(1.5, lo - pad); hi = Math.min(4.0, hi + pad);
  if (hi - lo < 0.3) { lo = Math.max(1.5, lo - 0.15); hi = Math.min(4.0, hi + 0.15); }
  const y = (v: number) => T + ih * (1 - (v - lo) / (hi - lo));
  const x = (i: number) => L + (series.length <= 1 ? iw / 2 : iw * i / (series.length - 1));

  let g = "";
  // grid + y labels
  [0, 0.5, 1].forEach(f => {
    const v = lo + (hi - lo) * f;
    const yy = y(v);
    g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" class="cg"/>`;
    g += `<text class="ax" x="${L - 4}" y="${yy + 3}" text-anchor="end">${v.toFixed(1)}</text>`;
  });
  // threshold
  if (thr != null && thr >= lo && thr <= hi) {
    const yy = y(thr);
    g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="var(--warn)" stroke-dasharray="4 3" stroke-width="1.2"/>`;
    g += `<text class="ax" x="${W - R}" y="${yy - 3}" text-anchor="end" fill="var(--warn)">${thr.toFixed(1)}</text>`;
  }
  // lines + low markers
  for (const w of WHEELS) {
    const pts: string[] = [];
    series.forEach((b, i) => {
      const v = avgOf(b, w);
      if (v == null) return;
      pts.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    });
    if (pts.length >= 2) g += `<polyline fill="none" stroke="${COLORS[w]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${pts.join(" ")}"/>`;
    else if (pts.length === 1) g += `<circle cx="${pts[0].split(",")[0]}" cy="${pts[0].split(",")[1]}" r="2.5" fill="${COLORS[w]}"/>`;
    if (thr != null) {
      series.forEach((b, i) => {
        const m = minOf(b, w) ?? avgOf(b, w);
        if (m != null && m < thr) {
          g += `<circle cx="${x(i).toFixed(1)}" cy="${y(m).toFixed(1)}" r="3.2" fill="var(--warn)" stroke="var(--card)" stroke-width="1"/>`;
        }
      });
    }
  }
  // x labels: first / mid / last
  const labelAt = (i: number) => {
    const raw = series[i]?.t; if (!raw) return "";
    try {
      const d = new Date(raw.includes("T") || raw.includes("Z") ? raw : raw.replace(" ", "T") + "Z");
      if (h.bucket === "hour") return d.toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
      return d.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
    } catch { return raw.slice(5, 16); }
  };
  const idxs = series.length <= 2 ? series.map((_, i) => i) : [0, Math.floor((series.length - 1) / 2), series.length - 1];
  for (const i of idxs) {
    g += `<text class="ax" x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(labelAt(i))}</text>`;
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
    <div id="tpms-body"><div class="pane muted" style="text-align:center">${t("common.loading")}</div></div>`;
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
