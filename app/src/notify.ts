// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings → Notifications (Web Push, api_level 13): trip summary when a drive ends, monthly report reminder on the 1st.
// The server (drivelens-api) does the detection and sends the pushes; this module only manages the browser subscription
// and the per-type toggles. Demo mode shows the same UI but everything is simulated locally (no permission, no push).
import { api } from "./api";
import { ic } from "./icons";
import { t, currentLang, type Key } from "./i18n";
import { isDemo, skey } from "./demo";
import { isTauri } from "./platform";
import { isIOS, isStandalone } from "./pwa";
import { lacks, featureText, serverReady, onServerInfo } from "./version";

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
interface Prefs { subscribed: boolean; trip_summary?: boolean; monthly_report?: boolean; tz?: string; locale?: string; last_success_at?: string | null; last_error?: string | null }
type State =
  | { k: "loading" } | { k: "app" } | { k: "unsupported" } | { k: "ios" } | { k: "insecure" } | { k: "old" } | { k: "missing" }
  | { k: "denied" } | { k: "off" } | { k: "on"; p: Prefs } | { k: "error"; msg: string };

const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };
const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const b64u = (buf: ArrayBuffer | null | undefined) => buf ? btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : "";
function fromB64u(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(new ArrayBuffer(b.length)); for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i); return out;
}
function swReady(ms = 10000): Promise<ServiceWorkerRegistration> {
  return Promise.race([navigator.serviceWorker.ready,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(t("nt.noSw"))), ms))]);
}
async function browserSub(): Promise<PushSubscription | null> {
  if (!supported()) return null;
  const r = await swReady(4000).catch(() => null);
  return r ? r.pushManager.getSubscription() : null;
}
const body = (s: PushSubscription, extra: Record<string, unknown> = {}) => {
  const j = s.toJSON();
  return { endpoint: s.endpoint, keys: { p256dh: j.keys?.p256dh ?? "", auth: j.keys?.auth ?? "" }, tz: tz(), locale: currentLang(),
    user_agent: navigator.userAgent.slice(0, 300), ...extra };
};
const isMissing = (e: unknown) => (e as { status?: number }).status === 503;

// ---------------- demo (simulated) ----------------
const DEMO_KEY = () => skey("drivelens-push-demo");
const demoPrefs = (): Prefs => { try { return { subscribed: false, ...JSON.parse(localStorage.getItem(DEMO_KEY()) || "{}") }; } catch { return { subscribed: false }; } };
const saveDemo = (p: Prefs) => localStorage.setItem(DEMO_KEY(), JSON.stringify(p));

async function detect(): Promise<State> {
  if (isDemo()) { const p = demoPrefs(); return p.subscribed ? { k: "on", p } : { k: "off" }; }
  if (isTauri()) return { k: "app" };
  await serverReady();
  if (lacks("push")) return { k: "old" };
  if (!window.isSecureContext) return { k: "insecure" };
  if (!supported()) return isIOS() && !isStandalone() ? { k: "ios" } : { k: "unsupported" };
  if (Notification.permission === "denied") return { k: "denied" };
  const s = await browserSub();
  if (!s) return { k: "off" };
  try {
    const p = await api<Prefs>("/api/push/subscription/status", "POST", { endpoint: s.endpoint });
    if (!p.subscribed) return { k: "off" };
    if (Notification.permission !== "granted") return { k: "off" };
    // keep the server's copy of time zone / language current (travel, language switch)
    if (p.tz !== tz() || p.locale !== currentLang()) void api("/api/push/subscription", "POST", body(s)).catch(() => {});
    return { k: "on", p };
  } catch (e) { return isMissing(e) ? { k: "missing" } : { k: "error", msg: (e as Error).message }; }
}

