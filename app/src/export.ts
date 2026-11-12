// SPDX-License-Identifier: AGPL-3.0-or-later
// Data export (issue #70), entirely in the browser from the user's own server data (also in demo mode):
// drives / charges CSV (all records of the current view via keyset paging), drive / journey GPX from /api/drives/{id}/path.
import { api, defaultCurrency, type Charge, type Drive, type PathPoint } from "./api";
import { ic } from "./icons";
import { t } from "./i18n";
import { lacks, featureText } from "./version";
import { toCsv, toGpx, gpxPointCount, num, stamp, journeyGpxName, localDateTime, type GpxPoint } from "./exportfmt";

/** Keyset page size for exports (the server's maximum). */
const PAGE = 500;
/** Safety cap: a CSV export stops with an error instead of exceeding this many rows. */
export const EXPORT_CAP = 50_000;

/** CSV exports need keyset paging (api_level ≥ 10); hidden on older servers so a file is never silently cut off. */
export const canExportCsv = () => !lacks("paging");

/** The download pattern of the share card: Blob → object URL → <a download>. */
export function downloadBlob(blob: Blob, fileName: string) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = u; a.download = fileName; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 10000);
}

/** Every record of `path` (which already carries its filters, e.g. `/api/drives?x=1&car_id=1&q=…`), newest first. */
async function fetchAll<T>(path: string, progress: (n: number) => void): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const r: { items: T[]; next_cursor: string | null } | T[] = await api<{ items: T[]; next_cursor: string | null } | T[]>(`${path}&limit=${PAGE}&paged=true${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`);
    // a server without paging ignores `paged` and answers one plain page: complete only if it is short
    if (Array.isArray(r)) { if (r.length >= PAGE) throw new Error(featureText("paging")); out.push(...r); return out; }
    out.push(...r.items);
    if (out.length > EXPORT_CAP) throw new Error(t("export.tooMany", { n: EXPORT_CAP.toLocaleString("en-US") }));
    progress(out.length);
    if (!r.next_cursor || !r.items.length) return out;
    cursor = r.next_cursor;
  }
}

/** CSV times: fixed "YYYY-MM-DD HH:mm:ss" in the device time zone (owner decision, AREC-124). */
const when = localDateTime;

export const DRIVE_COLS = ["id", "start_time", "end_time", "from", "to", "distance_km", "duration_min", "energy_kwh", "efficiency_wh_km",
  "start_battery_pct", "end_battery_pct", "max_speed_kmh", "avg_outside_temp_c", "journey_name"] as const;
export const CHARGE_COLS = ["id", "start_time", "end_time", "place", "energy_added_kwh", "duration_min", "start_battery_pct", "end_battery_pct",
  "cost", "currency", "cost_source"] as const;

export const driveRow = (d: Drive) => [d.id, when(d.start_date), when(d.end_date), d.start_alias ?? d.start_address, d.end_alias ?? d.end_address,
  num(d.distance_km, 2), d.duration_min, num(d.energy_kwh, 2), num(d.efficiency_wh_km, 0), d.start_battery_level, d.end_battery_level,
  d.speed_max, num(d.outside_temp_avg, 1), d.journey_name ?? null];
/** Currency as the app shows it: a cost without a currency (TeslaMate cost at an unknown place) is in the app's default currency. */
export const chargeRow = (c: Charge) => [c.id, when(c.start_date), when(c.end_date), c.alias ?? c.address, num(c.charge_energy_added, 2),
  c.duration_min, c.start_battery_level, c.end_battery_level, num(c.cost, 2), c.cost != null ? (c.currency || defaultCurrency()) : null, c.cost_source ?? null];

const pts = (p: PathPoint[]): GpxPoint[] => p.map(x => ({ date: x.date, lat: x.lat, lng: x.lng, elevation: x.elevation }));

// ---------------- UI glue: busy button + status line ----------------
type Status = { kind: "busy" | "ok" | "error" | "empty"; text: string } | null;
/** Renders into a status element (hidden when empty): progress line, ok / error box, or the empty-state style. */
export function setStatus(el: HTMLElement | null, s: Status) {
  if (!el) return;
  el.hidden = !s;
  el.innerHTML = !s ? "" : s.kind === "busy" ? `<div class="muted small-note" role="status">${s.text}</div>`
    : s.kind === "ok" ? `<div class="ok" role="status">${ic("check")}${s.text}</div>`
    : s.kind === "error" ? `<div class="error" role="alert">${ic("alert")}${s.text}</div>`
    : `<div class="empty" role="status">${ic("route")}<span>${s.text}</span></div>`;
}
const escT = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** A finished export: the file, or null for "nothing to export" with the message to show. */
type Result = { blob: Blob; name: string } | { empty: string };
/**
 * Runs one export behind `btn`: disables it (busy) while running, reports progress / errors / the saved file in `statusEl`.
 * A second tap while running does nothing.
 */
