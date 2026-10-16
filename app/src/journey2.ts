// 旅程第二期 (api_level 11): cover image, share card, weather per drive, energy by speed band.
import { api, fmtMoney } from "./api";
import type { DriveMap } from "./map";

const esc = (s: unknown) => String(s ?? "—").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const n = (v: number | null | undefined, d = 1) => v == null ? "—" : v.toFixed(d);

export interface DWeather { drive_id: number; temp_c: number | null; precip_mm: number | null; source: string | null }
export interface Band { key: string; label: string; distance_km: number; energy_kwh: number; wh_km: number | null; duration_min: number; share: number }

// ---------------- cover ----------------
export async function loadCover(id: number): Promise<string | null> {
  try { return (await api<{ image: string | null }>(`/api/journeys/${id}/cover`)).image; } catch { return null; }
}
/** Current map view as a JPEG data URL (≤ maxW px wide). Needs preserveDrawingBuffer (set in DriveMap). */
export async function mapSnapshot(m: DriveMap | null, maxW = 1080, q = 0.82): Promise<string | null> {
  if (!m) return null;
  const map = m.map;
  if (!map.loaded() || !map.areTilesLoaded()) await new Promise<void>(r => { const t = setTimeout(r, 6000); map.once("idle", () => { clearTimeout(t); r(); }); });
  await new Promise<void>(r => { map.once("render", () => r()); map.triggerRepaint(); setTimeout(r, 500); });
  try {
    const src = map.getCanvas();
    const scale = Math.min(1, maxW / src.width);
    const c = document.createElement("canvas"); c.width = Math.round(src.width * scale); c.height = Math.round(src.height * scale);
    c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", q);
  } catch { return null; }
}
export const saveCover = (id: number, image: string) => api(`/api/journeys/${id}/cover`, "PUT", { image });
export const resetCover = (id: number) => api(`/api/journeys/${id}/cover`, "DELETE");

// ---------------- weather ----------------
export async function loadWeather(id: number) {
  return api<{ drives: DWeather[]; partial: boolean }>(`/api/journeys/${id}/weather`);
}
export const weatherChip = (w: DWeather | undefined) => !w || w.temp_c == null ? "" :
  `<span class="wx">${w.precip_mm && w.precip_mm >= 0.1 ? "🌧" : "🌤"} ${n(w.temp_c, 0)}°C${w.precip_mm && w.precip_mm >= 0.1 ? ` · ${n(w.precip_mm, 1)} mm` : ""}</span>`;