/** Must run inside the click handler: Safari only shows the permission prompt for a direct user gesture. */
async function enable(): Promise<State> {
  if (isDemo()) { const p = { subscribed: true, trip_summary: true, monthly_report: true }; saveDemo(p); return { k: "on", p }; }
  const perm = await Notification.requestPermission();
  if (perm === "denied") return { k: "denied" };
  if (perm !== "granted") return { k: "off" };
  let key: string;
  try { key = (await api<{ public_key: string }>("/api/push/key")).public_key; }
  catch (e) { return isMissing(e) ? { k: "missing" } : { k: "error", msg: (e as Error).message }; }
  const reg = await swReady();
  let s = await reg.pushManager.getSubscription();
  // a subscription made for another server (different VAPID key) cannot be reused
  if (s && b64u(s.options.applicationServerKey) !== key) { await s.unsubscribe().catch(() => {}); s = null; }
  s ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(key) });
  const p = await api<Prefs>("/api/push/subscription", "POST", body(s, { trip_summary: true, monthly_report: true }));
  return { k: "on", p };
}
async function disable(): Promise<State> {
  if (isDemo()) { saveDemo({ subscribed: false }); return { k: "off" }; }
  const s = await browserSub();
  if (s) { await api("/api/push/unsubscribe", "POST", { endpoint: s.endpoint }).catch(() => {}); await s.unsubscribe().catch(() => {}); }
  return { k: "off" };
}
async function setPref(field: "trip_summary" | "monthly_report", on: boolean): Promise<Prefs> {
  if (isDemo()) { const p = { ...demoPrefs(), [field]: on }; saveDemo(p); return p; }
  const s = await browserSub(); if (!s) throw new Error(t("nt.lost"));
  return api<Prefs>("/api/push/subscription", "POST", body(s, { [field]: on }));
}
async function sendTest(): Promise<void> {
  if (isDemo()) { demoPreview(); return; }
  const s = await browserSub(); if (!s) throw new Error(t("nt.lost"));
  await api("/api/push/test", "POST", { endpoint: s.endpoint });
}

