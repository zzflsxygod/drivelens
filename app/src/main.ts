import "leaflet/dist/leaflet.css";
import "./style.css";
import L from "leaflet";
import { api, setAlias, resetAlias, loadSettings, saveSettings, Car, Charge, ChargePoint, Drive, PathPoint } from "./api";

const view = document.getElementById("view")!;
const carSel = document.getElementById("car") as HTMLSelectElement;
let map: L.Map | null = null;

const esc = (s: unknown) => String(s ?? "—").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const fmtDate = (iso: string) => new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const fmtDur = (m: number | null) => m == null ? "—" : m >= 60 ? `${Math.floor(m / 60)}小时${m % 60}分` : `${m}分钟`;
const n = (v: number | null, d = 1) => v == null ? "—" : v.toFixed(d);
const carQ = () => carSel.value ? `&car_id=${carSel.value}` : "";

/** Clickable place name; opens rename dialog when it has an address id. */
function place(name: string | null, addressId: number | null, alias: string | null) {
  if (addressId == null) return esc(name);
  return `<span class="place" data-addr="${addressId}" data-name="${esc(name)}" data-alias="${alias ? 1 : 0}">${esc(name)}<span class="pen">✎</span></span>`;
}

function renameDialog(addressId: number, current: string, hasAlias: boolean, onDone: () => void) {
  const dlg = document.createElement("div");
  dlg.className = "modal";
  dlg.innerHTML = `
    <div class="sheet">
      <h3>修改地点名称</h3>
      <input id="alias" maxlength="200" value="${esc(current)}">
      <p class="muted">名称按地点保存：所有在这个地点的行程和充电记录都会显示新名称。不会修改 TeslaMate 原始数据。</p>
      <div id="dlgmsg"></div>
      <div class="btns">
        ${hasAlias ? `<button id="reset" class="ghost">恢复默认名称</button>` : ""}
        <button id="cancel" class="ghost">取消</button>
        <button id="ok" class="primary small">保存</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);
  const input = dlg.querySelector("#alias") as HTMLInputElement;
  input.focus(); input.select();
  const close = () => dlg.remove();
  const run = async (fn: () => Promise<unknown>) => {
    try { await fn(); close(); onDone(); }
    catch (e) { dlg.querySelector("#dlgmsg")!.innerHTML = `<div class="error">${esc((e as Error).message)}</div>`; }
  };
  dlg.onclick = e => { if (e.target === dlg) close(); };
  (dlg.querySelector("#cancel") as HTMLElement).onclick = close;
  (dlg.querySelector("#ok") as HTMLElement).onclick = () => {
    const v = input.value.trim();
    if (!v) { dlg.querySelector("#dlgmsg")!.innerHTML = `<div class="error">名称不能为空</div>`; return; }
    run(() => setAlias(addressId, v));
  };
  input.onkeydown = e => { if (e.key === "Enter") (dlg.querySelector("#ok") as HTMLElement).click(); };
  const reset = dlg.querySelector("#reset") as HTMLElement | null;
  if (reset) reset.onclick = () => run(() => resetAlias(addressId));
}

function bindPlaces(refresh: () => void) {
  view.querySelectorAll<HTMLElement>(".place").forEach(el => el.onclick = () =>
    renameDialog(Number(el.dataset.addr), el.dataset.name || "", el.dataset.alias === "1", refresh));
}

function fixMapSize() { const m = map; setTimeout(() => m?.invalidateSize(), 100); }

function destroyMap() { map?.remove(); map = null; }
function showError(e: unknown) { view.innerHTML = `<div class="error">${esc((e as Error).message)}</div>`; }
function loading() { destroyMap(); view.innerHTML = `<div class="muted">加载中…</div>`; }

async function loadCars() {
  try {
    const cars = await api<Car[]>("/api/cars");
    carSel.innerHTML = cars.map(c => `<option value="${c.id}">${esc(c.name || c.marketing_name || `Car ${c.id}`)}</option>`).join("");
    carSel.hidden = cars.length < 2;
  } catch { carSel.hidden = true; }
}

async function showDrives() {
  loading();
  try {
    const drives = await api<Drive[]>(`/api/drives?limit=100${carQ()}`);
    if (!drives.length) { view.innerHTML = `<div class="muted">暂无行程</div>`; return; }
    view.innerHTML = drives.map(d => `
      <div class="card" data-id="${d.id}">
        <div class="row"><b>${esc(d.start_address)} → ${esc(d.end_address)}</b></div>
        <div class="row muted">${fmtDate(d.start_date)} · ${fmtDur(d.duration_min)}</div>
        <div class="stats">
          <span>📏 ${n(d.distance_km)} km</span>
          <span>🔋 ${d.start_battery_level ?? "—"}% → ${d.end_battery_level ?? "—"}%</span>
          <span>⚡ ${n(d.efficiency_wh_km, 0)} Wh/km</span>
        </div>
      </div>`).join("");
    view.querySelectorAll<HTMLElement>(".card").forEach(el =>
      el.onclick = () => showDrive(Number(el.dataset.id)));
  } catch (e) { showError(e); }
}

async function showDrive(id: number) {
  loading();
  try {
    const [d, pts] = await Promise.all([api<Drive>(`/api/drives/${id}`), api<PathPoint[]>(`/api/drives/${id}/path`)]);
    view.innerHTML = `
      <button class="back">← 返回</button>
      <h2>${place(d.start_address, d.start_address_id, d.start_alias)} → ${place(d.end_address, d.end_address_id, d.end_alias)}</h2>
      <div class="muted">${fmtDate(d.start_date)} – ${fmtDate(d.end_date)} · 点击地点名称可修改</div>
      <div id="map"></div>
      <div class="grid">
        <div><small>距离</small><b>${n(d.distance_km)} km</b></div>
        <div><small>时长</small><b>${fmtDur(d.duration_min)}</b></div>
        <div><small>能耗</small><b>${n(d.energy_kwh, 2)} kWh</b></div>
        <div><small>效率</small><b>${n(d.efficiency_wh_km, 0)} Wh/km</b></div>
        <div><small>最高速度</small><b>${d.speed_max ?? "—"} km/h</b></div>
        <div><small>电量</small><b>${d.start_battery_level ?? "—"}% → ${d.end_battery_level ?? "—"}%</b></div>
      </div>`;
    (view.querySelector(".back") as HTMLElement).onclick = showDrives;
    bindPlaces(() => showDrive(id));
    map = L.map("map");
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
    if (pts.length) {
      const ll = pts.map(p => [p.lat, p.lng] as L.LatLngTuple);
      const line = L.polyline(ll, { color: "#e31937", weight: 4 }).addTo(map);
      L.circleMarker(ll[0], { radius: 7, color: "#2a9d3a", fillOpacity: 1 }).addTo(map).bindTooltip("起点");
      L.circleMarker(ll[ll.length - 1], { radius: 7, color: "#e31937", fillOpacity: 1 }).addTo(map).bindTooltip("终点");
      map.fitBounds(line.getBounds(), { padding: [20, 20] });
    } else map.setView([35.68, 139.76], 10);
    fixMapSize();
  } catch (e) { showError(e); }
}

async function showCharges() {
  loading();
  try {
    const charges = await api<Charge[]>(`/api/charges?limit=100${carQ()}`);
    if (!charges.length) { view.innerHTML = `<div class="muted">暂无充电记录</div>`; return; }
    const total = charges.reduce((a, c) => a + (c.charge_energy_added ?? 0), 0);
    const cost = charges.reduce((a, c) => a + (c.cost ?? 0), 0);
    view.innerHTML = `<div class="summary">共 ${charges.length} 次 · ${total.toFixed(1)} kWh · 费用 ${cost.toFixed(0)}</div>` +
      charges.map(c => `
      <div class="card" data-id="${c.id}">
        <div class="row"><b>${esc(c.address)}</b>${c.cost != null ? `<span class="cost">${c.cost.toFixed(0)}</span>` : ""}</div>
        <div class="row muted">${fmtDate(c.start_date)} · ${fmtDur(c.duration_min)}</div>
        <div class="bar"><div style="left:${c.start_battery_level ?? 0}%;width:${(c.end_battery_level ?? 0) - (c.start_battery_level ?? 0)}%"></div></div>
        <div class="stats">
          <span>⚡ +${n(c.charge_energy_added, 2)} kWh</span>
          <span>🔋 ${c.start_battery_level ?? "—"}% → ${c.end_battery_level ?? "—"}%</span>
        </div>
      </div>`).join("");
    view.querySelectorAll<HTMLElement>(".card").forEach(el => el.onclick = () => showCharge(Number(el.dataset.id)));
  } catch (e) { showError(e); }
}

async function showCharge(id: number) {
  loading();
  try {
    const c = await api<Charge & { points: ChargePoint[] }>(`/api/charges/${id}`);
    const maxP = Math.max(1, ...c.points.map(p => p.charger_power ?? 0));
    view.innerHTML = `
      <button class="back">← 返回</button>
      <h2>${place(c.address, c.address_id, c.alias)}</h2>
      <div class="muted">${fmtDate(c.start_date)} – ${fmtDate(c.end_date)} · 点击地点名称可修改</div>
      <div class="grid">
        <div><small>充入电量</small><b>${n(c.charge_energy_added, 2)} kWh</b></div>
        <div><small>消耗电量</small><b>${n(c.charge_energy_used, 2)} kWh</b></div>
        <div><small>费用</small><b>${n(c.cost, 0)}</b></div>
        <div><small>时长</small><b>${fmtDur(c.duration_min)}</b></div>
        <div><small>电量</small><b>${c.start_battery_level}% → ${c.end_battery_level}%</b></div>
        <div><small>气温</small><b>${n(c.outside_temp_avg)} °C</b></div>
      </div>
      <h3>充电功率 (kW)</h3>
      <div class="chart">${c.points.map(p => `<div title="${fmtDate(p.date)} ${p.charger_power} kW / ${p.battery_level}%" style="height:${(p.charger_power ?? 0) / maxP * 100}%"></div>`).join("")}</div>
      ${c.latitude != null ? `<div id="map" class="small"></div>` : ""}`;
    (view.querySelector(".back") as HTMLElement).onclick = showCharges;
    bindPlaces(() => showCharge(id));
    if (c.latitude != null && c.longitude != null) {
      map = L.map("map").setView([c.latitude, c.longitude], 15);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
      L.circleMarker([c.latitude, c.longitude], { radius: 8, color: "#e31937", fillOpacity: 1 }).addTo(map);
      fixMapSize();
    }
  } catch (e) { showError(e); }
}

function showSettings() {
  destroyMap();
  const s = loadSettings();
  view.innerHTML = `
    <h2>设置</h2>
    <label>API 地址<input id="url" placeholder="https://drivelens.example.com" value="${esc(s.apiUrl || "")}"></label>
    <label>API Token<input id="token" type="password" value="${esc(s.token || "")}"></label>
    <button id="save" class="primary">保存并测试连接</button>
    <div id="msg"></div>`;
  (document.getElementById("save") as HTMLElement).onclick = async () => {
    saveSettings({ apiUrl: (document.getElementById("url") as HTMLInputElement).value.trim(),
                   token: (document.getElementById("token") as HTMLInputElement).value.trim() });
    const msg = document.getElementById("msg")!;
    try { const cars = await api<Car[]>("/api/cars"); msg.innerHTML = `<div class="ok">✅ 连接成功，找到 ${cars.length} 辆车</div>`; loadCars(); }
    catch (e) { msg.innerHTML = `<div class="error">${esc((e as Error).message)}</div>`; }
  };
}

const tabs: Record<string, () => void> = { drives: showDrives, charges: showCharges, settings: showSettings };
document.querySelectorAll<HTMLButtonElement>("nav button").forEach(b => b.onclick = () => {
  document.querySelectorAll("nav button").forEach(x => x.classList.remove("active"));
  b.classList.add("active"); tabs[b.dataset.tab!]();
});
carSel.onchange = () => (document.querySelector("nav button.active") as HTMLElement).click();

// Allow ?api=...&token=... for quick setup / testing
const qp = new URLSearchParams(location.search);
if (qp.get("api")) saveSettings({ apiUrl: qp.get("api")!, token: qp.get("token") || "" });
const start = qp.get("view");
loadCars();
if (!loadSettings().apiUrl) (document.querySelector('nav button[data-tab="settings"]') as HTMLElement).click();
else if (start === "charges") (document.querySelector('nav button[data-tab="charges"]') as HTMLElement).click();
else if (start?.startsWith("drive:")) showDrive(Number(start.slice(6)));
else if (start?.startsWith("charge:")) showCharge(Number(start.slice(7)));
else showDrives();
