import "./style.css";
import { DriveMap, effectiveTheme } from "./map";
import { showReport as renderReport, nowMonth } from "./report";
import { batteryCardHTML, showBattery, type Battery } from "./insights";
import { showDrivesTab, restoreDismissed, type Ctx as JourneyCtx } from "./journey";
import { infiniteList, monthLabel } from "./infinite";
import { initBackToTop, backToTop, isJumped } from "./totop";
import { checkServer, serverReady, onServerInfo, globalBanner, lacks, featureText, tooOldText, serverLabel, APP_VERSION } from "./version";
import { api, setAlias, resetAlias, setCost, resetCost, fmtMoney, defaultCurrency, CURRENCIES, loadSettings, type Theme, type LabelLang, saveSettings, Car, Charge, ChargePoint, Drive, PathPoint } from "./api";

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

function costBadge(c: Charge) {
  return c.cost != null ? `<span class="cost${c.cost_source === "manual" ? " manual" : ""}">${fmtMoney(c.cost, c.currency)}</span>` : "";
}

function costDialog(c: Charge, onDone: () => void) {
  const manual = c.cost_source === "manual";
  const cur0 = (manual ? c.currency : null) || c.default_currency || defaultCurrency();
  const opts = [...new Set([cur0, ...CURRENCIES])];
  const kwh = c.charge_energy_added;
  const dlg = document.createElement("div");
  dlg.className = "modal";
  dlg.innerHTML = `
    <div class="sheet">
      <h3>充电费用</h3>
      <div class="muted">${esc(c.address)} · ${fmtDate(c.start_date)} · ${kwh != null ? `${kwh.toFixed(2)} kWh` : ""}</div>
      <div class="cost-row">
        <input id="amount" type="number" inputmode="decimal" min="0" step="any" placeholder="金额" value="${manual && c.cost != null ? c.cost : ""}">
        <select id="cur">${opts.map(o => `<option${o === cur0 ? " selected" : ""}>${o}</option>`).join("")}</select>
      </div>
      <div id="unit" class="muted"></div>
      <input id="note" maxlength="500" placeholder="备注（可选）" value="${esc(manual ? c.cost_note ?? "" : "").replace(/^—$/, "")}">
      <p class="muted">${c.teslamate_cost != null ? `TeslaMate 记录的费用：${fmtMoney(c.teslamate_cost, c.default_currency)}。` : "TeslaMate 没有记录这次充电的费用。"}手动录入的费用优先显示，不会修改 TeslaMate 原始数据。</p>
      <div id="dlgmsg"></div>
      <div class="btns">
        ${manual ? `<button id="reset" class="ghost">删除手动费用</button>` : ""}
        <button id="cancel" class="ghost">取消</button>
        <button id="ok" class="primary small">保存</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);
  const amount = dlg.querySelector("#amount") as HTMLInputElement;
  const cur = dlg.querySelector("#cur") as HTMLSelectElement;
  const unit = () => {
    const v = parseFloat(amount.value);
    dlg.querySelector("#unit")!.textContent = v >= 0 && kwh ? `单价 ${fmtMoney(v / kwh, cur.value, true)}/kWh` : "";
  };
  amount.oninput = unit; cur.onchange = unit; unit();
  amount.focus();
  const close = () => dlg.remove();
  const msg = (t: string) => { dlg.querySelector("#dlgmsg")!.innerHTML = `<div class="error">${esc(t)}</div>`; };
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); close(); onDone(); } catch (e) { msg((e as Error).message); } };
  dlg.onclick = e => { if (e.target === dlg) close(); };
  (dlg.querySelector("#cancel") as HTMLElement).onclick = close;
  (dlg.querySelector("#ok") as HTMLElement).onclick = () => {
    const v = parseFloat(amount.value);
    if (!(v >= 0) || v >= 1e9) return msg("请输入有效金额");
    const note = (dlg.querySelector("#note") as HTMLInputElement).value.trim();
    run(() => setCost(c.id, v, cur.value, note || null));
  };
  amount.onkeydown = e => { if (e.key === "Enter") (dlg.querySelector("#ok") as HTMLElement).click(); };
  const reset = dlg.querySelector("#reset") as HTMLElement | null;
  if (reset) reset.onclick = () => run(() => resetCost(c.id));
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

function showDrives() { showDrivesTab(journeyCtx); }

async function showDrive(id: number, back: () => void = showDrives) {
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
    (view.querySelector(".back") as HTMLElement).onclick = back;
    bindPlaces(() => showDrive(id, back));
    map = new DriveMap(document.getElementById("map")!, { route: pts.map(p => [p.lng, p.lat] as [number, number]) });
  } catch (e) { showError(e); }
}

async function showCharges(restore = false) {
  destroyMap();
  const car = await currentCarId().catch(() => null);
  view.innerHTML = `<div id="clist"></div>`;
  const list = infiniteList<Charge>({
    container: document.getElementById("clist")!, key: `charges:${car ?? "all"}`, path: `/api/charges?x=1${carQ()}`,
    paging: !lacks("paging"), carId: car, monthsSupported: !lacks("paging"), restore,
    dateOf: c => c.start_date, empty: "暂无充电记录",
    header: (m, t, loaded) => {
      const byCur = new Map<string, number>();
      for (const c of loaded) if (c.cost != null) { const k = c.currency || defaultCurrency(); byCur.set(k, (byCur.get(k) ?? 0) + c.cost); }
      const cost = byCur.size ? " · " + [...byCur].map(([k, v]) => fmtMoney(v, k)).join(" + ") : "";
      return `<b>${monthLabel(m)}</b><span>${t ? `${t.charge_count} 次 · ${n(t.energy_added_kwh, 0)} kWh` : `${loaded.length} 次 · ${n(loaded.reduce((a, c) => a + (c.charge_energy_added ?? 0), 0), 0)} kWh`}${cost}</span>`;
    },
    card: c => `
      <div class="card" data-id="${c.id}">
        <div class="row"><b>${esc(c.address)}</b>${costBadge(c)}</div>
        <div class="row muted">${fmtDate(c.start_date)} · ${fmtDur(c.duration_min)}</div>
        <div class="bar"><div style="left:${c.start_battery_level ?? 0}%;width:${(c.end_battery_level ?? 0) - (c.start_battery_level ?? 0)}%"></div></div>
        <div class="stats">
          <span>⚡ +${n(c.charge_energy_added, 2)} kWh</span>
          <span>🔋 ${c.start_battery_level ?? "—"}% → ${c.end_battery_level ?? "—"}%</span>
        </div>
      </div>`,
    bind: root => root.querySelectorAll<HTMLElement>(".card[data-id]").forEach(el => el.onclick = () => {
      list.leave(); window.scrollTo(0, 0); showCharge(Number(el.dataset.id), () => showCharges(true));
    }),
  });
}

/** SVG chart: power (kW, filled area, left axis) + battery % (line, right axis). */
function chargeChart(points: ChargePoint[]): string {
  const pts = points
    .map(p => ({ t: Date.parse(p.date), kw: p.power_kw ?? (p.charger_power != null && p.charger_power > 0 ? p.charger_power : null), soc: p.battery_level, src: p.power_source }))
    .filter(p => !Number.isNaN(p.t));
  const hasPower = pts.some(p => (p.kw ?? 0) > 0), hasSoc = pts.some(p => p.soc != null);
  if (pts.length < 2 || (!hasPower && !hasSoc)) return `<div class="chart-empty">没有充电曲线数据</div>`;
  const W = 360, H = 150, L = 34, R = 30, T = 10, B = 22, iw = W - L - R, ih = H - T - B;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1, span = Math.max(1, t1 - t0);
  const maxKw = Math.max(5, ...pts.map(p => p.kw ?? 0));
  const niceMax = maxKw > 100 ? Math.ceil(maxKw / 50) * 50 : maxKw > 20 ? Math.ceil(maxKw / 10) * 10 : Math.ceil(maxKw / 2) * 2;
  const x = (t: number) => L + (t - t0) / span * iw;
  const yKw = (v: number) => T + ih - v / niceMax * ih;
  const ySoc = (v: number) => T + ih - v / 100 * ih;
  const kwPts = pts.filter(p => p.kw != null);
  const area = hasPower ? `M${x(kwPts[0].t).toFixed(1)},${yKw(0)} ` + kwPts.map(p => `L${x(p.t).toFixed(1)},${yKw(p.kw!).toFixed(1)}`).join(" ") + ` L${x(kwPts[kwPts.length - 1].t).toFixed(1)},${yKw(0)} Z` : "";
  const socPts = pts.filter(p => p.soc != null);
  const socLine = hasSoc ? socPts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${ySoc(p.soc!).toFixed(1)}`).join(" ") : "";
  const time = (t: number) => new Date(t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const grid = [0, 0.5, 1].map(f => `<line x1="${L}" x2="${W - R}" y1="${T + ih * (1 - f)}" y2="${T + ih * (1 - f)}" class="cg"/>
      <text x="${L - 4}" y="${T + ih * (1 - f) + 4}" text-anchor="end" class="ct">${Math.round(niceMax * f)}</text>
      <text x="${W - R + 4}" y="${T + ih * (1 - f) + 4}" class="ct soc">${Math.round(100 * f)}%</text>`).join("");
  const derived = pts.some(p => p.src === "energy_delta" || p.src === "voltage_current");
  const peak = hasPower ? Math.max(...kwPts.map(p => p.kw!)) : null;
  return `<div class="chart-box">
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="充电功率和电量曲线">
      ${grid}
      ${hasPower ? `<path d="${area}" class="ca"/>` : ""}
      ${hasSoc ? `<path d="${socLine}" class="cl"/>` : ""}
      <text x="${L}" y="${H - 6}" class="ct">${time(t0)}</text>
      <text x="${W - R}" y="${H - 6}" text-anchor="end" class="ct">${time(t1)}</text>
    </svg>
    <div class="legend"><span><i class="lg-kw"></i>功率 kW${peak != null ? `（峰值 ${peak.toFixed(0)}）` : ""}</span><span><i class="lg-soc"></i>电量 %</span></div>
    ${!hasPower ? `<div class="muted small-note">没有功率数据，仅显示电量变化</div>` : derived ? `<div class="muted small-note">车辆未上报充电功率，功率由电压×电流或充入电量变化推算</div>` : ""}
  </div>`;
}