/** Demo: an in-page banner that looks like the trip notification (tapping it opens the newest demo drive). */
function demoPreview() {
  document.querySelector(".nt-preview")?.remove();
  const el = document.createElement("div"); el.className = "nt-preview"; el.setAttribute("role", "status");
  el.innerHTML = `<img src="${document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]')?.href ?? "/icons/icon-192.png"}" alt="" onerror="this.style.visibility='hidden'">
    <div><div class="nt-pv-head"><b>DriveLens</b><span>${t("nt.now")}</span></div><b class="nt-pv-title">${t("nt.demoTitle")}</b><p>${t("nt.demoBody")}</p></div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("in"));
  const close = () => { el.classList.remove("in"); setTimeout(() => el.remove(), 320); };
  const timer = setTimeout(close, 6000);
  el.onclick = async () => { clearTimeout(timer); close();
    try { const d = await api<{ id: number }[]>("/api/drives?limit=1"); if (d[0]) window.dispatchEvent(new CustomEvent("drivelens-open", { detail: { view: `drive:${d[0].id}` } })); } catch { /* ignore */ } };
}

// ---------------- UI ----------------
const sw = (id: string, on: boolean, disabled = false) =>
  `<span class="nt-switch${on ? " on" : ""}"><input type="checkbox" role="switch" id="${id}"${on ? " checked" : ""}${disabled ? " disabled" : ""}><i aria-hidden="true"></i></span>`;
function row(id: string, ico: string, title: Key, sub: Key, on: boolean, disabled = false) {
  return `<label class="nt-row${disabled ? " dis" : ""}" for="${id}"><span class="nt-ico" aria-hidden="true">${ico}</span>
    <span class="nt-txt"><b>${t(title)}</b><small class="muted">${t(sub)}</small></span>${sw(id, on, disabled)}</label>`;
}
function hint(ico: string, text: string, extra = "") {
  return `<div class="nt-hint"><span aria-hidden="true">${ico}</span><div>${text}${extra}</div></div>`;
}

export function mountNotifications(slot: HTMLElement) {
  let st: State = { k: "loading" }, busy = false, msg = "";
  const render = () => {
    if (!slot.isConnected) return;
    const on = st.k === "on", p = on ? (st as { p: Prefs }).p : null;
    let inner = "";
    switch (st.k) {
      case "loading": inner = `<div class="nt-skel"></div><div class="nt-skel"></div>`; break;
      case "app": inner = hint(ic("globe"), t("nt.app")); break;
      case "old": inner = hint(ic("up"), esc(featureText("push")), `<br><span class="muted">${t("nt.oldHint")}</span>`); break;
      case "missing": inner = hint(ic("wrench"), t("nt.missing")); break;
      case "insecure": inner = hint(ic("lock"), t("nt.insecure")); break;
      case "unsupported": inner = hint(ic("ban"), t(isIOS() ? "nt.iosOld" : "nt.unsupported")); break;
      case "ios": inner = hint(ic("phone"), t("nt.ios")); break;
      case "denied": inner = hint(ic("bellOff"), t("nt.denied"), `<br><span class="muted">${t("nt.deniedHow")}</span>`); break;
      case "error": inner = hint(ic("alert"), esc(st.msg), ` <button class="ghost small nt-retry">${t("common.retry")}</button>`); break;
      case "off": case "on": inner = `
        ${row("nt-master", ic("bell"), "nt.master", on ? "nt.masterOn" : "nt.masterOff", on, busy)}
        <div class="nt-sub${on ? " open" : ""}" ${on ? "" : "inert"}><div>
          ${row("nt-trip", ic("car"), "nt.trip", "nt.tripSub", !!p?.trip_summary, busy || !on)}
          ${row("nt-month", ic("chart"), "nt.month", "nt.monthSub", !!p?.monthly_report, busy || !on)}
          <div class="nt-actions"><button class="ghost small" id="nt-test"${busy || !on ? " disabled" : ""}>${t("nt.test")}</button>
            <span class="muted small nt-msg" aria-live="polite">${esc(msg)}</span></div>
          ${isDemo() ? `<p class="muted tiny">${t("nt.demo")}</p>` : `<p class="muted tiny">${t("nt.where")}</p>`}
        </div></div>`;
    }
    slot.innerHTML = `<div class="section-title"><span>${t("nt.title")}</span></div><div class="card nt-card${on ? " on" : ""}${busy ? " busy" : ""}">${inner}</div>`;
    bind();
  };
  const run = async (f: () => Promise<State | void>, okMsg = "") => {
    if (busy) return; busy = true; msg = ""; render();
    try { const r = await f(); if (r) st = r; msg = okMsg; }
    catch (e) { msg = (e as Error).message || String(e); }
    busy = false; render();
  };
  const bind = () => {
    const m = slot.querySelector<HTMLInputElement>("#nt-master");
    if (m) m.onchange = () => {
      const want = m.checked; m.closest(".nt-switch")?.classList.toggle("on", want);
      // enable(): requestPermission is the first await in the gesture
      void run(() => want ? enable() : disable());
    };
    for (const [id, field] of [["nt-trip", "trip_summary"], ["nt-month", "monthly_report"]] as const) {
      const c = slot.querySelector<HTMLInputElement>(`#${id}`);
      if (c) c.onchange = () => {
        c.closest(".nt-switch")?.classList.toggle("on", c.checked);
        void run(async () => { const p = await setPref(field, c.checked); return { k: "on", p: { ...p, subscribed: true } }; });
      };
    }
    const tb = slot.querySelector<HTMLButtonElement>("#nt-test");
    if (tb) tb.onclick = () => void run(async () => { await sendTest(); }, isDemo() ? "" : t("nt.testSent"));
    const rb = slot.querySelector<HTMLButtonElement>(".nt-retry");
    if (rb) rb.onclick = () => { st = { k: "loading" }; render(); void detect().then(s => { st = s; render(); }); };
  };
  render();
  void detect().then(s => { st = s; render(); });
  onServerInfo(() => { if (slot.isConnected && !busy && st.k !== "on" && st.k !== "loading") void detect().then(s => { st = s; render(); }); });
}

/** Notification taps: the service worker focuses an open window and posts the target view (see vite.config.ts). */
export function initNotificationClicks(open: (view: string) => void) {
  window.addEventListener("drivelens-open", e => { const v = (e as CustomEvent<{ view?: string }>).detail?.view; if (v) open(v); });
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", e => {
    const d = e.data as { type?: string; view?: string } | null;
    if (d && d.type === "drivelens-open" && typeof d.view === "string") open(d.view);
  });
}