/** Table: each drive's temperature / rain next to its efficiency, with a bar for Wh/km. */
export function weatherTable(drives: { id: number; start_date: string; distance_km: number | null; efficiency_wh_km: number | null }[], ws: DWeather[]) {
  const byId = new Map(ws.map(w => [w.drive_id, w]));
  const rows = drives.filter(d => (d.distance_km ?? 0) >= 1);
  if (!rows.length) return `<div class="muted small-note">没有可分析的行程</div>`;
  const max = Math.max(...rows.map(d => d.efficiency_wh_km ?? 0), 1);
  const temps = rows.map(d => byId.get(d.id)?.temp_c).filter((t): t is number => t != null);
  // simple read-out: efficiency in the colder vs warmer half
  let insight = "";
  if (temps.length >= 4) {
    const med = [...temps].sort((a, b) => a - b)[Math.floor(temps.length / 2)];
    const avg = (f: (t: number) => boolean) => { const a = rows.filter(d => { const t = byId.get(d.id)?.temp_c; return t != null && f(t); });
      const km = a.reduce((s, d) => s + (d.distance_km ?? 0), 0); return km ? a.reduce((s, d) => s + (d.efficiency_wh_km ?? 0) * (d.distance_km ?? 0), 0) / km : null; };
    const lo = avg(t => t < med), hi = avg(t => t >= med);
    if (lo != null && hi != null) insight = `<div class="muted small-note">低于 ${n(med, 0)}°C 的行程平均 ${n(lo, 0)} Wh/km，其余 ${n(hi, 0)} Wh/km</div>`;
  }
  return `<div class="wx-table">${rows.map(d => { const w = byId.get(d.id); const e = d.efficiency_wh_km;
    const rain = w?.precip_mm != null && w.precip_mm >= 0.1;
    return `<div class="wx-row"><span class="wx-t">${new Date(d.start_date).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
      <span class="wx-w">${w?.temp_c != null ? `${rain ? "🌧" : "🌤"} ${n(w.temp_c, 0)}°C${rain ? ` ${n(w.precip_mm, 1)}mm` : ""}` : "—"}</span>
      <span class="wx-bar"><i style="width:${e != null && e > 0 ? Math.max(4, e / max * 100) : 0}%"></i></span><b>${n(e, 0)}</b></div>`; }).join("")}</div>${insight}
    <div class="muted small-note">天气：行程出发时刻、出发地附近（Open-Meteo）。单位 Wh/km</div>`;
}

// ---------------- speed bands ----------------
export async function loadBands(id: number) { return api<{ bands: Band[]; method: string }>(`/api/journeys/${id}/speed-bands`); }
const BAND_COLOR: Record<string, string> = { city: "#fc8d59", suburb: "#e0b400", highway: "#1a9850" };
export function bandsHTML(r: { bands: Band[]; method: string }) {
  const tot = r.bands.reduce((a, b) => a + b.distance_km, 0);
  if (tot < 0.5) return `<div class="muted small-note">没有足够的轨迹数据</div>`;
  const maxE = Math.max(...r.bands.map(b => b.wh_km ?? 0), 1);
  const share = `<div class="band-share">${r.bands.filter(b => b.share > 0).map(b => `<i style="width:${b.share}%;background:${BAND_COLOR[b.key]}" title="${b.label} ${b.share}%"></i>`).join("")}</div>`;
  return share + r.bands.map(b => `<div class="band-row">
      <span class="band-l"><i style="background:${BAND_COLOR[b.key]}"></i>${b.label}<small>${b.key === "city" ? "&lt;40" : b.key === "suburb" ? "40–80" : "&gt;80"} km/h</small></span>
      <span class="band-d">${n(b.distance_km, 0)} km<small>${n(b.share, 0)}% · ${n(b.energy_kwh, 1)} kWh</small></span>
      <span class="band-e"><span class="band-bar"><i style="width:${b.wh_km ? b.wh_km / maxE * 100 : 0}%;background:${BAND_COLOR[b.key]}"></i></span><b>${b.wh_km ?? "—"}</b><small>Wh/km</small></span>
    </div>`).join("") +
    `<div class="muted small-note">按相邻轨迹点的平均车速分档；${r.method === "power" ? "能耗按功率积分" : r.method === "mixed" ? "能耗按功率积分（缺失部分按里程估算）" : "没有功率数据，能耗按里程估算"}，并校准到每段行程的总耗电。</div>`;
}

// ---------------- share card ----------------
export interface CardData { title: string; dateText: string; days: number; distance_km: number; energy_kwh: number; wh_km: number | null;
  costs: { currency: string; amount: number }[]; drives: number; charges: number; from: string; to: string;
  image: string | null; route: [number, number][] }

function loadImg(src: string) { return new Promise<HTMLImageElement>((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; }); }

/** 1080×1350 PNG: map (cover / snapshot, or a drawn route), title, key numbers. */
export async function renderCard(d: CardData, dark: boolean): Promise<HTMLCanvasElement> {
  const W = 1080, H = 1350, MH = 760;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  const bg = dark ? "#151517" : "#ffffff", fg = dark ? "#f2f2f2" : "#1d1d1f", mu = dark ? "#9a9aa0" : "#86868b", red = "#e31937";
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  let drewImage = false;
  if (d.image) {
    try { const im = await loadImg(d.image); const s = Math.max(W / im.width, MH / im.height);
      g.save(); g.beginPath(); g.rect(0, 0, W, MH); g.clip();
      g.drawImage(im, (W - im.width * s) / 2, (MH - im.height * s) / 2, im.width * s, im.height * s); g.restore(); drewImage = true; } catch { /* fall back */ }
  }
  if (!drewImage) {
    g.fillStyle = dark ? "#202024" : "#eef1f5"; g.fillRect(0, 0, W, MH);
    const pts = d.route; if (pts.length > 1) {
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const k = Math.cos((y0 + y1) / 2 * Math.PI / 180);
      const sc = Math.min((W - 160) / Math.max((x1 - x0) * k, 1e-6), (MH - 160) / Math.max(y1 - y0, 1e-6));
      const px = (p: [number, number]) => [W / 2 + (p[0] - (x0 + x1) / 2) * k * sc, MH / 2 - (p[1] - (y0 + y1) / 2) * sc];
      g.lineJoin = g.lineCap = "round";
      for (const [w, col] of [[16, "#ffffffcc"], [8, red]] as [number, string][]) {
        g.strokeStyle = col; g.lineWidth = w; g.beginPath(); pts.forEach((p, i) => { const [x, y] = px(p); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
      }
      for (const [p, col] of [[pts[0], "#1a9850"], [pts[pts.length - 1], red]] as [[number, number], string][]) {
        const [x, y] = px(p); g.fillStyle = "#fff"; g.beginPath(); g.arc(x, y, 16, 0, 7); g.fill(); g.fillStyle = col; g.beginPath(); g.arc(x, y, 10, 0, 7); g.fill();
      }
    }
  }
  const grd = g.createLinearGradient(0, MH - 140, 0, MH); grd.addColorStop(0, bg + "00"); grd.addColorStop(1, bg); g.fillStyle = grd; g.fillRect(0, MH - 140, W, 140);
  const font = (sz: number, w = 400) => `${w} ${sz}px -apple-system, "PingFang SC", "Microsoft YaHei", "Yu Gothic UI", "Noto Sans CJK SC", sans-serif`;
  const fit = (t: string, max: number) => { let s = t; while (g.measureText(s).width > max && s.length > 1) s = s.slice(0, -2) + "…"; return s; };
  g.textBaseline = "alphabetic";
  g.fillStyle = fg; g.font = font(64, 700); g.fillText(fit(d.title, W - 120), 60, MH + 50);
  g.fillStyle = mu; g.font = font(32); g.fillText(fit(`${d.dateText} · ${d.days} 天 · ${d.drives} 段行程${d.charges ? ` · 充电 ${d.charges} 次` : ""}`, W - 120), 60, MH + 106);
  g.fillText(fit(`${d.from} → ${d.to}`, W - 120), 60, MH + 152);
  const cost = d.costs.length ? d.costs.map(m => fmtMoney(m.amount, m.currency)).join(" + ") : "—";
  const cells: [string, string, string][] = [["里程", n(d.distance_km, 0), "km"], ["耗电", n(d.energy_kwh, 1), "kWh"], ["能耗", n(d.wh_km, 0), "Wh/km"], ["充电费用", cost, ""]];
  const cw = (W - 120) / 4, top = MH + 210;
  cells.forEach(([k, v, u], i) => {
    const x = 60 + i * cw;
    g.fillStyle = mu; g.font = font(28); g.fillText(k, x, top + 30);
    g.fillStyle = fg; g.font = font(v.length > 7 ? 40 : 54, 700); g.fillText(fit(v, cw - 16), x, top + 96);
    if (u) { const vw = g.measureText(fit(v, cw - 16)).width; g.fillStyle = mu; g.font = font(26); g.fillText(u, x + Math.min(vw + 8, cw - 70), top + 96); }
  });
  g.fillStyle = red; g.fillRect(60, H - 110, 8, 44);
  g.fillStyle = fg; g.font = font(34, 700); g.fillText("DriveLens", 84, H - 76);
  g.fillStyle = mu; g.font = font(24); g.textAlign = "right"; g.fillText(drewImage && !d.image?.startsWith("data:image/png") ? "© OpenFreeMap © OpenStreetMap" : "", W - 60, H - 78); g.textAlign = "left";
  return c;
}

/** Preview modal: 保存图片 (download) / 复制 (clipboard) / 分享 (Web Share when it supports files). */
export function shareDialog(canvas: HTMLCanvasElement, fileName: string) {
  const dlg = document.createElement("div"); dlg.className = "modal";
  const url = canvas.toDataURL("image/png");
  const canShare = typeof navigator.canShare === "function";
  dlg.innerHTML = `<div class="sheet share-sheet"><h3>分享卡片</h3><img class="share-img" src="${url}" alt="分享卡片">
    <div id="shmsg" class="muted"></div>
    <div class="btns"><button id="sh-close" class="ghost">关闭</button><button id="sh-copy" class="ghost">复制图片</button>
      ${canShare ? `<button id="sh-share" class="ghost">分享…</button>` : ""}<button id="sh-save" class="primary small">保存图片</button></div></div>`;
  document.body.appendChild(dlg);
  const msg = (t: string) => { dlg.querySelector("#shmsg")!.textContent = t; };
  const blob = () => new Promise<Blob>((ok, no) => canvas.toBlob(b => b ? ok(b) : no(new Error("toBlob failed")), "image/png"));
  const close = () => dlg.remove();
  dlg.onclick = e => { if (e.target === dlg) close(); };
  (dlg.querySelector("#sh-close") as HTMLElement).onclick = close;
  (dlg.querySelector("#sh-save") as HTMLElement).onclick = async () => {
    const b = await blob(); const u = URL.createObjectURL(b);
    const a = document.createElement("a"); a.href = u; a.download = fileName; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 10000); msg(`已保存为 ${fileName}（下载文件夹）`);
  };
  (dlg.querySelector("#sh-copy") as HTMLElement).onclick = async () => {
    try { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob() })]); msg("已复制到剪贴板，可以直接粘贴到聊天软件"); }
    catch (e) { msg(`复制失败：${(e as Error).message}`); }
  };
  const sh = dlg.querySelector<HTMLElement>("#sh-share");
  if (sh) sh.onclick = async () => {
    try { const f = new File([await blob()], fileName, { type: "image/png" });
      if (!navigator.canShare({ files: [f] })) return msg("此设备不支持直接分享图片，请用「保存图片」或「复制图片」");
      await navigator.share({ files: [f], title: fileName }); }
    catch (e) { if ((e as Error).name !== "AbortError") msg(`分享失败：${(e as Error).message}`); }
  };
}