async function showCharge(id: number, back: () => void = () => showCharges(true)) {
  loading();
  try {
    const c = await api<Charge & { points: ChargePoint[] }>(`/api/charges/${id}`);
    view.innerHTML = `
      <button class="back">← 返回</button>
      <h2>${place(c.address, c.address_id, c.alias)}</h2>
      <div class="muted">${fmtDate(c.start_date)} – ${fmtDate(c.end_date)} · 点击地点名称可修改</div>
      <div class="grid">
        <div><small>充入电量</small><b>${n(c.charge_energy_added, 2)} kWh</b></div>
        <div><small>消耗电量</small><b>${n(c.charge_energy_used, 2)} kWh</b></div>
        <div class="cost-cell" id="costcell" title="点击录入 / 修改费用"><small>费用${c.cost_source === "manual" ? " · 手动" : c.cost_source === "teslamate" ? " · TeslaMate" : ""}</small>
          <b>${fmtMoney(c.cost, c.currency)} <span class="pen">✎</span></b>
          ${c.cost != null && c.charge_energy_added ? `<span class="muted unit">单价 ${fmtMoney(c.cost / c.charge_energy_added, c.currency, true)}/kWh</span>` : ""}
          ${c.cost_note ? `<span class="muted unit">${esc(c.cost_note)}</span>` : ""}</div>
        <div><small>时长</small><b>${fmtDur(c.duration_min)}</b></div>
        <div><small>电量</small><b>${c.start_battery_level}% → ${c.end_battery_level}%</b></div>
        <div><small>气温</small><b>${n(c.outside_temp_avg)} °C</b></div>
      </div>
      <h3>充电曲线</h3>
      ${chargeChart(c.points)}
      ${c.latitude != null ? `<div id="map" class="small"></div>` : ""}`;
    (view.querySelector(".back") as HTMLElement).onclick = back;
    bindPlaces(() => showCharge(id, back));
    (document.getElementById("costcell") as HTMLElement).onclick = () => lacks("costs")
      ? showBanner(featureText("costs")) : costDialog(c, () => showCharge(id, back));
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
    <div class="version-box muted">App v${esc(APP_VERSION)} · 服务器 <span id="srv-ver">${esc(serverLabel())}</span> <button id="srv-check" class="ghost small">检查</button></div>
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
    <label>默认货币<select id="currency">${CURRENCIES.map(c => `<option>${c}</option>`).join("")}</select></label>
    <p class="muted">录入费用时默认按充电地点所在国家选择货币（如日本 → JPY）；无法判断地点时使用这里的默认货币。</p>
    <label>旅程建议：相邻行程间隔小于<select id="jgap">${[30, 60, 90, 120, 180, 240].map(m => `<option value="${m}">${m} 分钟</option>`).join("")}</select></label>
    <p class="muted">中途有充电时（如超充）间隔可到 2 小时。</p>
    <label class="chk-row"><input type="checkbox" id="sgon"> 显示旅程合并建议</label>
    <button id="sgrestore" class="ghost small">恢复已忽略的建议</button> <span id="sgmsg" class="muted"></span>
    <p class="muted">地图：OpenFreeMap（OpenStreetMap 数据）</p>`;
  (document.getElementById("srv-check") as HTMLElement).onclick = () => { document.getElementById("srv-ver")!.textContent = "检查中…"; checkServer(); };
  const themeSel = document.getElementById("theme") as HTMLSelectElement;
  const langSel = document.getElementById("lang") as HTMLSelectElement;
  themeSel.value = s.theme ?? "auto"; langSel.value = s.labelLang ?? "ja";
  themeSel.onchange = () => { saveSettings({ ...loadSettings(), theme: themeSel.value as Theme }); applyTheme(); };
  const gapSel = document.getElementById("jgap") as HTMLSelectElement;
  gapSel.value = String(s.journeyGap ?? 60);
  gapSel.onchange = () => saveSettings({ ...loadSettings(), journeyGap: Number(gapSel.value) });
  const sgOn = document.getElementById("sgon") as HTMLInputElement;
  sgOn.checked = !s.suggestionsOff;
  sgOn.onchange = () => saveSettings({ ...loadSettings(), suggestionsOff: !sgOn.checked });
  (document.getElementById("sgrestore") as HTMLElement).onclick = async () => {
    document.getElementById("sgmsg")!.textContent = "…";
    document.getElementById("sgmsg")!.textContent = await restoreDismissed(journeyCtx);
  };
  const curSel = document.getElementById("currency") as HTMLSelectElement;
  curSel.value = s.currency ?? "JPY";
  curSel.onchange = () => saveSettings({ ...loadSettings(), currency: curSel.value });
  langSel.onchange = () => saveSettings({ ...loadSettings(), labelLang: langSel.value as LabelLang });
  (document.getElementById("save") as HTMLElement).onclick = async () => {
    saveSettings({ ...loadSettings(), apiUrl: (document.getElementById("url") as HTMLInputElement).value.trim(),
                   token: (document.getElementById("token") as HTMLInputElement).value.trim() });
    const msg = document.getElementById("msg")!;
    checkServer();
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
           total_energy_added_kwh: number | null; total_cost: number | null; costs?: CurAmt[] };
  this_month: { month: string | null; distance_km: number | null; drive_count: number | null; drive_energy_kwh: number | null;
                charge_count: number | null; charge_energy_added_kwh: number | null; charge_cost: number | null; charge_costs?: CurAmt[] };
}

interface CurAmt { currency: string; amount: number; count: number }
/** Per-currency sums (each shown separately); falls back to the legacy single total. */
const costSum = (list: CurAmt[] | undefined, legacy: number | null) =>
  list ? (list.length ? list.map(x => fmtMoney(x.amount, x.currency)).join("<br>") : "—") : fmtMoney(legacy);

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

type Status = Pick<Summary, "car" | "state" | "position" | "software">;
type Activity = Pick<Summary, "location" | "last_drive" | "last_charge">;
type StatsData = Pick<Summary, "stats" | "this_month">;
interface HomeCache { status?: Status; activity?: Activity; stats?: StatsData; savedAt?: number }

const LAST_CAR_KEY = "drivelens-last-car";
const homeCacheKey = (id: number) => `drivelens-home-${id}`;
function readHomeCache(id: number): HomeCache {
  try { return JSON.parse(localStorage.getItem(homeCacheKey(id)) || "{}"); } catch { return {}; }
}
function writeHomeCache(id: number, patch: HomeCache) {
  try { localStorage.setItem(homeCacheKey(id), JSON.stringify({ ...readHomeCache(id), ...patch, savedAt: Date.now() })); } catch { /* quota */ }
}

/** Car to show without waiting for the network: selector value, else last used, else 1st from list. */
async function currentCarId(): Promise<number | null> {
  if (carSel.value) return Number(carSel.value);
  const last = Number(localStorage.getItem(LAST_CAR_KEY));
  if (last) { loadCars().then(() => { if ([...carSel.options].some(o => o.value === String(last))) carSel.value = String(last); }); return last; }
  await loadCars();
  return carSel.value ? Number(carSel.value) : null;
}

const sk = (w = "60%", h = "14px") => `<span class="sk" style="width:${w};height:${h}"></span>`;
const skCard = () => `<div class="card sk-card">${sk("70%", "16px")}<br>${sk("45%")}<br>${sk("85%")}</div>`;
const skGrid = (n: number) => `<div class="grid">${Array.from({ length: n }, () => `<div>${sk("50%", "10px")}<br>${sk("70%", "16px")}</div>`).join("")}</div>`;

function heroHTML(s: Status) {
  const p = s.position, c = s.car;
  const driving = s.state?.state === "online" && (p?.speed ?? 0) > 0;
  const [stLabel, stCls] = STATE_LABEL[driving ? "driving" : s.state?.state ?? ""] ?? ["未知", "st-offline"];
  const lvl = p?.battery_level ?? null;
  const lvlCls = lvl == null ? "" : lvl < 20 ? "low" : lvl < 50 ? "mid" : "";
  const model = c.marketing_name || (c.model ? `Model ${c.model}` : "");
  const extras = [c.exterior_color ? (COLOR_LABEL[c.exterior_color] ?? c.exterior_color) : null, c.wheel_type].filter(Boolean).join(" · ");
  return `
    <div class="row"><div>
      <div class="car-name">${esc(c.name || `Car ${c.id}`)}</div>
      <div class="muted">${esc(model)}${extras ? ` · ${esc(extras)}` : ""}</div>
    </div><button class="icon-btn" data-refresh title="刷新">⟳</button></div>
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
    </div>`;
}
const heroSkeleton = () => `
    <div class="row"><div style="flex:1">${sk("40%", "24px")}<br>${sk("55%")}</div><button class="icon-btn" data-refresh title="刷新">⟳</button></div>
    <div style="margin:10px 0">${sk("90px", "20px")}</div>
    <div class="gauge-row">${sk("110px", "46px")}${sk("90px", "30px")}</div>
    <div class="gauge"></div>
    <div class="kv">${[1, 2, 3].map(() => `<div>${sk("60%", "10px")}<br>${sk("80%")}</div>`).join("")}</div>`;

function monthHTML(d: StatsData) {
  const m = d.this_month;
  return `<div class="section-title">本月 ${esc(m.month ?? "")} <a class="link" data-report="${esc(m.month ?? "")}">查看月度报告 ›</a></div>
    <div class="grid month-card" data-report="${esc(m.month ?? "")}">
      <div><small>行驶</small><b>${n(m.distance_km, 0)} km</b></div>
      <div><small>耗电</small><b>${n(m.drive_energy_kwh, 1)} kWh</b></div>
      <div><small>充电</small><b>${n(m.charge_energy_added_kwh, 1)} kWh</b></div>
      <div><small>充电费用</small><b>${costSum(m.charge_costs, m.charge_cost)}</b></div>
      <div><small>行程数</small><b>${m.drive_count ?? 0}</b></div>
      <div><small>充电次数</small><b>${m.charge_count ?? 0}</b></div>
    </div>`;
}
function totalsHTML(d: StatsData) {
  const st = d.stats;
  return `<div class="section-title">累计</div>
    <div class="grid">
      <div><small>总行驶</small><b>${n(st.total_distance_km, 0)} km</b></div>
      <div><small>行程 / 充电</small><b>${st.drive_count ?? 0} / ${st.charge_count ?? 0}</b></div>
      <div><small>总充电</small><b>${n(st.total_energy_added_kwh, 0)} kWh</b></div>
      <div><small>总充电费用</small><b>${costSum(st.costs, st.total_cost)}</b></div>
    </div>`;
}
function lastDriveHTML(a: Activity) {
  const d = a.last_drive;
  if (!d) return `<div class="section-title">最近行程</div><div class="muted">暂无行程</div>`;
  return `<div class="section-title">最近行程</div>
    <div class="card" data-drive="${d.id}">
      <div class="row"><b>${esc(d.start_address)} → ${esc(d.end_address)}</b></div>
      <div class="row muted">${fmtDate(d.start_date)} · ${fmtDur(d.duration_min)}</div>
      <div class="stats"><span>📏 ${n(d.distance_km)} km</span><span>🔋 ${d.start_battery_level ?? "—"}% → ${d.end_battery_level ?? "—"}%</span><span>⚡ ${n(d.efficiency_wh_km, 0)} Wh/km</span></div>
    </div>`;
}
function lastChargeHTML(a: Activity) {
  const ch = a.last_charge;
  if (!ch) return `<div class="section-title">最近充电</div><div class="muted">暂无充电记录</div>`;
  return `<div class="section-title">最近充电</div>
    <div class="card" data-charge="${ch.id}">
      <div class="row"><b>${esc(ch.address)}</b>${costBadge(ch)}</div>
      <div class="row muted">${fmtDate(ch.start_date)} · ${fmtDur(ch.duration_min)}</div>
      <div class="stats"><span>⚡ +${n(ch.charge_energy_added, 2)} kWh</span><span>🔋 ${ch.start_battery_level ?? "—"}% → ${ch.end_battery_level ?? "—"}%</span></div>
    </div>`;
}

let homeGen = 0;

async function showHome() {
  destroyMap();
  const gen = ++homeGen;
  const alive = () => gen === homeGen && document.getElementById("home") != null;
  view.innerHTML = `
    <div id="home">
      <div class="pull-hint" id="pull">下拉刷新</div>
      <div id="stale" class="stale" hidden></div>
      <div class="hero" id="sec-hero">${heroSkeleton()}</div>
      <div id="sec-map"><div class="section-title">${sk("40%")}</div><div class="map-ph sk"></div></div>
      <div id="sec-month"><div class="section-title">${sk("30%")}</div>${skGrid(6)}</div>
      <div id="sec-battery"></div>
      <div id="sec-drive"><div class="section-title">${sk("25%")}</div>${skCard()}</div>
      <div id="sec-charge"><div class="section-title">${sk("25%")}</div>${skCard()}</div>
      <div id="sec-totals"><div class="section-title">${sk("20%")}</div>${skGrid(3)}</div>
    </div>`;
  view.querySelector("[data-refresh]")?.addEventListener("click", showHome);

  const id = await currentCarId().catch(() => null);
  if (!alive()) return;
  if (id == null) { view.innerHTML = `<div class="error">没有找到车辆（请检查设置）</div>`; return; }
  localStorage.setItem(LAST_CAR_KEY, String(id));

  const data: HomeCache = { ...readHomeCache(id) };
  const fresh = { status: false, activity: false, stats: false };
  const sec = (k: string) => document.getElementById(`sec-${k}`)!;

  const updateStale = () => {
    const el = document.getElementById("stale"); if (!el) return;
    const pending = Object.values(fresh).some(v => !v);
    el.hidden = !(pending && data.savedAt);
    el.textContent = `显示 ${ago(new Date(data.savedAt ?? 0).toISOString())} 的缓存数据 · 更新中…`;
  };

  const errorBox = (k: string, msg: string, retry: () => void) => {
    const el = sec(k), html = `<div class="error card-error">⚠️ ${esc(msg)} <button class="retry">重试</button></div>`;
    const old = el.querySelector(".card-error"); if (old) old.remove();
    el.insertAdjacentHTML(fresh[k as keyof typeof fresh] || !hasCache(k) ? "beforeend" : "afterbegin", html);
    if (!hasCache(k)) el.querySelectorAll(".sk, .sk-card, .grid, .map-ph, .section-title").forEach(e => e.remove());
    (el.querySelector(".retry") as HTMLElement).onclick = retry;
  };
  const hasCache = (k: string) => k === "hero" || k === "map" ? !!data.status : k === "drive" || k === "charge" ? !!data.activity : !!data.stats;

  const paintHero = () => {
    if (!data.status) return;
    sec("hero").innerHTML = heroHTML(data.status);
    sec("hero").querySelector("[data-refresh]")!.addEventListener("click", showHome);
  };
  let mapObserver: IntersectionObserver | null = null;
  const paintMap = () => {
    const p = data.status?.position;
    if (!data.status) return;
    if (p?.latitude == null || p.longitude == null) { sec("map").innerHTML = ""; return; }
    const title = `<div class="section-title">📍 ${esc(data.activity?.location?.name ?? "最后位置")} <span class="muted">${p.date ? ago(p.date) : ""}</span></div>`;
    const existing = document.getElementById("map");
    if (existing) { sec("map").querySelector(".section-title")!.outerHTML = title; return; }
    sec("map").innerHTML = `${title}<div id="map" class="small"><div class="map-ph sk"></div></div>`;
    // Lazy: only create the WebGL map once the card is (nearly) on screen
    mapObserver?.disconnect();
    mapObserver = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting) || !alive()) return;
      mapObserver?.disconnect();
      const el = document.getElementById("map"); if (!el) return;
      el.innerHTML = "";
      map = new DriveMap(el, { point: [p.longitude!, p.latitude!] });
    }, { rootMargin: "200px" });
    mapObserver.observe(document.getElementById("map")!);
  };
  const paintActivity = () => {
    if (!data.activity) return;
    sec("drive").innerHTML = lastDriveHTML(data.activity);
    sec("charge").innerHTML = lastChargeHTML(data.activity);
    sec("drive").querySelector<HTMLElement>("[data-drive]")?.addEventListener("click", e => showDrive(Number((e.currentTarget as HTMLElement).dataset.drive)));
    sec("charge").querySelector<HTMLElement>("[data-charge]")?.addEventListener("click", e => showCharge(Number((e.currentTarget as HTMLElement).dataset.charge)));
    if (data.status) paintMap();
  };
  const paintStats = () => {
    if (!data.stats) return;
    sec("month").innerHTML = monthHTML(data.stats);
    sec("month").querySelectorAll<HTMLElement>("[data-report]").forEach(el => el.onclick = () => openReport(el.dataset.report || nowMonth(), id));
    applyFeatureGates();
    sec("totals").innerHTML = totalsHTML(data.stats);
  };

  // 1) Instant: cached data
  paintHero(); paintMap(); paintActivity(); paintStats(); updateStale();

  // 2) Background: three independent requests
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const loadStatus = () => api<Status>(`/api/cars/${id}/status`).then(r => {
    if (!alive()) return; data.status = r; fresh.status = true; writeHomeCache(id, { status: r });
    paintHero(); paintMap(); updateStale();
  }).catch(e => { if (alive()) { fresh.status = true; updateStale(); errorBox("hero", `车辆状态加载失败：${(e as Error).message}`, loadStatus); } });
  const loadActivity = () => api<Activity>(`/api/cars/${id}/last-activity`).then(r => {
    if (!alive()) return; data.activity = r; fresh.activity = true; writeHomeCache(id, { activity: r });
    paintActivity(); updateStale();
  }).catch(e => { if (alive()) { fresh.activity = true; updateStale(); errorBox("drive", `最近行程/充电加载失败：${(e as Error).message}`, loadActivity); } });
  const loadStats = () => api<StatsData>(`/api/cars/${id}/stats?tz=${encodeURIComponent(tz)}&currency=${defaultCurrency()}`).then(r => {
    if (!alive()) return; data.stats = r; fresh.stats = true; writeHomeCache(id, { stats: r });
    paintStats(); updateStale();
  }).catch(e => { if (alive()) { fresh.stats = true; updateStale(); errorBox("month", `统计加载失败：${(e as Error).message}`, loadStats); } });
  loadStatus(); loadActivity(); loadStats();
  // 电池健康 card (api_level ≥ 12)
  serverReady().then(() => {
    if (lacks("insights") || !alive()) return;
    api<Battery>(`/api/cars/${id}/battery?summary=true`).then(b => {
      if (!alive()) return;
      sec("battery").innerHTML = batteryCardHTML(b);
      sec("battery").querySelectorAll<HTMLElement>("[data-battery]").forEach(el => el.onclick = () => openBattery(id));
    }).catch(() => { /* optional card */ });
  });
}

function openBattery(id: number) { destroyMap(); ++homeGen; showBattery(view, id, showHome); window.scrollTo(0, 0); }

/** Monthly report (opened from the 首页 month card; back returns to 首页). */
async function openReport(month: string, carId?: number) {
  destroyMap();
  await serverReady();
  if (lacks("report")) {
    view.innerHTML = `<button class="back">← 返回</button><div class="pane" style="margin-top:12px">
      <div class="error card-error">⚠️ ${esc(featureText("report"))} <button class="retry">重试</button></div>
      <div class="muted">月度报告需要更新服务器上的 drivelens-api。</div></div>`;
    (view.querySelector(".back") as HTMLElement).onclick = showHome;
    (view.querySelector(".retry") as HTMLElement).onclick = async () => { await checkServer(); openReport(month, carId); };
    return;
  }
  const id = carId ?? await currentCarId().catch(() => null);
  if (id == null) return showHome();
  ++homeGen;
  const self = (m: string) => openReport(m, id);
  const back = () => self(month);
  renderReport(view, id, month, { back: showHome, month: self,
    drive: d => showDrive(d, back), charge: c => showCharge(c, back),
    extras: lacks("insights") ? undefined : { setMap: m => { destroyMap(); map = m; } } });
  window.scrollTo(0, 0);
}

// ---------------- 旅程 ----------------
const journeyCtx: JourneyCtx = {
  view,
  setMap(m) { if (map && map !== m) destroyMap(); map = m; },
  showDrive: (id, back) => showDrive(id, back),
  showCharge: (id, back) => showCharge(id, back),
  carQ,
  carId: () => currentCarId().catch(() => null),
  journeysAvailable: () => !lacks("journeys"),
  journeysMessage: () => featureText("journeys"),
  dismissAvailable: () => !lacks("dismiss"),
  pagingAvailable: () => !lacks("paging"),
  journey2Available: () => !lacks("journey2"),
  journey2Message: () => featureText("journey2"),
};

// ---------------- Server version banner ----------------
const banner = document.getElementById("srv-banner")!;
let bannerOverride: string | null = null;
function renderBanner() {
  const text = bannerOverride ?? globalBanner();
  banner.hidden = !text;
  if (!text) return;
  banner.innerHTML = `<span>⚠️ ${esc(text)}</span><button class="retry">重试</button><button class="x" aria-label="关闭">×</button>`;
  (banner.querySelector(".retry") as HTMLElement).onclick = async () => {
    banner.querySelector(".retry")!.textContent = "检查中…"; bannerOverride = null;
    await checkServer();
    if (!globalBanner()) (document.querySelector("nav button.active") as HTMLElement | null)?.click();
  };
  (banner.querySelector(".x") as HTMLElement).onclick = () => { banner.hidden = true; bannerOverride = null; };
}
function showBanner(text: string) { bannerOverride = text; renderBanner(); }
/** Hide entry points the server is known not to support. */
function applyFeatureGates() {
  document.querySelectorAll<HTMLElement>("a[data-report]").forEach(a => a.hidden = lacks("report"));
  document.querySelectorAll<HTMLElement>(".month-card[data-report]").forEach(c => c.classList.toggle("month-card", !lacks("report")));
  const ver = document.getElementById("srv-ver"); if (ver) ver.textContent = serverLabel();
}
onServerInfo(() => {
  renderBanner(); applyFeatureGates();
  // a feature screen showing a 404 may now be explained
});
let lastCheck = 0;
window.addEventListener("drivelens-server-error", () => {
  if (Date.now() - lastCheck < 10000) return; lastCheck = Date.now();
  checkServer().then(i => { if (i.state === "legacy") showBanner(tooOldText(7)); });
});
window.addEventListener("focus", () => { if (Date.now() - lastCheck > 300000) { lastCheck = Date.now(); checkServer(); } });

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

const tabs: Record<string, () => void> = { home: showHome, drives: showDrives, charges: () => showCharges(), settings: showSettings };
initBackToTop();
document.querySelectorAll<HTMLButtonElement>("nav button").forEach(b => b.onclick = e => {
  // re-tapping the active tab (real tap, not a programmatic re-render) scrolls to top / back to newest
  if (e.isTrusted && b.classList.contains("active") && (window.scrollY > 0 || isJumped())) return backToTop();
  document.querySelectorAll("nav button").forEach(x => x.classList.remove("active"));
  b.classList.add("active"); tabs[b.dataset.tab!]();
});
carSel.onchange = () => { localStorage.setItem(LAST_CAR_KEY, carSel.value); (document.querySelector("nav button.active") as HTMLElement).click(); };

// Allow ?api=...&token=... for quick setup / testing
const qp = new URLSearchParams(location.search);
if (qp.get("api")) saveSettings({ ...loadSettings(), apiUrl: qp.get("api")!, token: qp.get("token") || "" });
const start = qp.get("view");
checkServer();
loadCars();
if (!loadSettings().apiUrl) (document.querySelector('nav button[data-tab="settings"]') as HTMLElement).click();
else if (start === "charges") (document.querySelector('nav button[data-tab="charges"]') as HTMLElement).click();
else if (start?.startsWith("drive:")) showDrive(Number(start.slice(6)));
else if (start?.startsWith("charge:")) showCharge(Number(start.slice(7)));
else if (start?.startsWith("report")) openReport(start.slice(7) || nowMonth());
else if (start === "battery") currentCarId().then(id => { if (id != null) openBattery(id); });
else if (start?.startsWith("journey:")) { serverReady().then(() => import("./journey").then(m => m.showJourney(journeyCtx, Number(start.slice(8))))); }
else if (start === "journeys") { (document.querySelector('nav button[data-tab="drives"]') as HTMLElement).classList.add("active"); serverReady().then(() => import("./journey").then(m => m.showJourneys(journeyCtx))); }
else if (start === "drives") (document.querySelector('nav button[data-tab="drives"]') as HTMLElement).click();
else showHome();