export async function runExport(btn: HTMLButtonElement, statusEl: HTMLElement | null, job: (progress: (text: string) => void) => Promise<Result>) {
  if (btn.disabled) return;
  btn.disabled = true; btn.classList.add("busy"); btn.setAttribute("aria-busy", "true");
  let hideAfter = 0;
  setStatus(statusEl, { kind: "busy", text: escT(t("export.busy")) });
  try {
    const r = await job(text => setStatus(statusEl, { kind: "busy", text: escT(text) }));
    if ("empty" in r) { setStatus(statusEl, { kind: "empty", text: escT(r.empty) }); hideAfter = 5000; }
    else { downloadBlob(r.blob, r.name); setStatus(statusEl, { kind: "ok", text: escT(t("share.saved", { f: r.name })) }); hideAfter = 6000; }
  } catch (e) {
    setStatus(statusEl, { kind: "error", text: escT(t("export.fail", { e: (e as Error).message })) });
  } finally {
    btn.disabled = false; btn.classList.remove("busy"); btn.removeAttribute("aria-busy");
  }
  if (hideAfter && statusEl) { const shown = statusEl.innerHTML; setTimeout(() => { if (statusEl.innerHTML === shown) setStatus(statusEl, null); }, hideAfter); }
}

const csvBlob = (s: string) => new Blob([s], { type: "text/csv;charset=utf-8" });
const gpxBlob = (s: string) => new Blob([s], { type: "application/gpx+xml" });

/** Drives CSV for `path` = the Drives list request (car + place search); every matching drive. */
export const drivesCsv = (path: string) => async (progress: (text: string) => void): Promise<Result> => {
  const rows = await fetchAll<Drive>(path, n => progress(t("export.loaded", { n })));
  if (!rows.length) return { empty: t("export.empty") };
  return { blob: csvBlob(toCsv(DRIVE_COLS, rows.map(driveRow))), name: `drivelens-drives-${stamp(new Date())}.csv` };
};
/** Charges CSV for `path` = the Charges list request (car); every session. */
export const chargesCsv = (path: string) => async (progress: (text: string) => void): Promise<Result> => {
  const rows = await fetchAll<Charge>(path, n => progress(t("export.loaded", { n })));
  if (!rows.length) return { empty: t("export.empty") };
  return { blob: csvBlob(toCsv(CHARGE_COLS, rows.map(chargeRow))), name: `drivelens-charges-${stamp(new Date())}.csv` };
};

/** Drive GPX from the already loaded full-resolution path of the drive detail page. */
export const driveGpx = (d: Drive, path: PathPoint[]) => async (): Promise<Result> => {
  const seg = [pts(path)];
  if (!gpxPointCount(seg)) return { empty: t("j.noTrack") };
  const name = `${d.start_alias ?? d.start_address ?? "?"} → ${d.end_alias ?? d.end_address ?? "?"}`;
  return { blob: gpxBlob(toGpx(name, seg)), name: `drivelens-drive-${d.id}.gpx` };
};

/** Journey GPX: one track named after the journey, one segment per drive in time order, from each drive's /path. */
export const journeyGpx = (j: { id: number; name: string; drives: Drive[]; summary: { start_date: string | null } }) =>
  async (progress: (text: string) => void): Promise<Result> => {
    const drives = [...j.drives].sort((a, b) => a.start_date.localeCompare(b.start_date) || a.id - b.id);
    const segs: GpxPoint[][] = [];
    for (const [i, d] of drives.entries()) {
      progress(t("export.tracks", { i: i + 1, n: drives.length }));
      segs.push(pts(await api<PathPoint[]>(`/api/drives/${d.id}/path`)));
    }
    if (!gpxPointCount(segs)) return { empty: t("j.noTrack") };
    return { blob: gpxBlob(toGpx(j.name, segs)), name: journeyGpxName(j.id, j.name, j.summary.start_date ?? drives[0]?.start_date) };
  };
