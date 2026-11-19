// SPDX-License-Identifier: AGPL-3.0-or-later
// Journey summary card (issue #90): one portrait view per journey — route map, totals, stops — saved as a PNG on the device.
// App-only: built from the journey detail (`GET /api/journeys/{id}`) and its path (`/path`), which the detail page already loads.
import { fmtMoney, type Drive } from "./api";
import { ic } from "./icons";
import { DriveMap } from "./map";
import { cssVar } from "./palette";
import { navPage, settleScroll } from "./nav";
import { t, fmtDay, fmtTime, fmtDur } from "./i18n";
import * as J2 from "./journey2";
import type { Ctx, Journey, JPoint, Money } from "./journey";

export type JPath = { points: JPoint[]; total_points: number; downsampled: boolean };

/** Rows in the stop list; longer lists show the first MAX_STOPS - 2 places, "+N more" and the destination. */
export const MAX_STOPS = 8;

const esc = (s: unknown) => String(s ?? "—").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const n = (v: number | null | undefined, d = 1) => v == null ? "—" : v.toFixed(d);
const costTxt = (l: Money[]) => l.length ? l.map(m => fmtMoney(m.amount, m.currency)).join(" + ") : "—";

/** Places in visiting order: each drive's start and end (alias when set), consecutive repeats merged, unknown places skipped. */
export function journeyStops(drives: Drive[]): string[] {
  const out: string[] = [];
  for (const d of drives) for (const p of [d.start_alias ?? d.start_address, d.end_alias ?? d.end_address]) {
    const s = p?.trim();
    if (s && out[out.length - 1] !== s) out.push(s);
  }
  return out;
}
/** Cap for the card: `more` is the number of places left out between `head` and `last`. */
export function capStops(all: string[], max = MAX_STOPS): { head: string[]; more: number; last: string | null } {
  if (all.length <= max) return { head: all, more: 0, last: null };
  const head = all.slice(0, max - 2);
  return { head, more: all.length - head.length - 1, last: all[all.length - 1] };
}

/** "<first start> – <last end>" in local time; the date is not repeated when both are on the same day. */
function dateRange(a: string | null, b: string | null) {
  if (!a || !b) return "—";
  const d0 = new Date(a), d1 = new Date(b);
  return fmtDay(d0) === fmtDay(d1) ? `${fmtDay(d0)} ${fmtTime(a)} – ${fmtTime(b)}` : `${fmtDay(d0)} ${fmtTime(a)} – ${fmtDay(d1)} ${fmtTime(b)}`;
}

interface CardModel { name: string; dates: string; cells: [string, string, string][]; stops: ReturnType<typeof capStops> }
function model(j: Journey): CardModel {
  const s = j.summary;
  return { name: j.name, dates: dateRange(s.start_date, s.end_date), stops: capStops(journeyStops(j.drives)),
    // charge_count counts every session of the journey; costs sums the sessions with a known cost, per currency
    cells: [[t("jc.distance"), n(s.distance_km), "km"], [t("jc.driving"), fmtDur(s.driving_min), ""], [t("jc.energy"), n(s.energy_used_kwh), "kWh"],
      [t("jc.eff"), n(s.efficiency_wh_km, 0), "Wh/km"], [t("jc.charges"), String(s.charge_count), ""], [t("jc.cost"), costTxt(s.costs), ""]] };
}

const lines = (j: Journey, path: JPath) => {
  const byDrive = new Map<number, [number, number][]>();
  for (const p of path.points) { const a = byDrive.get(p.drive_id) ?? []; a.push([p.lng, p.lat]); byDrive.set(p.drive_id, a); }
  return j.drives.map(d => byDrive.get(d.id) ?? []).filter(a => a.length > 1);
};

