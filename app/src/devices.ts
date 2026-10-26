// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings › Devices (device auth, drivelens-api 0.14.0+): device list, rename, disconnect, pairing codes, sign-out.
import { t, ago, fmtDay } from "./i18n";
import { ic } from "./icons";
import { popMenu } from "./ui";
import { focusField } from "./sheets";
import { isDemo } from "./demo";
import { loadSettings } from "./api";
import { lacks, serverReady } from "./version";
import { listDevices, renameDevice, revokeDevice, revokeOthers, createPairing, signOut, cachedMe, whoAmI, type Device, type Me, type Scope } from "./auth";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const hostOf = (u: string) => { try { return new URL(u).host; } catch { return u; } };

/** Confirm sheet (resolves false on cancel / backdrop / Esc). */
export function confirmSheet(o: { title: string; text: string; ok: string; danger?: boolean }): Promise<boolean> {
  return new Promise(resolve => {
    const dlg = document.createElement("div");
    dlg.className = "modal";
    dlg.innerHTML = `<div class="sheet"><h3>${esc(o.title)}</h3><p class="muted">${esc(o.text)}</p>
      <div class="btns"><button id="cancel" class="ghost">${t("common.cancel")}</button>
      <button id="ok" class="primary small${o.danger ? " danger" : ""}">${esc(o.ok)}</button></div></div>`;
    document.body.appendChild(dlg);
    const done = (v: boolean) => { dlg.remove(); resolve(v); };
    dlg.onclick = e => { if (e.target === dlg) done(false); };
    (dlg.querySelector("#cancel") as HTMLElement).onclick = () => done(false);
    (dlg.querySelector("#ok") as HTMLElement).onclick = () => done(true);
    (dlg.querySelector("#ok") as HTMLElement).focus();
  });
}

function renameSheet(current: string, save: (name: string) => Promise<void>) {
  const dlg = document.createElement("div");
  dlg.className = "modal";
  dlg.innerHTML = `<div class="sheet"><h3>${t("dev.rename")}</h3>
    <input id="dev-name" maxlength="60" enterkeyhint="done" autocomplete="off" value="${esc(current)}">
    <p class="muted small">${t("dev.renameHint")}</p><div id="dlgmsg"></div>
    <div class="btns"><button id="cancel" class="ghost">${t("common.cancel")}</button><button id="ok" class="primary small">${t("common.save")}</button></div></div>`;
  document.body.appendChild(dlg);
  const input = dlg.querySelector("#dev-name") as HTMLInputElement;
  focusField(input, true);
  const close = () => dlg.remove();
  dlg.onclick = e => { if (e.target === dlg) close(); };
  (dlg.querySelector("#cancel") as HTMLElement).onclick = close;
  const ok = dlg.querySelector("#ok") as HTMLButtonElement;
  ok.onclick = async () => {
    const v = input.value.trim();
    if (!v) { dlg.querySelector("#dlgmsg")!.innerHTML = `<div class="error">${t("common.nameEmpty")}</div>`; return; }
    ok.disabled = true;
    try { await save(v); close(); }
    catch (e) { ok.disabled = false; dlg.querySelector("#dlgmsg")!.innerHTML = `<div class="error">${esc((e as Error).message)}</div>`; }
  };
  input.onkeydown = e => { if (e.key === "Enter") ok.click(); };
}

