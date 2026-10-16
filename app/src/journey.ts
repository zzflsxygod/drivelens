// 行程 tab (drive list with multi-select) + 旅程 (journeys): list, suggestions, detail, editing.
import { api, fmtMoney, loadSettings, saveSettings, type Drive, type Charge } from "./api";
import { DriveMap, SPEED_STOPS } from "./map";
import { infiniteList, monthLabel } from "./infinite";
import * as J2 from "./journey2";
import { effectiveTheme } from "./map";

export interface Ctx {
  view: HTMLElement;
  setMap(m: DriveMap | null): void;
  showDrive(id: number, back: () => void): void;
  showCharge(id: number, back: () => void): void;
  carQ(): string;
  carId(): Promise<number | null>;
  journeysAvailable(): boolean;
  journeysMessage(): string;
  /** server can store dismissed suggestions (api_level ≥ 9) */
  dismissAvailable(): boolean;
  pagingAvailable(): boolean;
  /** cover / share card / weather / speed bands (api_level ≥ 11) */
  journey2Available(): boolean;
  journey2Message(): string;
}
interface Money { currency: string; amount: number }
export interface JourneyRow { id: number; car_id: number; name: string; note: string | null; start_date: string | null; end_date: string | null;
  start_address: string | null; end_address: string | null; drive_count: number; distance_km: number | null; duration_min: number | null; energy_kwh: number | null }
interface Stop { after_drive_id: number; before_drive_id: number; start_date: string; end_date: string; duration_min: number;
  address: string | null; lat: number | null; lng: number | null; charge_ids: number[]; charged_kwh: number }
interface Journey { id: number; car_id: number; name: string; note: string | null; has_cover?: boolean; drives: Drive[]; charges: Charge[]; stops: Stop[]; candidates: Drive[];
  summary: { start_date: string | null; end_date: string | null; start_address: string | null; end_address: string | null; distance_km: number;
    driving_min: number; stop_min: number; elapsed_min: number; energy_used_kwh: number; charged_kwh: number; charge_count: number;
    costs: Money[]; efficiency_wh_km: number | null; speed_max: number | null } }
interface Suggestion { drive_ids: number[]; name: string; start_date: string; end_date: string; start_address: string | null; end_address: string | null;
  distance_km: number; duration_min: number; charge_count: number }
interface JPoint { drive_id: number; lat: number; lng: number; speed: number | null; elevation: number | null; km: number }

const esc = (s: unknown) => String(s ?? "—").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const fmtDate = (iso: string | null) => iso ? new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
const fmtDur = (m: number | null) => m == null ? "—" : m >= 60 ? `${Math.floor(m / 60)}小时${m % 60}分` : `${Math.round(m)}分钟`;
const n = (v: number | null | undefined, d = 1) => v == null ? "—" : v.toFixed(d);
const costTxt = (l: Money[]) => l.length ? l.map(m => fmtMoney(m.amount, m.currency)).join(" + ") : "—";
const badge = (d: Drive) => d.journey_id ? `<span class="jbadge" title="${esc(d.journey_name)}">🧭 ${esc(d.journey_name)}</span>` : "";
const err = (e: unknown) => `<div class="error card-error">⚠️ ${esc((e as Error).message)} <button class="retry">重试</button></div>`;
const bindRetry = (root: HTMLElement, f: () => void) => root.querySelectorAll<HTMLElement>(".retry").forEach(b => b.onclick = f);

// ---------------- 行程 | 旅程 segment ----------------
function segHTML(active: "drives" | "journeys", ctx: Ctx) {
  if (!ctx.journeysAvailable()) return "";
  return `<div class="seg-tabs"><button data-seg="drives" class="${active === "drives" ? "on" : ""}">行程</button><button data-seg="journeys" class="${active === "journeys" ? "on" : ""}">旅程</button></div>`;
}
function bindSeg(ctx: Ctx) {
  ctx.view.querySelectorAll<HTMLElement>("[data-seg]").forEach(b => b.onclick = () =>
    b.dataset.seg === "journeys" ? showJourneys(ctx) : showDriveList(ctx, false));
}
let lastSeg: "drives" | "journeys" = "drives";
export function showDrivesTab(ctx: Ctx) { lastSeg === "journeys" && ctx.journeysAvailable() ? showJourneys(ctx) : showDriveList(ctx, false); }