/** Card view (back level `jcard:<id>`). `path` is the journey detail's own path request. */
export function showJourneyCard(ctx: Ctx, j: Journey, back: () => void, path: Promise<JPath>) {
  navPage(`jcard:${j.id}`, back);
  ctx.setMap(null);
  const v = ctx.view, m = model(j);
  const canShare = J2.canShareImage();
  const stopRow = (s: string, cls = "") => `<li class="${cls}"><span>${esc(s)}</span></li>`;
  v.innerHTML = `<div class="jtop"><button class="back">${t("common.back")}</button><div class="jtop-r">
      ${canShare ? `<button id="jc-share" class="icon-btn" type="button" title="${t("share.share")}" aria-label="${t("share.share")}">📤</button>` : ""}
      <button id="jc-save" class="primary small" type="button">${t("jc.save")}</button></div></div>
    <div id="jc-msg" class="muted" role="status"></div>
    <div class="jcard">
      <div class="jc-name">${ic("compass")}<b>${esc(m.name)}</b></div>
      <div class="jc-dates">${esc(m.dates)}</div>
      <div class="jc-map" id="jc-map"><div class="map-ph sk"></div></div>
      <div class="jc-cells">${m.cells.map(([k, val, u]) => `<div><small>${k}</small><b title="${esc(val)}">${esc(val)}${u ? `<i>${u}</i>` : ""}</b></div>`).join("")}</div>
      <div class="jc-sec">${t("jc.stops")}</div>
      ${m.stops.head.length ? `<ol class="jc-stops">${m.stops.head.map(s => stopRow(s)).join("")}${m.stops.more ? stopRow(t("jc.more", { n: m.stops.more }), "more") + stopRow(m.stops.last!) : ""}</ol>`
        : `<div class="muted">—</div>`}
      <div class="jc-foot"><span class="jc-mark"></span><b>DriveLens</b></div>
    </div>`;
  (v.querySelector(".back") as HTMLElement).onclick = back;
  settleScroll();
  const msg = (s: string) => { const el = v.querySelector("#jc-msg"); if (el) el.textContent = s; };

  let map: DriveMap | null = null;
  const ready = path.then(p => {
    const el = v.querySelector<HTMLElement>("#jc-map"); if (!el) return [];
    const ls = lines(j, p); el.innerHTML = "";
    // single colour: the card is a recap, the speed legend lives on the journey page
    if (ls.length) { map = new DriveMap(el, { lines: ls.map(coords => ({ coords, speeds: [] })), speedColor: false }); ctx.setMap(map); }
    else el.innerHTML = `<div class="muted jc-notrack">${t("j.noTrack")}</div>`;
    return ls;
  }).catch(e => { const el = v.querySelector<HTMLElement>("#jc-map"); if (el) el.innerHTML = `<div class="error jc-notrack">${ic("alert")} ${esc((e as Error).message)}</div>`; return []; });

  // The PNG is rendered once the map is idle and again after the map was moved, so a tap on Share still has the
  // user activation that the Web Share API needs (no multi-second wait between tap and share()).
  let png: Promise<Blob> | null = null;
  const render = () => png ??= ready.then(async ls => {
    const snap = await J2.mapSnapshot(map, 2160, 0.92);
    const m2 = map?.map;
    const pins = m2 && ls.length ? [ls[0][0], ls[ls.length - 1][ls[ls.length - 1].length - 1]].map(p => { const q = m2.project(p); return [q.x, q.y] as [number, number]; }) : null;
    const box = v.querySelector<HTMLElement>("#jc-map");
    return J2.canvasPng(await renderSummary(m, { snap, pins, view: box ? [box.clientWidth, box.clientHeight] : [4, 3], route: ls }));
  });
  ready.then(() => { const m2 = map?.map; if (!m2) return render();
    m2.once("idle", () => { render(); m2.on("moveend", () => { png = null; }); }); });
  const fileName = `DriveLens-${j.name.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40)}-summary.png`;
  const run = (btn: HTMLButtonElement, act: (b: Blob) => Promise<string>) => async () => {
    btn.disabled = true; msg(t("cv.generating"));
    try { msg(await act(await render())); }
    catch (e) { png = null; msg(t("share.fail", { e: (e as Error).message })); }
    finally { btn.disabled = false; }
  };
  const sv = v.querySelector<HTMLButtonElement>("#jc-save")!;
  sv.onclick = run(sv, b => J2.saveImage(b, fileName));
  const sh = v.querySelector<HTMLButtonElement>("#jc-share");
  if (sh) sh.onclick = run(sh, b => J2.shareImage(b, fileName));
}

