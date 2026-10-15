import "./style.css";
import { DriveMap, effectiveTheme } from "./map";
import { api, setAlias, resetAlias, loadSettings, type Theme, type LabelLang, saveSettings, Car, Charge, ChargePoint, Drive, PathPoint } from "./api";

const view = document.getElementById("view")!;
const carSel = document.getElementById("car") as HTMLSelectElement;
let map: DriveMap | null = null;

function applyTheme() { document.documentElement.dataset.theme = effectiveTheme(); map?.setTheme(); }
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { document.documentElement.dataset.theme = effectiveTheme(); });
document.documentElement.dataset.theme = effectiveTheme();

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


function destroyMap() { map?.destroy(); map = null; }
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
    map = new DriveMap(document.getElementById("map")!, { route: pts.map(p => [p.lng, p.lat] as [number, number]) });
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
      map = new DriveMap(document.getElementById("map")!, { point: [c.longitude, c.latitude] });
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
    <div id="msg"></div>
    <h2>显示</h2>
    <label>地图主题<select id="theme">
      <option value="auto">跟随系统</option><option value="light">浅色</option><option value="dark">深色（夜间）</option>
    </select></label>
    <label>地图文字语言<select id="lang">
      <option value="ja">日本語</option><option value="zh">中文</option><option value="en">English</option><option value="local">本地（当地语言）</option>
    </select></label>
    <p class="muted">地图：OpenFreeMap（OpenStreetMap 数据）</p>`;
  const themeSel = document.getElementById("theme") as HTMLSelectElement;
  const langSel = document.getElementById("lang") as HTMLSelectElement;
  themeSel.value = s.theme ?? "auto"; langSel.value = s.labelLang ?? "ja";
  themeSel.onchange = () => { saveSettings({ ...loadSettings(), theme: themeSel.value as Theme }); applyTheme(); };
  langSel.onchange = () => saveSettings({ ...loadSettings(), labelLang: langSel.value as LabelLang });
  (document.getElementById("save") as HTMLElement).onclick = async () => {
    saveSettings({ ...loadSettings(), apiUrl: (document.getElementById("url") as HTMLInputElement).value.trim(),
                   token: (document.getElementById("token") as HTMLInputElement).value.trim() });
    const msg = document.getElementById("msg")!;
    try { const cars = await api<Car[]>("/api/cars"); msg.innerHTML = `<div class="ok">✅ 连接成功，找到 ${cars.length} 辆车</div>`; loadCars(); }
    catch (e) { msg.innerHTML = `<div class="error">${esc((e as Error).message)}</div>`; }
  };
}


// ---------------- Home (首页) ----------------
interface Summary {
  car: { id: number; name: string | null; model: string | null; marketing_name: string | null; trim_badging: string | null;
         exterior_color: string | null; wheel_type: string | null; vin: string | null; efficiency: number | null };
  state: { state: string | null; since: string | null } | null;
  position: { date: string | null; latitude: number | null; longitude: number | null; battery_level: number | null;
              usable_battery_level: number | null; rated_battery_range_km: number | null; ideal_battery_range_km: number | null;
              est_battery_range_km: number | null; odometer_km: number | null; outside_temp: number | null;
              inside_temp: number | null; speed: number | null } | null;
  location: { name: string | null; address_id: number | null; source: string } | null;
  software: { version: string | null; installed_at: string | null } | null;
  last_drive: Drive | null; last_charge: Charge | null;
  stats: { total_distance_km: number | null; drive_count: number | null; charge_count: number | null;
           total_energy_added_kwh: number | null; total_cost: number | null };
  this_month: { month: string | null; distance_km: number | null; drive_count: number | null; drive_energy_kwh: number | null;
                charge_count: number | null; charge_energy_added_kwh: number | null; charge_cost: number | null };
}

const STATE_LABEL: Record<string, [string, string]> = {
  online: ["在线", "st-online"], asleep: ["休眠", "st-asleep"], offline: ["离线", "st-offline"], driving: ["行驶中", "st-online"] };
const COLOR_LABEL: Record<string, string> = {
  PearlWhite: "珍珠白", SolidBlack: "纯黑", MidnightSilver: "午夜银", DeepBlue: "深海蓝", RedMulticoat: "中国红",
  Red: "红", StealthGrey: "冷光银", QuicksilverGrey: "快银", UltraRed: "烈焰红", Black: "黑", White: "白", Silver: "银", Blue: "蓝" };

function ago(iso: string | null) {
  if (!iso) return "";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  if (m < 60 * 24) return `${Math.floor(m / 60)} 小时前`;
  return `${Math.floor(m / 1440)} 天前`;
}

async function currentCarId(): Promise<number | null> {
  if (!carSel.options.length) await loadCars();
  return carSel.value ? Number(carSel.value) : null;
}

async function showHome() {
  loading();
  try {
    const id = await currentCarId();
    if (id == null) { view.innerHTML = `<div class="muted">没有找到车辆</div>`; return; }
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const s = await api<Summary>(`/api/cars/${id}/summary?tz=${encodeURIComponent(tz)}`);
    const p = s.position, c = s.car;
    const driving = s.state?.state === "online" && (p?.speed ?? 0) > 0;
    const [stLabel, stCls] = STATE_LABEL[driving ? "driving" : s.state?.state ?? ""] ?? ["未知", "st-offline"];
    const lvl = p?.battery_level ?? null;
    const lvlCls = lvl == null ? "" : lvl < 20 ? "low" : lvl < 50 ? "mid" : "";
    const model = [c.marketing_name || (c.model ? `Model ${c.model}` : null)].filter(Boolean).join(" ");
    const extras = [c.exterior_color ? (COLOR_LABEL[c.exterior_color] ?? c.exterior_color) : null, c.wheel_type].filter(Boolean).join(" · ");
    const m = s.this_month, st = s.stats;
    const d = s.last_drive, ch = s.last_charge;
    view.innerHTML = `
      <div class="pull-hint" id="pull">下拉刷新</div>
      <div class="hero">
        <div class="row"><div>
          <div class="car-name">${esc(c.name || `Car ${c.id}`)}</div>
          <div class="muted">${esc(model)}${extras ? ` · ${esc(extras)}` : ""}</div>
        </div><button class="icon-btn" id="refresh" title="刷新">⟳</button></div>
        <div class="badge ${stCls}">${stLabel}${s.state?.since ? ` · ${ago(s.state.since)}起` : ""}</div>
        <div class="gauge-row">
          <div class="pct">${lvl ?? "—"}<small>%</small></div>
          <div class="range"><b>${n(p?.rated_battery_range_km ?? null, 0)}</b> km<div class="muted">预估 ${n(p?.est_battery_range_km ?? null, 0)} km</div></div>
        </div>
        <div class="gauge"><div class="${lvlCls}" style="width:${lvl ?? 0}%"></div></div>
        <div class="kv">
          <div><small>总里程</small><b>${p?.odometer_km != null ? Math.round(p.odometer_km).toLocaleString() : "—"} km</b></div>
          <div><small>软件版本</small><b>${esc(s.software?.version?.split(" ")[0] ?? "—")}</b></div>
          <div><small>车外 / 车内</small><b>${n(p?.outside_temp ?? null)}° / ${n(p?.inside_temp ?? null)}°</b></div>
        </div>
      </div>
      ${p?.latitude != null ? `
      <div class="section-title">📍 ${esc(s.location?.name ?? "最后位置")} <span class="muted">${p.date ? ago(p.date) : ""}</span></div>
      <div id="map" class="small"></div>` : ""}
      <div class="section-title">本月 ${esc(m.month ?? "")}</div>
      <div class="grid">
        <div><small>行驶</small><b>${n(m.distance_km, 0)} km</b></div>
        <div><small>耗电</small><b>${n(m.drive_energy_kwh, 1)} kWh</b></div>
        <div><small>充电</small><b>${n(m.charge_energy_added_kwh, 1)} kWh</b></div>
        <div><small>充电费用</small><b>${n(m.charge_cost, 0)}</b></div>
        <div><small>行程数</small><b>${m.drive_count ?? 0}</b></div>
        <div><small>充电次数</small><b>${m.charge_count ?? 0}</b></div>
      </div>
      ${d ? `<div class="section-title">最近行程</div>
      <div class="card" id="last-drive">
        <div class="row"><b>${esc(d.start_address)} → ${esc(d.end_address)}</b></div>
        <div class="row muted">${fmtDate(d.start_date)} · ${fmtDur(d.duration_min)}</div>
        <div class="stats"><span>📏 ${n(d.distance_km)} km</span><span>🔋 ${d.start_battery_level ?? "—"}% → ${d.end_battery_level ?? "—"}%</span><span>⚡ ${n(d.efficiency_wh_km, 0)} Wh/km</span></div>
      </div>` : ""}
      ${ch ? `<div class="section-title">最近充电</div>
      <div class="card" id="last-charge">
        <div class="row"><b>${esc(ch.address)}</b>${ch.cost != null ? `<span class="cost">${ch.cost.toFixed(0)}</span>` : ""}</div>
        <div class="row muted">${fmtDate(ch.start_date)} · ${fmtDur(ch.duration_min)}</div>
        <div class="stats"><span>⚡ +${n(ch.charge_energy_added, 2)} kWh</span><span>🔋 ${ch.start_battery_level ?? "—"}% → ${ch.end_battery_level ?? "—"}%</span></div>
      </div>` : ""}
      <div class="section-title">累计</div>
      <div class="grid">
        <div><small>总行驶</small><b>${n(st.total_distance_km, 0)} km</b></div>
        <div><small>行程 / 充电</small><b>${st.drive_count ?? 0} / ${st.charge_count ?? 0}</b></div>
        <div><small>总充电</small><b>${n(st.total_energy_added_kwh, 0)} kWh</b></div>
      </div>`;
    (document.getElementById("refresh") as HTMLElement).onclick = showHome;
    if (d) (document.getElementById("last-drive") as HTMLElement).onclick = () => showDrive(d.id);
    if (ch) (document.getElementById("last-charge") as HTMLElement).onclick = () => showCharge(ch.id);
    if (p?.latitude != null && p.longitude != null)
      map = new DriveMap(document.getElementById("map")!, { point: [p.longitude, p.latitude] });
  } catch (e) { showError(e); }
}

// Pull-to-refresh on the home tab (touch devices)
let pullStartY: number | null = null;
window.addEventListener("touchstart", e => {
  if (window.scrollY === 0 && document.querySelector("nav button.active")?.getAttribute("data-tab") === "home")
    pullStartY = e.touches[0].clientY;
}, { passive: true });
window.addEventListener("touchmove", e => {
  if (pullStartY == null) return;
  const dy = e.touches[0].clientY - pullStartY, hint = document.getElementById("pull");
  if (hint) { hint.style.height = `${Math.min(dy, 70)}px`; hint.textContent = dy > 60 ? "松开刷新" : "下拉刷新"; }
}, { passive: true });
window.addEventListener("touchend", e => {
  if (pullStartY == null) return;
  const dy = e.changedTouches[0].clientY - pullStartY; pullStartY = null;
  const hint = document.getElementById("pull"); if (hint) hint.style.height = "0";
  if (dy > 60) showHome();
});

const tabs: Record<string, () => void> = { home: showHome, drives: showDrives, charges: showCharges, settings: showSettings };
document.querySelectorAll<HTMLButtonElement>("nav button").forEach(b => b.onclick = () => {
  document.querySelectorAll("nav button").forEach(x => x.classList.remove("active"));
  b.classList.add("active"); tabs[b.dataset.tab!]();
});
carSel.onchange = () => (document.querySelector("nav button.active") as HTMLElement).click();

// Allow ?api=...&token=... for quick setup / testing
const qp = new URLSearchParams(location.search);
if (qp.get("api")) saveSettings({ ...loadSettings(), apiUrl: qp.get("api")!, token: qp.get("token") || "" });
const start = qp.get("view");
loadCars();
if (!loadSettings().apiUrl) (document.querySelector('nav button[data-tab="settings"]') as HTMLElement).click();
else if (start === "charges") (document.querySelector('nav button[data-tab="charges"]') as HTMLElement).click();
else if (start?.startsWith("drive:")) showDrive(Number(start.slice(6)));
else if (start?.startsWith("charge:")) showCharge(Number(start.slice(7)));
else if (start === "drives") (document.querySelector('nav button[data-tab="drives"]') as HTMLElement).click();
else showHome();
