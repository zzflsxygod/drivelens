import maplibregl from "maplibre-gl";
import type { StyleSpecification, ExpressionSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { loadSettings, type LabelLang } from "./api";

const STYLE_URL = { light: "https://tiles.openfreemap.org/styles/liberty", dark: "https://tiles.openfreemap.org/styles/dark" };

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
  const expr = labelExpr(loadSettings().labelLang ?? "ja");
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

export interface Overlay { route?: [number, number][]; point?: [number, number] }

export class DriveMap {
  map: maplibregl.Map;
  private markers: maplibregl.Marker[] = [];
  private fellBack = false;
  private mq = matchMedia("(prefers-color-scheme: dark)");
  private onScheme = () => this.setTheme();

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
    note.textContent = "矢量地图加载失败，已切换为 OSM 标准地图";
    this.el.appendChild(note);
  }

  setTheme() {
    if (this.fellBack) return;
    this.map.setStyle(STYLE_URL[effectiveTheme()]);
  }

  private fit() {
    const r = this.overlay.route;
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
        paint: { "line-color": dark ? "#0b1d3a" : "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 6, 14, 11] } });
      map.addLayer({ id: "route-line", type: "line", source: "route", layout,
        paint: { "line-color": dark ? "#4da3ff" : "#1a73e8", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 3.5, 14, 7] } });
    }
    this.markers.forEach(m => m.remove());
    const pts: [[number, number], string, string][] = [];
    if (r && r.length) pts.push([r[0], "#2a9d3a", "起点"], [r[r.length - 1], "#e31937", "终点"]);
    if (this.overlay.point) pts.push([this.overlay.point, "#e31937", "充电地点"]);
    this.markers = pts.map(([p, color, title]) => {
      const e = document.createElement("div");
      e.className = "pin"; e.style.background = color; e.title = title;
      return new maplibregl.Marker({ element: e }).setLngLat(p).addTo(map);
    });
  }

  destroy() { this.mq.removeEventListener("change", this.onScheme); this.map.remove(); }
}