// ---------------- Drive list (infinite, with multi-select) ----------------
const sel = new Set<number>();
let selectMode = false;
export async function showDriveList(ctx: Ctx, mode?: boolean, preselect: number[] = [], restore = false) {
  lastSeg = "drives"; ctx.setMap(null);
  if (mode !== undefined) { selectMode = mode; sel.clear(); preselect.forEach(i => sel.add(i)); }
  const v = ctx.view;
  const car = await ctx.carId();
  const canSelect = ctx.journeysAvailable();
  v.innerHTML = `${segHTML("drives", ctx)}
    ${canSelect ? `<div class="list-tools"><span class="muted" id="seltip"></span><button id="selmode" class="ghost small"></button></div>` : ""}
    <div id="dlist"></div><div id="abar"></div>`;
  bindSeg(ctx);
  const byId = new Map<number, Drive>();
  const cardHTML = (d: Drive) => { byId.set(d.id, d); const dis = selectMode && !!d.journey_id;
    return `<div class="card${selectMode ? " sel-mode" : ""}${sel.has(d.id) ? " selected" : ""}${dis ? " disabled" : ""}" data-id="${d.id}">
      ${selectMode ? `<div class="chk">${sel.has(d.id) ? "✓" : ""}</div>` : ""}<div class="cbody">
      <div class="row"><b>${esc(d.start_address)} → ${esc(d.end_address)}</b></div>
      <div class="row muted"><span>${fmtDate(d.start_date)} · ${fmtDur(d.duration_min)}</span>${badge(d)}</div>
      <div class="stats"><span>📏 ${n(d.distance_km)} km</span><span>🔋 ${d.start_battery_level ?? "—"}% → ${d.end_battery_level ?? "—"}%</span><span>⚡ ${n(d.efficiency_wh_km, 0)} Wh/km</span></div>
    </div></div>`; };
  const bar = () => {
    const tip = v.querySelector("#seltip"), btn = v.querySelector("#selmode");
    if (tip) tip.textContent = selectMode ? "选择要合并的行程（已属于旅程的不能选）" : "";
    if (btn) btn.textContent = selectMode ? "取消" : "选择";
    const picked = [...sel].map(i => byId.get(i)).filter(Boolean) as Drive[];
    v.querySelector("#abar")!.innerHTML = selectMode ? `<div style="height:70px"></div><div class="actionbar"><span>已选 <b>${sel.size}</b> 段${sel.size ? ` · ${n(picked.reduce((a, d) => a + (d.distance_km ?? 0), 0), 0)} km` : ""}</span>
      <button id="merge" class="primary small" ${sel.size < 1 ? "disabled" : ""}>合并为旅程</button></div>` : "";
    const mb = v.querySelector<HTMLElement>("#merge");
    if (mb) mb.onclick = () => {
      const ps = ([...sel].map(i => byId.get(i)).filter(Boolean) as Drive[]).sort((a, b) => a.start_date.localeCompare(b.start_date));
      const f = ps[0], l = ps[ps.length - 1];
      nameDialog({ title: "合并为旅程", name: f && l ? `${f.start_address ?? "?"} → ${l.end_address ?? "?"}` : "新旅程", note: "",
        hint: `${sel.size} 段行程${f && l ? ` · ${fmtDate(f.start_date)} – ${fmtDate(l.end_date)}` : ""}。只在 DriveLens 里分组，不修改 TeslaMate 的行程。`,
        ok: "创建旅程",
        save: async (name, note) => { const j = await api<Journey>("/api/journeys", "POST", { name, note, drive_ids: [...sel] }); selectMode = false; sel.clear(); showJourney(ctx, j.id); } });
    };
  };
  const list = infiniteList<Drive>({
    container: v.querySelector<HTMLElement>("#dlist")!, key: `drives:${car ?? "all"}`, path: `/api/drives?x=1${ctx.carQ()}`,
    paging: ctx.pagingAvailable(), carId: car, monthsSupported: ctx.pagingAvailable(), restore,
    dateOf: d => d.start_date, card: cardHTML, empty: "暂无行程",
    header: (m, t, loaded) => `<b>${monthLabel(m)}</b><span>${t ? `${t.drive_count} 段 · ${n(t.distance_km, 0)} km · ${fmtDur(t.duration_min)}`
      : `${loaded.length} 段 · ${n(loaded.reduce((a, d) => a + (d.distance_km ?? 0), 0), 0)} km`}</span>`,
    bind: root => root.querySelectorAll<HTMLElement>(".card[data-id]").forEach(el => el.onclick = () => {
      const id = Number(el.dataset.id), d = byId.get(id);
      if (!selectMode) { list.leave(); window.scrollTo(0, 0); return ctx.showDrive(id, () => showDriveList(ctx, undefined, [], true)); }
      if (d?.journey_id) return;
      sel.has(id) ? sel.delete(id) : sel.add(id);
      el.classList.toggle("selected", sel.has(id)); el.querySelector(".chk")!.textContent = sel.has(id) ? "✓" : "";
      bar();
    }),
  });
  const sm = v.querySelector<HTMLElement>("#selmode");
  if (sm) sm.onclick = () => {
    selectMode = !selectMode; if (!selectMode) sel.clear();
    // re-render loaded cards in place (keeps items and scroll)
    v.querySelectorAll<HTMLElement>("#dlist .card[data-id]").forEach(el => {
      const d = byId.get(Number(el.dataset.id)); if (!d) return;
      const t = document.createElement("div"); t.innerHTML = cardHTML(d); el.replaceWith(t.firstElementChild!);
    });
    list.rebind(); bar();
  };
  bar();
}

