// SPDX-License-Identifier: AGPL-3.0-or-later
// Data export formats (issue #70): CSV (RFC 4180, UTF-8 with BOM), GPX 1.1, file names.
// Pure functions without DOM / i18n imports, so they can be checked with plain Node.

export type Cell = string | number | null | undefined;

/** Spreadsheet apps run text cells starting with = + - @ (or a tab / CR) as formulas: prefix those with '. */
const FORMULA = /^[=+\-@\t\r]/;
/** One RFC 4180 field: quoted when it holds a comma, quote, CR or LF; quotes doubled. */
export function csvCell(v: Cell): string {
  if (v == null) return "";
  let s = typeof v === "number" ? (isFinite(v) ? String(v) : "") : String(v);
  if (typeof v === "string" && FORMULA.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** Header + rows, CRLF line ends, UTF-8 BOM so spreadsheet apps detect the encoding. */
export function toCsv(header: readonly string[], rows: readonly Cell[][]): string {
  return "﻿" + [header, ...rows].map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
/** Rounded number for CSV (plain "." decimals, no grouping); null stays empty. */
export const num = (v: number | null | undefined, d: number): number | null =>
  v == null || !isFinite(v) ? null : Number(v.toFixed(d));

export interface GpxPoint { date: string | null; lat: number; lng: number; elevation: number | null }

const xml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
/** API timestamps are UTC ("…Z"); a naive value is UTC too → append Z. null for an unparsable value. */
export function utcIso(d: string | null | undefined): string | null {
  if (!d) return null;
  const t = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(d) ? d : d + "Z");
  return isNaN(t.getTime()) ? null : t.toISOString().replace(/\.000Z$/, "Z");
}
/** GPX 1.1: one track named `name`, one <trkseg> per segment; points without a valid time or position are left out. */
export function toGpx(name: string, segments: readonly GpxPoint[][]): string {
  const seg = (pts: readonly GpxPoint[]) => {
    const lines = pts.flatMap(p => {
      const time = utcIso(p.date);
      if (!time || !isFinite(p.lat) || !isFinite(p.lng)) return [];
      return [`      <trkpt lat="${p.lat}" lon="${p.lng}">${p.elevation != null && isFinite(p.elevation) ? `<ele>${p.elevation}</ele>` : ""}<time>${time}</time></trkpt>`];
    });
    return lines.length ? `    <trkseg>\n${lines.join("\n")}\n    </trkseg>\n` : "";
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="DriveLens" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata><name>${xml(name)}</name></metadata>
  <trk>
    <name>${xml(name)}</name>
${segments.map(seg).join("")}  </trk>
</gpx>
`;
}
/** Number of points toGpx keeps (valid time and position). */
export const gpxPointCount = (segments: readonly GpxPoint[][]) =>
  segments.reduce((a, s) => a + s.filter(p => utcIso(p.date) && isFinite(p.lat) && isFinite(p.lng)).length, 0);

const p2 = (v: number) => String(v).padStart(2, "0");
/** YYYYMMDD in local time. */
export const ymd = (d: Date) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
/** CSV time cell: "YYYY-MM-DD HH:mm:ss" in the device time zone (fixed format, independent of the UI language); null when unparsable. */
export function localDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
/** YYYYMMDD-HHmm in local time (export time stamp in CSV file names). */
export const stamp = (d: Date) => `${ymd(d)}-${p2(d.getHours())}${p2(d.getMinutes())}`;
/** File-name part: \ / : * ? " < > | and control characters and whitespace runs → "_", no leading/trailing "." or "_", ≤ max characters. */
export function safeName(s: string, max = 60): string {
  return [...s.replace(/[\\/:*?"<>|\u0000-\u001f\u007f\s]+/g, "_").replace(/^[._]+|[._]+$/g, "")].slice(0, max).join("").replace(/[._]+$/, "");
}
/** "<journey name>-YYYYMMDD.gpx" (local date of the journey start), else "drivelens-journey-<id>.gpx". */
export function journeyGpxName(id: number, name: string | null | undefined, start: string | null | undefined): string {
  const base = safeName(name ?? "");
  if (!base) return `drivelens-journey-${id}.gpx`;
  const d = start ? new Date(start) : null;
  return d && !isNaN(d.getTime()) ? `${base}-${ymd(d)}.gpx` : `${base}.gpx`;
}
