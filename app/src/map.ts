// SPDX-License-Identifier: AGPL-3.0-or-later
import * as maplibregl from "maplibre-gl";
import type { StyleSpecification, ExpressionSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { loadSettings, saveSettings, defaultLabelLang, type LabelLang } from "./api";
import { t } from "./i18n";
import { ic } from "./icons";
import { cssVar } from "./palette";

// maplibre-gl 6 is ESM-only and cannot locate its worker inside a bundle; Vite builds it as a same-origin asset
// (so CSP worker-src 'self' is enough).
maplibregl.setWorkerUrl(workerUrl);

const STYLE_URL = { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };

/** Fallback when OpenFreeMap is unreachable: plain OSM raster tiles. */
const OSM_FALLBACK: StyleSpecification = {
  version: 8,
  sources: { osm: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' } },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

export function effectiveTheme(): "light" | "dark" {
  const t = loadSettings().theme ?? "auto";
  if (t === "light" || t === "dark") return t;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function labelExpr(lang: LabelLang): ExpressionSpecification {
  if (lang === "local") return ["coalesce", ["get", "name"], ["get", "name:latin"]] as ExpressionSpecification;
  if (lang === "en") return ["coalesce", ["get", "name:en"], ["get", "name:latin"], ["get", "name"]] as ExpressionSpecification;
  if (lang === "zh") return ["coalesce", ["get", "name:zh-Hans"], ["get", "name:zh"], ["get", "name:ja"], ["get", "name"]] as ExpressionSpecification;
  return ["coalesce", ["get", "name:ja"], ["get", "name"]] as ExpressionSpecification;
}

function applyLabels(map: maplibregl.Map) {
  const expr = labelExpr(loadSettings().labelLang ?? defaultLabelLang());
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.type !== "symbol") continue;
    const tf = map.getLayoutProperty(layer.id, "text-field");
    // Only place/road/POI name labels, not shields (ref) or house numbers
    if (!tf || !JSON.stringify(tf).includes("name")) continue;
    map.setLayoutProperty(layer.id, "text-field", expr);
    // CJK labels along lines get rendered vertically/rotated awkwardly: keep them horizontal-ish
    if (map.getLayoutProperty(layer.id, "symbol-placement") === "line") {
      map.setLayoutProperty(layer.id, "text-writing-mode", ["horizontal"]);
      map.setLayoutProperty(layer.id, "text-keep-upright", true);
      map.setLayoutProperty(layer.id, "text-max-angle", 30);
    }
  }
}

export interface Stop { p: [number, number]; kind: "stop" | "charge"; title: string }
/** Journey: one line per drive with per-point speeds (for speed colouring) and stop markers. */
export interface Overlay { route?: [number, number][]; point?: [number, number];
  lines?: { coords: [number, number][]; speeds: (number | null)[] }[]; stops?: Stop[]; speedColor?: boolean; noPins?: boolean }

/** Speed-color scale upper limit (km/h). App is km/h-only (no mph setting). */
export const SPEED_COLOR_MAX_MIN = 30;
export const SPEED_COLOR_MAX_MAX = 250;
export const SPEED_COLOR_MAX_DEFAULT = 120;

/** Round to integer and clamp into 30–250; non-finite → default 120. */
export function clampSpeedColorMax(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isFinite(n)) return SPEED_COLOR_MAX_DEFAULT;
  return Math.min(SPEED_COLOR_MAX_MAX, Math.max(SPEED_COLOR_MAX_MIN, Math.round(n)));
}

/** Current upper limit from settings; missing / non-finite → 120, otherwise clamped to 30–250. */
export function speedColorMax(): number {
  const v = loadSettings().speedColorMax;
  if (v == null || !Number.isFinite(v)) return SPEED_COLOR_MAX_DEFAULT;
  return clampSpeedColorMax(v);
}

/** slow red → fast green; stops scale proportionally with the upper limit (default 0/30/60/90/120). */
export function speedStops(maxKmH: number = speedColorMax()): [number, string][] {
  const colors = ["#e5383b", "#f48c3a", "#f2c94c", "#7bc96f", "#12a150"] as const;
  return [0, 0.25, 0.5, 0.75, 1].map((f, i) => [Math.round(maxKmH * f), colors[i]]);
}

const speedExpr = (maxKmH: number = speedColorMax()): ExpressionSpecification =>
  ["interpolate", ["linear"], ["coalesce", ["get", "speed"], 0], ...speedStops(maxKmH).flat()] as unknown as ExpressionSpecification;

/** Shared speed-colour / single-colour toggle + legend (journey and drive detail). */
export function speedColorToolsHtml(speedOn: boolean): string {
  const max = speedColorMax();
  const stops = speedStops(max);
  const grad = `linear-gradient(90deg, ${stops.map(([k, c]) => `${c} ${(k / max) * 100}%`).join(", ")})`;
  return `<div class="map-tools"><div class="seg" id="speed-color"><span data-v="speed" class="${speedOn ? "on" : ""}">${t("j.speedColor")}</span><span data-v="plain" class="${speedOn ? "" : "on"}">${t("j.plain")}</span></div>
      <div class="speed-legend" ${speedOn ? "" : "hidden"}><span>${t("j.slow")}</span><i style="background:${grad}"></i><span>${t("j.fast", { max })}</span></div></div>`;
}

/** Wire the shared toggle: updates settings, legend visibility, and the map. */
export function bindSpeedColorToggle(root: ParentNode, map: { setSpeedColor(on: boolean): void } | null, getMap?: () => { setSpeedColor(on: boolean): void } | null) {
  root.querySelectorAll<HTMLElement>("#speed-color span").forEach(sp => sp.onclick = () => {
    const on = sp.dataset.v === "speed";
    root.querySelectorAll("#speed-color span").forEach(x => x.classList.toggle("on", x === sp));
    const leg = root.querySelector<HTMLElement>(".speed-legend");
    if (leg) leg.hidden = !on;
    saveSettings({ ...loadSettings(), speedColor: on });
    (getMap ? getMap() : map)?.setSpeedColor(on);
  });
}

export class DriveMap {
  map: maplibregl.Map;
  private markers: maplibregl.Marker[] = [];
  private fellBack = false;
  private mq = matchMedia("(prefers-color-scheme: dark)");
  private onScheme = () => this.setTheme();
  private theme: "light" | "dark" = effectiveTheme();

  constructor(private el: HTMLElement, private overlay: Overlay) {
    const theme = effectiveTheme();
    this.map = new maplibregl.Map({
      container: el,
      style: STYLE_URL[theme],
      attributionControl: { compact: true },
      // Render CJK (kanji/kana) with system fonts: crisper, and avoids odd glyphs from the server font
      localIdeographFontFamily: "'Hiragino Sans', 'Yu Gothic UI', 'Meiryo', 'Noto Sans CJK JP', 'Microsoft YaHei', 'PingFang SC', sans-serif",
      center: overlay.point ?? [139.76, 35.68], zoom: overlay.point ? 15 : 10,
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    this.map.on("style.load", () => { if (!this.fellBack) applyLabels(this.map); this.drawOverlay(); });
    // Style failed (network/CSP): fall back once to OSM raster
    const timer = setTimeout(() => { if (!this.map.isStyleLoaded()) this.fallback("timeout"); }, 12000);
    this.map.on("error", (e: maplibregl.ErrorEvent) => { if (!this.map.isStyleLoaded() && !this.fellBack) this.fallback(String(e.error?.message ?? e)); });
    this.map.once("load", () => clearTimeout(timer));
    this.fit();
    this.mq.addEventListener("change", this.onScheme);
  }

  private fallback(reason: string) {
    console.warn("OpenFreeMap style failed, falling back to OSM raster:", reason);
    this.fellBack = true;
    this.map.setStyle(OSM_FALLBACK);
    const note = document.createElement("div");
    note.className = "map-note";
    note.textContent = t("map.fallback");
    this.el.appendChild(note);
  }

  setTheme() {
    const th = effectiveTheme();
    if (this.fellBack || th === this.theme) return;
    this.theme = th;
    this.map.setStyle(STYLE_URL[th]);
  }

  /** Journey route: speed gradient or plain colour. */
  setSpeedColor(on: boolean) {
    this.overlay.speedColor = on;
    if (this.map.getLayer("jroute-line")) this.map.setPaintProperty("jroute-line", "line-color", on ? speedExpr(speedColorMax()) : this.plainColor());
  }
  private plainColor() { return this.fellBack ? "#006a9e" : cssVar("--accent", "#006a9e"); }
  private casing(dark: boolean) { return dark ? "#07080a" : "#ffffff"; }

  private fit() {
    const all = this.overlay.lines?.flatMap(l => l.coords);
    const r = all && all.length > 1 ? all : this.overlay.route;
    if (r && r.length > 1) {
      const b = r.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(r[0], r[0]));
      this.map.fitBounds(b, { padding: 40, duration: 0, maxZoom: 16 });
    }
  }

  private drawOverlay() {
    const map = this.map, dark = !this.fellBack && effectiveTheme() === "dark";
    const r = this.overlay.route;
    if (r && r.length > 1 && !map.getSource("route")) {
      map.addSource("route", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: r } } });
      const layout = { "line-cap": "round", "line-join": "round" } as const;
      map.addLayer({ id: "route-casing", type: "line", source: "route", layout,
        paint: { "line-color": this.casing(dark), "line-width": ["interpolate", ["linear"], ["zoom"], 8, 6, 14, 11] } });
      map.addLayer({ id: "route-line", type: "line", source: "route", layout,
        paint: { "line-color": this.plainColor(), "line-width": ["interpolate", ["linear"], ["zoom"], 8, 3.5, 14, 7] } });
    }
    const lines = this.overlay.lines;
    if (lines && lines.length && !map.getSource("jroute")) {
      // Speed colour: runs of consecutive points in the same 5 km/h step become one feature (shared end points,
      // so runs join without gaps). tolerance 0: the default simplification dropped the many tiny 2-point
      // segments at low zoom, which made the route look dashed when zoomed out.
      type F = { type: "Feature"; properties: { speed: number }; geometry: { type: "LineString"; coordinates: [number, number][] } };
      const features: F[] = [];
      const q = (v: number | null | undefined) => Math.round((v ?? 0) / 5) * 5;
      for (const l of lines) {
        let cur: F | null = null;
        for (let i = 1; i < l.coords.length; i++) {
          const sp = q(l.speeds[i - 1] ?? l.speeds[i]);
          if (cur && cur.properties.speed === sp) cur.geometry.coordinates.push(l.coords[i]);
          else { cur = { type: "Feature", properties: { speed: sp }, geometry: { type: "LineString", coordinates: [l.coords[i - 1], l.coords[i]] } }; features.push(cur); }
        }
      }
      // continuous casing per drive underneath (no seams between coloured runs)
      const whole = { type: "FeatureCollection" as const, features: lines.filter(l => l.coords.length > 1).map(l => ({ type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: l.coords } })) };
      map.addSource("jroute-whole", { type: "geojson", data: whole, tolerance: 0 });
      map.addSource("jroute", { type: "geojson", data: { type: "FeatureCollection", features }, tolerance: 0 });
      const layout = { "line-cap": "round", "line-join": "round" } as const;
      const thin = !!this.overlay.noPins; // footprint: many overlapping routes → thinner lines
      map.addLayer({ id: "jroute-casing", type: "line", source: "jroute-whole", layout,
        paint: { "line-color": this.casing(dark), "line-width": thin ? ["interpolate", ["linear"], ["zoom"], 8, 3, 14, 6] : ["interpolate", ["linear"], ["zoom"], 8, 6, 14, 11] } });
      map.addLayer({ id: "jroute-line", type: "line", source: "jroute", layout,
        paint: { "line-color": this.overlay.speedColor ? speedExpr(speedColorMax()) : this.plainColor(), "line-width": thin ? ["interpolate", ["linear"], ["zoom"], 8, 1.5, 14, 3.5] : ["interpolate", ["linear"], ["zoom"], 8, 3.5, 14, 7] } });
    }
    this.markers.forEach(m => m.remove());
    const pts: [[number, number], string, string][] = [];
    const ends = lines && lines.length ? [lines[0].coords[0], lines[lines.length - 1].coords[lines[lines.length - 1].coords.length - 1]] : r && r.length ? [r[0], r[r.length - 1]] : null;
    if (ends && ends[0] && ends[1] && !this.overlay.noPins) pts.push([ends[0], "start", t("map.start")], [ends[1], "end", t("map.end")]);
    if (this.overlay.point) pts.push([this.overlay.point, "end", t("map.chargeSpot")]);
    this.markers = pts.map(([p, color, title]) => {
      const e = document.createElement("div");
      e.className = `pin ${color}`; e.title = title;
      return new maplibregl.Marker({ element: e }).setLngLat(p).addTo(map);
    });
    for (const st of this.overlay.stops ?? []) {
      const e = document.createElement("div");
      e.className = st.kind === "charge" ? "stop-pin charge" : "stop-pin"; e.innerHTML = st.kind === "charge" ? ic("bolt") : "";
      e.title = st.title;
      this.markers.push(new maplibregl.Marker({ element: e }).setLngLat(st.p).addTo(map));
    }
  }

  destroy() { this.mq.removeEventListener("change", this.onScheme); this.map.remove(); }
}