// ---------------- Name / note dialog ----------------
function nameDialog(o: { title: string; name: string; note: string; hint?: string; ok: string; save: (name: string, note: string | null) => Promise<void>; del?: () => Promise<void> }) {
  const dlg = document.createElement("div"); dlg.className = "modal";
  dlg.innerHTML = `<div class="sheet"><h3>${esc(o.title)}</h3>
    <input id="jname" maxlength="200" placeholder="旅程名称" value="${esc(o.name).replace(/^—$/, "")}">
    <textarea id="jnote" maxlength="2000" rows="3" placeholder="备注（可选）" style="width:100%;margin-top:8px">${esc(o.note).replace(/^—$/, "")}</textarea>
    ${o.hint ? `<p class="muted">${esc(o.hint)}</p>` : ""}<div id="dlgmsg"></div>
    <div class="btns">${o.del ? `<button id="del" class="ghost" style="color:var(--red)">删除旅程</button>` : ""}
      <button id="cancel" class="ghost">取消</button><button id="ok" class="primary small">${esc(o.ok)}</button></div></div>`;
  document.body.appendChild(dlg);
  const name = dlg.querySelector("#jname") as HTMLInputElement; name.focus(); name.select();
  const close = () => dlg.remove();
  const msg = (t: string) => { dlg.querySelector("#dlgmsg")!.innerHTML = `<div class="error">${esc(t)}</div>`; };
  dlg.onclick = e => { if (e.target === dlg) close(); };
  (dlg.querySelector("#cancel") as HTMLElement).onclick = close;
  (dlg.querySelector("#ok") as HTMLElement).onclick = async () => {
    const v = name.value.trim(); if (!v) return msg("名称不能为空");
    const note = (dlg.querySelector("#jnote") as HTMLTextAreaElement).value.trim();
    try { await o.save(v, note || null); close(); } catch (e) { msg((e as Error).message); }
  };
  const del = dlg.querySelector<HTMLElement>("#del");
  if (del && o.del) del.onclick = async () => {
    if (del.dataset.confirm !== "1") { del.dataset.confirm = "1"; del.textContent = "确认删除？（行程本身不受影响）"; return; }
    try { await o.del!(); close(); } catch (e) { msg((e as Error).message); }
  };
}