/** "Add device": choose the scope (read-only: expiry), issue a one-time code, count down its 10 minutes. */
function addDeviceSheet(known: Set<number>, onPaired: () => void) {
  const dlg = document.createElement("div");
  dlg.className = "modal";
  const host = hostOf(loadSettings().apiUrl);
  dlg.innerHTML = `<div class="sheet pair-sheet"><h3>${t("dev.add")}</h3>
    <div id="pd-pick">
      <p class="muted small">${t("dev.addIntro")}</p>
      <div class="seg-tabs" id="pd-scope" role="radiogroup" aria-label="${t("dev.scope")}">
        <button type="button" role="radio" aria-checked="true" data-scope="full" class="on">${t("dev.scopeFull")}</button>
        <button type="button" role="radio" aria-checked="false" data-scope="read">${t("dev.scopeRead")}</button></div>
      <p class="muted small" id="pd-hint">${t("dev.scopeFullHint")}</p>
      <label id="pd-ttl-l" hidden>${t("dev.ttl")}<select id="pd-ttl">
        <option value="7">${t("dev.ttlDays", { n: 7 })}</option><option value="30" selected>${t("dev.ttlDays", { n: 30 })}</option><option value="0">${t("dev.ttlNone")}</option></select></label>
      <button id="pd-go" class="primary">${t("dev.issue")}</button>
    </div>
    <div id="pd-show" hidden>
      <p class="muted small" id="pd-for"></p>
      <div class="pair-code" id="pd-code" aria-live="polite"></div>
      <div class="pair-left" id="pd-left"></div>
      <ol class="pair-steps small">
        <li>${t("dev.step1")}</li>
        <li>${t("dev.step2", { host: `<code>${esc(host)}</code>` })}</li>
        <li>${t("dev.step3")}</li></ol>
      <p class="muted tiny">${t("dev.codeNote")}</p>
      <button id="pd-new" class="primary" hidden>${t("dev.newCode")}</button>
    </div>
    <div id="pd-msg" aria-live="polite"></div>
    <div class="btns"><button id="cancel" class="ghost">${t("common.close")}</button></div></div>`;
  document.body.appendChild(dlg);
  const $ = <T extends HTMLElement>(s: string) => dlg.querySelector(s) as T;
  let scope: Scope = "full", timer = 0, poll = 0;
  const stop = () => { clearInterval(timer); clearInterval(poll); timer = poll = 0; };
  const close = () => { stop(); dlg.remove(); };
  dlg.onclick = e => { if (e.target === dlg) close(); };
  $("#cancel").onclick = close;
  dlg.querySelectorAll<HTMLButtonElement>("#pd-scope button").forEach(b => b.onclick = () => {
    scope = b.dataset.scope as Scope;
    dlg.querySelectorAll<HTMLButtonElement>("#pd-scope button").forEach(x => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", String(x === b)); });
    $("#pd-ttl-l").hidden = scope !== "read";
    $("#pd-hint").textContent = t(scope === "read" ? "dev.scopeReadHint" : "dev.scopeFullHint");
  });
  const issue = async () => {
    const go = $<HTMLButtonElement>("#pd-go"), again = $<HTMLButtonElement>("#pd-new");
    go.disabled = again.disabled = true; $("#pd-msg").innerHTML = "";
    const ttl = scope === "read" ? Number($<HTMLSelectElement>("#pd-ttl").value) || null : null;
    try {
      const p = await createPairing(scope, ttl);
      if (!dlg.isConnected) return;
      $("#pd-pick").hidden = true; $("#pd-show").hidden = false; again.hidden = true;
      $("#pd-for").textContent = scope === "read" ? (ttl ? t("dev.forReadTtl", { n: ttl }) : t("dev.forRead")) : t("dev.forFull");
      $("#pd-code").textContent = p.code; $("#pd-code").classList.remove("expired");
      // count down from our own clock (the server's clock may differ): its TTL, capped at 10 minutes
      const ttlMs = Date.parse(p.expires_at) - Date.now();
      const end = Date.now() + (ttlMs > 0 && ttlMs <= 600e3 ? ttlMs : 600e3);
      const tick = () => {
        const left = Math.max(0, Math.round((end - Date.now()) / 1000));
        $("#pd-left").textContent = left ? t("dev.left", { t: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` }) : t("dev.expired");
        if (!left) { stop(); $("#pd-code").classList.add("expired"); again.hidden = false; again.disabled = false; }
      };
      stop(); tick(); timer = window.setInterval(tick, 1000);
      // notice when the new device has paired (the code itself is single-use)
      if (!isDemo()) poll = window.setInterval(async () => {
        const list = await listDevices().catch(() => null);
        const nd = list?.find(d => !known.has(d.id));
        if (!nd || !dlg.isConnected) return;
        stop(); known.add(nd.id);
        $("#pd-left").textContent = ""; $("#pd-code").classList.add("expired");
        $("#pd-msg").innerHTML = `<div class="ok">${ic("check")}${esc(t("dev.paired", { name: nd.name }))}</div>`;
        onPaired();
      }, 4000);
    } catch (e) {
      $("#pd-msg").innerHTML = `<div class="error">${esc((e as Error).message)}</div>`;
    } finally { go.disabled = false; again.disabled = false; }
  };
  $("#pd-go").onclick = issue;
  $("#pd-new").onclick = issue;
}

const isPhone = (d: Device) => /iPhone|iPad|Android|phone/i.test(`${d.name} ${d.user_agent ?? ""}`);
function rowHTML(d: Device) {
  const meta = [d.last_used_at ? t("dev.lastUsed", { t: ago(d.last_used_at) }) : t("dev.neverUsed")];
  if (d.last_ip) meta.push(esc(d.last_ip));
  if (d.expires_at) meta.push(t("dev.until", { d: fmtDay(new Date(d.expires_at)) }));
  return `<div class="dev-row${d.current ? " cur" : ""}" data-id="${d.id}">
    <span class="nt-ico" aria-hidden="true">${ic(isPhone(d) ? "phone" : "globe")}</span>
    <span class="dev-txt"><span class="dev-name"><b>${esc(d.name)}</b>${d.current ? `<span class="dev-tag cur">${t("dev.this")}</span>` : ""}${d.scope === "read" ? `<span class="dev-tag ro">${t("dev.readOnly")}</span>` : ""}</span>
      <small class="muted">${meta.join(" · ")}</small></span>
    <button type="button" class="dev-more" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(t("dev.menu", { name: d.name }))}">⋯</button></div>`;
}

/** Whether this session may manage devices: server ≥ 0.14.0 with device auth, and not a read-only device. Demo: yes. */
async function manageable(): Promise<Me | null> {
  await serverReady();
  if (lacks("devices")) return null;
  const s = loadSettings();
  if (!s.apiUrl || !s.token) return null;
  const me = cachedMe() ?? await whoAmI().catch(() => null);
  if (!me || !me.device_auth) return null;
  if (me.kind === "device" && me.device?.scope === "read") return null;
  return me;
}

/** Settings › Devices. Hidden entirely when not manageable (see above). */
export function mountDevices(slot: HTMLElement, onLeft: () => void) {
  let devices: Device[] = [], me: Me | null = null, msg = "";
  const render = () => {
    if (!slot.isConnected) return;
    if (!me) { slot.innerHTML = ""; return; }
    const others = devices.filter(d => !d.current).length;
    slot.innerHTML = `<div class="section-title"><span>${t("dev.title")}</span><span class="muted">${t("dev.count", { n: devices.length })}</span></div>
      <div class="card nt-card dev-card">${devices.length ? devices.map(rowHTML).join("") : `<div class="nt-skel"></div><div class="nt-skel"></div>`}
        <div class="dev-actions"><button type="button" id="dev-add" class="primary small">${t("dev.add")}</button>
          ${me.kind === "device" && others ? `<button type="button" id="dev-others" class="ghost small">${t("dev.revokeOthers")}</button>` : ""}</div>
        ${msg ? `<p class="muted small dev-msg" aria-live="polite">${esc(msg)}</p>` : ""}</div>`;
    bind();
  };
  const reload = async () => {
    try { devices = await listDevices(); msg = ""; } catch (e) { msg = (e as Error).message; }
    render();
  };
  const bind = () => {
    (slot.querySelector("#dev-add") as HTMLElement).onclick = () => addDeviceSheet(new Set(devices.map(d => d.id)), () => void reload());
    const ob = slot.querySelector<HTMLElement>("#dev-others");
    if (ob) ob.onclick = async () => {
      if (!await confirmSheet({ title: t("dev.revokeOthers"), text: t("dev.revokeOthersText", { n: devices.filter(d => !d.current).length }), ok: t("dev.revokeOthersOk"), danger: true })) return;
      try { const r = await revokeOthers(); devices = devices.filter(d => d.current); msg = t("dev.revokedN", { n: r?.revoked ?? 0 }); render(); void reload(); }
      catch (e) { msg = (e as Error).message; render(); }
    };
    slot.querySelectorAll<HTMLElement>(".dev-more").forEach(b => b.onclick = () => {
      const d = devices.find(x => x.id === Number(b.closest<HTMLElement>(".dev-row")!.dataset.id)); if (!d) return;
      popMenu(b, [{ value: "rename", label: t("dev.rename") }, { value: "revoke", label: d.current ? t("dev.signOut") : t("dev.revoke") }], async v => {
        if (v === "rename") renameSheet(d.name, async name => {
          await renameDevice(d.current ? "current" : d.id, name);
          if (d.current) await whoAmI().catch(() => {});
          await reload();
        });
        else if (d.current) { if (await confirmSignOut()) { await signOut(); onLeft(); } }
        else if (await confirmSheet({ title: t("dev.revokeTitle", { name: d.name }), text: t("dev.revokeText"), ok: t("dev.revoke"), danger: true })) {
          try { await revokeDevice(d.id); devices = devices.filter(x => x.id !== d.id); msg = ""; render(); }
          catch (e) { msg = (e as Error).message; render(); }
        }
      }, d.name);
    });
  };
  void manageable().then(m => { me = m; render(); if (m) void reload(); });
}

const confirmSignOut = () => confirmSheet({ title: t("dev.signOut"), text: t(isDemo() ? "dev.signOutDemo" : loadSettings().tokenKind === "device" ? "dev.signOutText" : "dev.signOutTextOwner"), ok: t("dev.signOutOk"), danger: true });

/** Settings › "Sign out of this device" (device token or owner key; demo: leave the demo). */
export function signOutCardHTML() {
  const s = loadSettings();
  if (!isDemo() && !(s.apiUrl && s.token)) return "";
  return `<div class="card about-card dev-signout-card"><button type="button" class="about-link dev-signout" id="dev-signout">
    <span class="about-ico" aria-hidden="true">${ic("ban")}</span><span>${t("dev.signOut")}<small class="muted">${t(isDemo() ? "dev.signOutDemoSub" : "dev.signOutSub")}</small></span></button></div>`;
}
export function bindSignOut(onLeft: () => void) {
  const b = document.getElementById("dev-signout");
  if (b) b.onclick = async () => { if (await confirmSignOut()) { await signOut(); onLeft(); } };
}
/** "This device: <name>" in the server card. */
export function thisDeviceText(): string {
  const me = cachedMe();
  if (me?.kind === "device" && me.device) return t("dev.thisDevice", { name: me.device.name }) + (me.device.scope === "read" ? ` · ${t("dev.readOnly")}` : "");
  return loadSettings().tokenKind === "device" ? t("dev.thisDevice", { name: "…" }) : "";
}