// ---------------- PNG (canvas mirror of the card view) ----------------
function loadImg(src: string) { return new Promise<HTMLImageElement>((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; }); }

/** 1080 px wide portrait PNG with the card's layout at 3×: name, dates, map (snapshot with start/end pins, or the drawn
 *  route when no snapshot is available), six totals, stops, DriveLens mark. Colours and fonts come from the current theme. */
async function renderSummary(m: CardModel, o: { snap: string | null; pins: [number, number][] | null; view: [number, number]; route: [number, number][][] }) {
  const W = 1080, P = 54, IW = W - 2 * P, MAPY = 210, MAPH = Math.round(IW * 3 / 4);
  const CELLY = MAPY + MAPH + 36, CW = (IW - 2 * 24) / 3, CH = 150, STOPY = CELLY + 2 * CH + 24 + 84, ROW = 60;
  const rows = m.stops.head.length + (m.stops.more ? 2 : 0) || 1;
  const H = STOPY + rows * ROW + 150;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  const col = (k: string, f: string) => cssVar(k, f);
  const bg = col("--card", "#fff"), fg = col("--text", "#0b0e14"), mu = col("--muted", "#5a6272"), line = col("--line-2", "rgba(15,20,30,.16)");
  const sub = col("--sub", "#eceef2"), accent = col("--accent", "#006a9e"), green = col("--green", "#047857"), red = col("--red", "#c4122f");
  const sans = col("--font", "sans-serif"), mono = col("--mono", "monospace");
  const font = (sz: number, w = 400, fam = sans) => `${w} ${sz}px ${fam}`;
  const fit = (str: string, max: number) => { let s = str; while (g.measureText(s).width > max && s.length > 1) s = s.slice(0, -2) + "…"; return s; };
  const rrect = (x: number, y: number, w: number, h: number, r: number) => { g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); };   // roundRect: Safari 16+
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.textBaseline = "alphabetic";

  g.fillStyle = fg; g.font = font(60, 800); g.fillText(fit(m.name, IW), P, 120);
  g.fillStyle = mu; g.font = font(34, 400, mono); g.fillText(fit(m.dates, IW), P, 174);

  // map box (4:3, like .jc-map)
  g.save(); rrect(P, MAPY, IW, MAPH, 30); g.clip(); g.fillStyle = sub; g.fillRect(P, MAPY, IW, MAPH);
  let drew = false;
  // cover-fit transform from the on-screen map (CSS px) into the box
  const [vw, vh] = o.view, s = Math.max(IW / vw, MAPH / vh), ox = P + (IW - vw * s) / 2, oy = MAPY + (MAPH - vh * s) / 2;
  let pins = o.pins?.map(([x, y]) => [ox + x * s, oy + y * s] as [number, number]) ?? null;
  if (o.snap) { try { const im = await loadImg(o.snap); g.drawImage(im, ox, oy, vw * s, vh * s); drew = true; } catch { /* drawn route below */ } }
  if (!drew && o.route.length) {
    const all = o.route.flat(), xs = all.map(p => p[0]), ys = all.map(p => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const k = Math.cos((y0 + y1) / 2 * Math.PI / 180);
    const sc = Math.min((IW - 160) / Math.max((x1 - x0) * k, 1e-6), (MAPH - 160) / Math.max(y1 - y0, 1e-6));
    const px = (p: [number, number]) => [P + IW / 2 + (p[0] - (x0 + x1) / 2) * k * sc, MAPY + MAPH / 2 - (p[1] - (y0 + y1) / 2) * sc] as [number, number];
    g.lineJoin = g.lineCap = "round";
    for (const [w, cl] of [[18, bg], [9, accent]] as [number, string][]) {
      g.strokeStyle = cl; g.lineWidth = w;
      for (const l of o.route) { g.beginPath(); l.forEach((p, i) => { const [x, y] = px(p); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke(); }
    }
    const last = o.route[o.route.length - 1];
    pins = [px(o.route[0][0]), px(last[last.length - 1])];
  }
  if (!o.route.length) { g.fillStyle = mu; g.font = font(34); g.textAlign = "center"; g.fillText(t("j.noTrack"), W / 2, MAPY + MAPH / 2); g.textAlign = "left"; }
  // start / end pins like .pin.start / .pin.end (16 px dot, 3 px white ring) at 3×
  pins?.forEach(([x, y], i) => { g.fillStyle = "#fff"; g.beginPath(); g.arc(x, y, 24, 0, 7); g.fill(); g.fillStyle = i ? red : green; g.beginPath(); g.arc(x, y, 15, 0, 7); g.fill(); });
  g.restore();
  g.strokeStyle = line; g.lineWidth = 3; rrect(P + 1.5, MAPY + 1.5, IW - 3, MAPH - 3, 30); g.stroke();

  // totals: 3 × 2 cells
  m.cells.forEach(([k, val, u], i) => {
    const x = P + (i % 3) * (CW + 24), y = CELLY + Math.floor(i / 3) * (CH + 24);
    g.strokeStyle = line; g.lineWidth = 3; rrect(x + 1.5, y + 1.5, CW - 3, CH - 3, 24); g.stroke();
    g.fillStyle = mu; g.font = font(32); g.fillText(fit(k, CW - 54), x + 30, y + 54);
    g.font = font(30, 400, mono); const uw = u ? g.measureText(u).width + 10 : 0;
    g.fillStyle = fg; g.font = font(46, 700, mono); const vs = fit(val, CW - 60 - uw); g.fillText(vs, x + 30, y + 120);
    if (u) { const vw2 = g.measureText(vs).width; g.fillStyle = mu; g.font = font(30, 400, mono); g.fillText(u, x + 30 + vw2 + 10, y + 120); }
  });

  // stops: numbered rail
  g.fillStyle = mu; g.font = font(32, 700); g.fillText(t("jc.stops"), P, STOPY - 30);
  const list = m.stops.head.length ? [...m.stops.head.map(s => [s, false] as const), ...(m.stops.more ? [[t("jc.more", { n: m.stops.more }), true] as const, [m.stops.last!, false] as const] : [])]
    : [["—", true] as const];
  list.forEach(([s, isMore], i) => {
    const y = STOPY + i * ROW;
    if (i < list.length - 1) { g.strokeStyle = line; g.lineWidth = 3; g.beginPath(); g.moveTo(P + 12, y + 18); g.lineTo(P + 12, y + ROW + 6); g.stroke(); }
    const first = i === 0, lastRow = i === list.length - 1 && !isMore;
    g.fillStyle = first ? green : lastRow ? red : isMore ? mu : accent; g.beginPath(); g.arc(P + 12, y + 6, isMore ? 6 : 11, 0, 7); g.fill();
    g.fillStyle = isMore ? mu : fg; g.font = font(36, first || lastRow ? 700 : 400); g.fillText(fit(s, IW - 60), P + 52, y + 18);
  });

  // footer: brand mark + map attribution when tiles were drawn
  const fy = H - 60;
  g.save(); g.translate(P + 12, fy - 12); g.rotate(Math.PI / 4); g.fillStyle = accent; g.fillRect(-11, -11, 22, 22); g.restore();
  g.fillStyle = fg; g.font = font(34, 700); g.fillText("DriveLens", P + 44, fy);
  if (drew) { g.fillStyle = mu; g.font = font(24); g.textAlign = "right"; g.fillText("© OpenFreeMap © OpenStreetMap", W - P, fy); g.textAlign = "left"; }
  return c;
}