// ---------------- Journey list + suggestions ----------------
export async function showJourneys(ctx: Ctx) {
  lastSeg = "journeys"; ctx.setMap(null);
  const v = ctx.view;
  if (!ctx.journeysAvailable()) { v.innerHTML = `<div class="error card-error">⚠️ ${esc(ctx.journeysMessage())}</div>`; return; }
  v.innerHTML = `${segHTML("journeys", ctx)}<div id="j-sugg"></div><div id="j-list"><div class="muted">加载中…</div></div>`; bindSeg(ctx);
  const car = await ctx.carId();
  const gap = loadSettings().journeyGap ?? 60;
  const loadList = () => api<JourneyRow[]>(`/api/journeys?limit=200${ctx.carQ()}`).then(list => {
    const el = v.querySelector("#j-list"); if (!el) return;
    el.innerHTML = `<div class="section-title">我的旅程 <span class="muted">${list.length} 个</span></div>` + (list.length ? list.map(j => `
      <div class="card" data-j="${j.id}">
        <div class="row"><b>🧭 ${esc(j.name)}</b><span class="muted">${j.drive_count} 段</span></div>
        <div class="row muted">${fmtDate(j.start_date)} – ${fmtDate(j.end_date)}</div>
        <div class="stats"><span>📍 ${esc(j.start_address)} → ${esc(j.end_address)}</span></div>
        <div class="stats"><span>📏 ${n(j.distance_km, 0)} km</span><span>⏱ ${fmtDur(j.duration_min)}</span><span>🔋 ${n(j.energy_kwh, 1)} kWh</span></div>
      </div>`).join("") : `<div class="muted">还没有旅程。在「行程」里点「选择」，选几段行程合并；或者用上面的建议一键创建。</div>`);
    el.querySelectorAll<HTMLElement>("[data-j]").forEach(c => c.onclick = () => showJourney(ctx, Number(c.dataset.j)));
  }).catch(e => { const el = v.querySelector<HTMLElement>("#j-list"); if (el) { el.innerHTML = err(e); bindRetry(el, loadList); } });
  const loadSugg = () => {
    const el = v.querySelector<HTMLElement>("#j-sugg"); if (!el) return Promise.resolve();
    if (loadSettings().suggestionsOff) { el.innerHTML = ""; return Promise.resolve(); }
    return api<Suggestion[]>(`/api/journeys/suggestions?gap_min=${gap}${car != null ? `&car_id=${car}` : ""}`).then(all => {
      const el = v.querySelector<HTMLElement>("#j-sugg"); if (!el) return;
      const local = new Set(loadSettings().dismissedDrives ?? []);
      const sg = all.filter(s => !s.drive_ids.some(id => local.has(id))).slice(0, 5);
      if (!sg.length) { el.innerHTML = ""; return; }
      const collapsed = loadSettings().suggestionsCollapsed ?? false;
      if (collapsed) {
        el.innerHTML = `<div class="sugg-head collapsed" id="sg-toggle"><span>💡 ${sg.length} 条合并建议</span><span>›</span></div>`;
      } else {
        el.innerHTML = `<div class="section-title">建议合并 <span class="muted">间隔 &lt; ${gap} 分钟或中途充电 · <a class="link" id="sg-toggle">收起</a></span></div>` + sg.map((s, i) => `
        <div class="card sugg" data-s="${i}">
          <div class="row"><b>${esc(s.name)}</b><button class="ghost small sg-x" data-dismiss="${i}" title="不再建议这些行程">忽略</button></div>
          <div class="row muted">${fmtDate(s.start_date)} – ${fmtDate(s.end_date)}</div>
          <div class="row"><span class="stats" style="margin:0"><span>🚗 ${s.drive_ids.length} 段</span><span>📏 ${n(s.distance_km, 0)} km</span>${s.charge_count ? `<span>⚡ 充电 ${s.charge_count} 次</span>` : ""}</span>
            <button class="primary small" data-create="${i}">一键创建</button></div>
        </div>`).join("");
      }
      (el.querySelector("#sg-toggle") as HTMLElement).onclick = () => { saveSettings({ ...loadSettings(), suggestionsCollapsed: !collapsed }); loadSugg(); };
      el.querySelectorAll<HTMLElement>("[data-create]").forEach(b => b.onclick = async ev => {
        ev.stopPropagation(); b.textContent = "创建中…";
        const s = sg[Number(b.dataset.create)];
        try { const j = await api<Journey>("/api/journeys", "POST", { name: s.name, drive_ids: s.drive_ids }); showJourney(ctx, j.id); }
        catch (e) { b.textContent = "失败，重试"; alert((e as Error).message); }
      });
      el.querySelectorAll<HTMLElement>("[data-dismiss]").forEach(b => b.onclick = async ev => {
        ev.stopPropagation(); b.textContent = "…";
        await dismissSuggestion(ctx, sg[Number(b.dataset.dismiss)].drive_ids);
        const card = b.closest(".card") as HTMLElement | null; if (card) { card.style.transition = "opacity .2s"; card.style.opacity = "0"; }
        setTimeout(loadSugg, 200);
      });
      el.querySelectorAll<HTMLElement>("[data-s]").forEach(c => c.onclick = () => {
        const s = sg[Number(c.dataset.s)]; showDriveList(ctx, true, s.drive_ids);
      });
    }).catch(() => { const el = v.querySelector("#j-sugg"); if (el) el.innerHTML = ""; });
  };
  loadSugg(); loadList();
}

// ---------------- Journey detail ----------------
function elevationChart(pts: JPoint[], stopsKm: { km: number; charge: boolean }[]) {
  const e = pts.filter(p => p.elevation != null);
  if (e.length < 2) return `<div class="muted small-note">没有海拔数据</div>`;
  const W = 392, H = 150, L = 34, R = 8, T = 10, B = 22, iw = W - L - R, ih = H - T - B;
  const maxKm = Math.max(e[e.length - 1].km, 0.1);
  let lo = Math.min(...e.map(p => p.elevation!)), hi = Math.max(...e.map(p => p.elevation!));
  const pad = Math.max(10, (hi - lo) * 0.1); lo = Math.floor((lo - pad) / 10) * 10; hi = Math.ceil((hi + pad) / 10) * 10;
  const x = (km: number) => L + iw * km / maxKm, y = (m: number) => T + ih * (1 - (m - lo) / (hi - lo));
  const line = e.map((p, i) => `${i ? "L" : "M"}${x(p.km).toFixed(1)},${y(p.elevation!).toFixed(1)}`).join("");
  const area = `${line}L${x(e[e.length - 1].km).toFixed(1)},${T + ih}L${x(e[0].km).toFixed(1)},${T + ih}Z`;
  const peak = e.reduce((a, p) => p.elevation! > a.elevation! ? p : a);
  let g = "";
  [0, .5, 1].forEach(f => { const m = lo + (hi - lo) * f; g += `<line x1="${L}" x2="${W - R}" y1="${y(m)}" y2="${y(m)}" class="cg"/><text x="${L - 4}" y="${y(m) + 3}" text-anchor="end" class="ax">${Math.round(m)}</text>`; });
  [0, .25, .5, .75, 1].forEach(f => g += `<text x="${x(maxKm * f)}" y="${H - 6}" text-anchor="middle" class="ax">${Math.round(maxKm * f)}${f === 1 ? " km" : ""}</text>`);
  const sm = stopsKm.map(s => `<line x1="${x(s.km)}" x2="${x(s.km)}" y1="${T}" y2="${T + ih}" stroke="${s.charge ? "#e31937" : "#999"}" stroke-dasharray="3 3"/>${s.charge ? `<text x="${x(s.km)}" y="${T + 9}" text-anchor="middle" font-size="10">⚡</text>` : ""}`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="海拔剖面">${g}<path d="${area}" class="elev-a"/>${sm}
    <circle cx="${x(peak.km)}" cy="${y(peak.elevation!)}" r="3" fill="#1a73e8"/><text x="${Math.min(x(peak.km), W - 40)}" y="${y(peak.elevation!) - 6}" text-anchor="middle" class="ax">最高 ${peak.elevation} m</text></svg>`;
}

export async function showJourney(ctx: Ctx, id: number) {
  ctx.setMap(null);
  const v = ctx.view;
  v.innerHTML = `<button class="back">← 返回</button><div class="muted">加载中…</div>`;
  (v.querySelector(".back") as HTMLElement).onclick = () => showJourneys(ctx);
  let j: Journey;
  try { j = await api<Journey>(`/api/journeys/${id}`); }
  catch (e) { v.innerHTML = `<button class="back">← 返回</button>${err(e)}`; (v.querySelector(".back") as HTMLElement).onclick = () => showJourneys(ctx); bindRetry(v, () => showJourney(ctx, id)); return; }
  const s = j.summary, self = () => showJourney(ctx, id);
  const speedOn = loadSettings().speedColor ?? true;
  const p2 = ctx.journey2Available();
  // timeline: drives, stops (with charges inside) in time order
  const chargeById = new Map(j.charges.map(c => [c.id, c]));
  const used = new Set<number>();
  const tl: string[] = [];
  j.drives.forEach((d, i) => {
    tl.push(`<div class="tl drive"><div class="card" data-drive="${d.id}">
      <div class="row"><b>${esc(d.start_address)} → ${esc(d.end_address)}</b></div>
      <div class="row muted">${fmtTime(d.start_date)} – ${fmtTime(d.end_date)} · ${fmtDur(d.duration_min)}</div>
      <div class="stats"><span>📏 ${n(d.distance_km)} km</span><span>🔋 ${d.start_battery_level ?? "—"}% → ${d.end_battery_level ?? "—"}%</span><span>⚡ ${n(d.efficiency_wh_km, 0)} Wh/km</span><span data-wx="${d.id}"></span></div></div></div>`);
    const st = j.stops[i];
    if (st) {
      const chs = st.charge_ids.map(c => chargeById.get(c)).filter(Boolean) as Charge[];
      chs.forEach(c => used.add(c.id));
      tl.push(chs.length ? chs.map(c => `<div class="tl charge"><div class="card" data-charge="${c.id}">
          <div class="row"><b>⚡ ${esc(c.address)}</b>${c.cost != null ? `<span class="cost">${fmtMoney(c.cost, c.currency)}</span>` : ""}</div>
          <div class="row muted">${fmtTime(c.start_date)} – ${fmtTime(c.end_date)} · ${fmtDur(c.duration_min)} · 停留 ${fmtDur(st.duration_min)}</div>
          <div class="stats"><span>+${n(c.charge_energy_added, 1)} kWh</span><span>🔋 ${c.start_battery_level ?? "—"}% → ${c.end_battery_level ?? "—"}%</span></div></div></div>`).join("")
        : `<div class="tl stop">⏸ 停留 ${fmtDur(st.duration_min)} · ${esc(st.address)}</div>`);
    }
  });
  const extra = j.charges.filter(c => !used.has(c.id)); // e.g. charge at the very end
  extra.forEach(c => tl.push(`<div class="tl charge"><div class="card" data-charge="${c.id}"><div class="row"><b>⚡ ${esc(c.address)}</b>${c.cost != null ? `<span class="cost">${fmtMoney(c.cost, c.currency)}</span>` : ""}</div>
    <div class="row muted">${fmtTime(c.start_date)} · +${n(c.charge_energy_added, 1)} kWh</div></div></div>`));
  const grad = `linear-gradient(90deg, ${SPEED_STOPS.map(([k, c]) => `${c} ${k / 1.2}%`).join(", ")})`;
  const meta = `${fmtDate(s.start_date)} – ${fmtDate(s.end_date)} · ${j.drives.length} 段行程${s.charge_count ? ` · 充电 ${s.charge_count} 次` : ""}`;
  const pen = `<span class="pen" id="jedit" title="编辑标题和备注">✎</span>`;
  const heroOn = p2 && !!j.has_cover;
  v.innerHTML = `<div class="jtop"><button class="back">← 返回</button>${p2 ? `<div class="jtop-r">
      <button id="j-share" class="icon-btn" title="分享卡片" aria-label="分享卡片">📤</button>
      <button id="j-more" class="icon-btn" title="更多" aria-label="更多">⋯</button>
      <div id="j-menu" class="pop-menu" hidden><button data-act="setcover">🖼 当前地图设为封面</button>${j.has_cover ? `<button data-act="rmcover">↺ 恢复默认封面</button>` : ""}</div></div>` : ""}</div>
    ${heroOn ? `<div class="jhero sk" id="j-hero"><div class="jhero-in">
        <h2>${esc(j.name)} ${pen}</h2><div class="jhero-meta">${meta}</div>
        <div class="jhero-stats"><span>${n(s.distance_km, 0)} km</span><span>${n(s.energy_used_kwh, 1)} kWh</span><span>${n(s.efficiency_wh_km, 0)} Wh/km</span>${s.costs.length ? `<span>${costTxt(s.costs)}</span>` : ""}</div></div></div>`
      : `<h2 class="jtitle">🧭 ${esc(j.name)} ${pen}</h2><div class="muted">${meta}</div>`}
    <div id="j-msg" class="muted"></div>
    ${j.note ? `<div class="jnote">${esc(j.note)}</div>` : ""}
    ${p2 ? "" : `<div class="muted small-note">ℹ️ 封面、分享卡片、天气和速度分档能耗：${esc(ctx.journey2Message())}</div>`}
    <div class="map-tools"><div class="seg" id="j-color"><span data-v="speed" class="${speedOn ? "on" : ""}">速度着色</span><span data-v="plain" class="${speedOn ? "" : "on"}">单色</span></div>
      <div class="speed-legend" ${speedOn ? "" : "hidden"}><span>慢</span><i style="background:${grad}"></i><span>快 (km/h 0–120)</span></div></div>
    <div id="map"><div class="map-ph sk"></div></div>
    <div class="section-title">海拔</div><div class="elev-box" id="j-elev"><span class="sk" style="width:100%;height:120px"></span></div>
    <div class="grid">
      <div><small>总里程</small><b>${n(s.distance_km)} km</b></div>
      <div><small>驾驶时间</small><b>${fmtDur(s.driving_min)}</b></div>
      <div><small>停留时间</small><b>${fmtDur(s.stop_min)}</b></div>
      <div><small>总耗时</small><b>${fmtDur(s.elapsed_min)}</b></div>
      <div><small>耗电</small><b>${n(s.energy_used_kwh)} kWh</b></div>
      <div><small>平均能耗</small><b>${n(s.efficiency_wh_km, 0)} Wh/km</b></div>
      <div><small>途中充电</small><b>${n(s.charged_kwh)} kWh</b></div>
      <div><small>充电费用</small><b>${costTxt(s.costs)}</b></div>
      <div><small>最高速度</small><b>${s.speed_max ?? "—"} km/h</b></div>
    </div>
    ${p2 ? `<div class="section-title">按车速分档的能耗</div><div id="j-bands"><span class="sk" style="width:100%;height:120px;display:block"></span></div>
    <div class="section-title">天气与能耗</div><div id="j-wx"><span class="sk" style="width:100%;height:100px;display:block"></span></div>` : ""}
    <div class="section-title">时间线</div>
    <div class="timeline">${tl.join("")}</div>
    <div class="btn-row"><button id="jdrives" class="ghost">添加 / 移除行程</button><button id="jdel" class="ghost" style="color:var(--red)">删除旅程</button></div>`;
  (v.querySelector(".back") as HTMLElement).onclick = () => showJourneys(ctx);
  v.querySelectorAll<HTMLElement>("[data-drive]").forEach(el => el.onclick = () => ctx.showDrive(Number(el.dataset.drive), self));
  v.querySelectorAll<HTMLElement>("[data-charge]").forEach(el => el.onclick = () => ctx.showCharge(Number(el.dataset.charge), self));
  const edit = () => nameDialog({ title: "编辑旅程", name: j.name, note: j.note ?? "", ok: "保存",
    save: async (name, note) => { await api(`/api/journeys/${id}`, "PATCH", { name, note }); self(); },
    del: async () => { await api(`/api/journeys/${id}`, "DELETE"); showJourneys(ctx); } });
  (v.querySelector("#jedit") as HTMLElement).onclick = edit;
  (v.querySelector("#jdel") as HTMLElement).onclick = edit;
  (v.querySelector("#jdrives") as HTMLElement).onclick = () => editDrives(ctx, j);
  let route: [number, number][] = [];
  let map: DriveMap | null = null;
  if (p2) phase2(ctx, v, j, () => map, () => route, self);

  // map + elevation (path loaded separately; may be large)
  v.querySelectorAll<HTMLElement>("#j-color span").forEach(sp => sp.onclick = () => {
    const on = sp.dataset.v === "speed";
    v.querySelectorAll("#j-color span").forEach(x => x.classList.toggle("on", x === sp));
    (v.querySelector(".speed-legend") as HTMLElement).hidden = !on;
    saveSettings({ ...loadSettings(), speedColor: on });
    map?.setSpeedColor(on);
  });
  try {
    const path = await api<{ points: JPoint[]; total_points: number; downsampled: boolean }>(`/api/journeys/${id}/path`);
    if (!document.body.contains(v.querySelector("#j-elev"))) return;
    const byDrive = new Map<number, JPoint[]>();
    for (const p of path.points) { const a = byDrive.get(p.drive_id) ?? []; a.push(p); byDrive.set(p.drive_id, a); }
    const lines = j.drives.map(d => byDrive.get(d.id) ?? []).filter(a => a.length > 1)
      .map(a => ({ coords: a.map(p => [p.lng, p.lat] as [number, number]), speeds: a.map(p => p.speed) }));
    const stops = j.stops.filter(st => st.lat != null && st.lng != null).map(st => ({ p: [st.lng!, st.lat!] as [number, number],
      kind: (st.charge_ids.length ? "charge" : "stop") as "charge" | "stop", title: `${st.address ?? ""} · 停留 ${fmtDur(st.duration_min)}` }));
    route = lines.flatMap(l => l.coords);
    const mapEl = v.querySelector<HTMLElement>("#map")!; mapEl.innerHTML = "";
    if (lines.length) { map = new DriveMap(mapEl, { lines, stops, speedColor: speedOn }); ctx.setMap(map); }
    else mapEl.innerHTML = `<div class="muted" style="padding:20px;text-align:center">没有轨迹数据</div>`;
    // stop positions on the distance axis = km at the last point of the drive before the stop
    const stopsKm = j.stops.map(st => { const a = byDrive.get(st.after_drive_id); return { km: a?.length ? a[a.length - 1].km : -1, charge: st.charge_ids.length > 0 }; }).filter(x => x.km >= 0);
    v.querySelector("#j-elev")!.innerHTML = elevationChart(path.points, stopsKm) + (path.downsampled ? `<div class="muted small-note">轨迹点较多，已抽样显示（${path.points.length}/${path.total_points}）</div>` : "");
  } catch (e) {
    const el = v.querySelector<HTMLElement>("#j-elev"); if (el) { el.innerHTML = err(e); bindRetry(el, self); }
  }
}

// ---------------- Add / remove drives ----------------
function editDrives(ctx: Ctx, j: Journey) {
  ctx.setMap(null);
  const v = ctx.view;
  const all = [...j.drives.map(d => ({ ...d, journey_id: null as number | null })), ...j.candidates].sort((a, b) => a.start_date.localeCompare(b.start_date));
  const sel = new Set(j.drives.map(d => d.id));
  const render = () => {
    v.innerHTML = `<button class="back">← 返回</button><h2>添加 / 移除行程</h2>
      <div class="muted">「${esc(j.name)}」前后 24 小时内的行程。已属于其他旅程的不能选。</div><div style="height:8px"></div>
      ${all.map(d => { const dis = !!d.journey_id;
        return `<div class="card sel-mode${sel.has(d.id) ? " selected" : ""}${dis ? " disabled" : ""}" data-id="${d.id}"><div class="chk">${sel.has(d.id) ? "✓" : ""}</div><div class="cbody">
          <div class="row"><b>${esc(d.start_address)} → ${esc(d.end_address)}</b></div>
          <div class="row muted"><span>${fmtDate(d.start_date)} · ${fmtDur(d.duration_min)} · ${n(d.distance_km)} km</span>${badge(d)}</div></div></div>`; }).join("")}
      <div style="height:70px"></div><div class="actionbar"><span>已选 <b>${sel.size}</b> 段</span><div id="dmsg"></div>
        <button id="dsave" class="primary small" ${sel.size ? "" : "disabled"}>保存</button></div>`;
    (v.querySelector(".back") as HTMLElement).onclick = () => showJourney(ctx, j.id);
    v.querySelectorAll<HTMLElement>(".card[data-id]").forEach(el => el.onclick = () => {
      const id = Number(el.dataset.id); if (all.find(d => d.id === id)?.journey_id) return;
      sel.has(id) ? sel.delete(id) : sel.add(id); render();
    });
    (v.querySelector("#dsave") as HTMLElement).onclick = async () => {
      try { await api(`/api/journeys/${j.id}/drives`, "PUT", { drive_ids: [...sel] }); showJourney(ctx, j.id); }
      catch (e) { v.querySelector("#dmsg")!.innerHTML = `<span class="error">${esc((e as Error).message)}</span>`; }
    };
  };
  render();
}

/** Server-side when available (syncs across devices); otherwise remembered on this device. */
async function dismissSuggestion(ctx: Ctx, ids: number[]) {
  if (ctx.dismissAvailable()) {
    try { await api("/api/journeys/suggestions/dismiss", "POST", { drive_ids: ids }); return; }
    catch { /* table missing (503) or offline → local fallback */ }
  }
  const st = loadSettings();
  saveSettings({ ...st, dismissedDrives: [...new Set([...(st.dismissedDrives ?? []), ...ids])].slice(-2000) });
}

/** 设置 → 恢复已忽略的建议 */
export async function restoreDismissed(ctx: Ctx): Promise<string> {
  const st = loadSettings(); const local = st.dismissedDrives?.length ?? 0;
  saveSettings({ ...st, dismissedDrives: [] });
  if (!ctx.dismissAvailable()) return local ? "已恢复（本机）" : "没有已忽略的建议";
  try { const r = await api<{ restored: number }>("/api/journeys/suggestions/dismissed", "DELETE"); return `已恢复 ${r.restored + local} 条记录`; }
  catch { return local ? "已恢复本机记录（服务器未启用同步）" : "服务器未启用忽略同步，本机没有已忽略的建议"; }
}

// ---------------- 旅程第二期 (v0.7.0) ----------------
function phase2(ctx: Ctx, v: HTMLElement, j: Journey, getMap: () => DriveMap | null, getRoute: () => [number, number][], self: () => void) {
  const alive = () => document.body.contains(v.querySelector("#j-bands"));
  const msg = (t: string) => { const m = v.querySelector("#j-msg"); if (m) m.textContent = t; };
  let cover: string | null = null;
  const coverReady = j.has_cover ? J2.loadCover(j.id).then(img => {
    cover = img; const el = v.querySelector<HTMLElement>("#j-hero");
    if (el) { el.classList.remove("sk"); if (img) el.style.backgroundImage = `url("${img}")`; }
  }) : Promise.resolve();
  const menu = v.querySelector<HTMLElement>("#j-menu")!;
  const closeMenu = (e: Event) => { if (!(e.target as HTMLElement).closest("#j-more")) { menu.hidden = true; document.removeEventListener("click", closeMenu); } };
  (v.querySelector("#j-more") as HTMLElement).onclick = () => { menu.hidden = !menu.hidden; if (!menu.hidden) document.addEventListener("click", closeMenu); };
  (menu.querySelector('[data-act="setcover"]') as HTMLElement).onclick = async () => {
    msg("正在截取地图…");
    const img = await J2.mapSnapshot(getMap());
    if (!img) return msg("地图还没加载好，稍后再试");
    try { await J2.saveCover(j.id, img); self(); } catch (e) { msg((e as Error).message); }
  };
  const rm = menu.querySelector<HTMLElement>('[data-act="rmcover"]');
  if (rm) rm.onclick = async () => { try { await J2.resetCover(j.id); self(); } catch (e) { msg((e as Error).message); } };
  (v.querySelector("#j-share") as HTMLElement).onclick = async () => {
    msg("正在生成…");
    await coverReady;
    const s = j.summary;
    const img = cover ?? await J2.mapSnapshot(getMap(), 1080, 0.9);
    const d0 = s.start_date ? new Date(s.start_date) : null, d1 = s.end_date ? new Date(s.end_date) : null;
    const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = d0 && d1 ? Math.round((day(d1) - day(d0)) / 864e5) + 1 : 1;
    const f = (d: Date | null) => d ? d.toLocaleDateString("zh-CN", { year: "numeric", month: "numeric", day: "numeric" }) : "—";
    const canvas = await J2.renderCard({ title: j.name, dateText: days > 1 ? `${f(d0)} – ${f(d1)}` : f(d0), days, distance_km: s.distance_km,
      energy_kwh: s.energy_used_kwh, wh_km: s.efficiency_wh_km, costs: s.costs, drives: j.drives.length, charges: s.charge_count,
      from: s.start_address ?? "?", to: s.end_address ?? "?", image: img, route: getRoute() }, effectiveTheme() === "dark");
    msg("");
    J2.shareDialog(canvas, `DriveLens-${j.name.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40)}.png`);
  };
  J2.loadBands(j.id).then(r => { if (alive()) v.querySelector("#j-bands")!.innerHTML = J2.bandsHTML(r); })
    .catch(e => { const el = v.querySelector<HTMLElement>("#j-bands"); if (el) { el.innerHTML = err(e); bindRetry(el, self); } });
  J2.loadWeather(j.id).then(r => {
    if (!alive()) return;
    const by = new Map(r.drives.map(w => [w.drive_id, w]));
    v.querySelectorAll<HTMLElement>("[data-wx]").forEach(el => el.innerHTML = J2.weatherChip(by.get(Number(el.dataset.wx))));
    v.querySelector("#j-wx")!.innerHTML = J2.weatherTable(j.drives, r.drives) + (r.partial ? `<div class="muted small-note">部分天气数据暂时获取失败，下次打开会重试</div>` : "");
  }).catch(e => { const el = v.querySelector<HTMLElement>("#j-wx"); if (el) { el.innerHTML = err(e); bindRetry(el, self); } });
}
