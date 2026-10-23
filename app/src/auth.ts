// SPDX-License-Identifier: AGPL-3.0-or-later
// Device auth (drivelens-api 0.14.0+, API level 15): per-device tokens, pairing codes, sign-out.
// Tokens only ever travel to the user's own server, always in the Authorization header (never in a URL).
import { api, loadSettings, saveSettings, realServer, type Settings } from "./api";
import { t } from "./i18n";
import { isDemo, exitDemo } from "./demo";
import { disable as disablePush } from "./notify";

export type Scope = "full" | "read";
export interface Device {
  id: number; name: string; scope: Scope; created_via: "owner_key" | "pairing"; created_at: string; expires_at: string | null;
  last_used_at: string | null; last_ip: string | null; user_agent: string | null; current: boolean;
}
export interface Me { kind: "owner" | "device"; device: Device | null; device_auth: boolean; owner_key_mode: "full" | "pair-only" }
export interface Pairing { code: string; expires_at: string }
/** Error from the raw (pre-settings) auth calls: HTTP status + machine-readable code. */
export class AuthError extends Error {
  status: number; code: string;
  constructor(msg: string, status: number, code: string) { super(msg); this.status = status; this.code = code; }
}

/** "7kq2 m9xd" / "7KQ2M9XD" look like a pairing code; anything else is the server token (owner keys are ≥ 16 chars). */
export const PAIRING_RE = /^[0-9A-Za-z]{4}[- ]?[0-9A-Za-z]{4}$/;
export const isPairingCode = (v: string) => PAIRING_RE.test(v.trim());

// ---------------- who am I (cached for the session) ----------------
let me: Me | null = null;
const listeners: (() => void)[] = [];
export const cachedMe = () => me;
export const onMeChange = (f: () => void) => { listeners.push(f); };
function setMe(m: Me | null) { me = m; listeners.forEach(f => { try { f(); } catch { /* ignore */ } }); }

export async function whoAmI(): Promise<Me> {
  const m = await api<Me>("/api/auth/me");
  if (m.kind === "device" && m.device && !isDemo()) {
    const s = loadSettings();
    if (s.deviceId !== m.device.id || s.deviceScope !== m.device.scope || s.tokenKind !== "device")
      saveSettings({ ...s, tokenKind: "device", deviceId: m.device.id, deviceScope: m.device.scope });
  }
  setMe(m);
  return m;
}
/** false on a read-only device: every write entry point (rename, cost, journeys, suggestions) is hidden. */
export function canWrite(): boolean {
  if (isDemo()) return true;   // the demo device is "full"
  if (me) return !(me.kind === "device" && me.device?.scope === "read");
  return loadSettings().deviceScope !== "read";
}

// ---------------- raw calls (no saved settings yet) ----------------
async function rawPost<T>(url: string, path: string, body: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try { res = await fetch(url.replace(/\/+$/, "") + path, { method: "POST", headers, body: JSON.stringify(body), cache: "no-store" }); }
  catch { throw new AuthError(navigator.onLine ? t("api.network") : t("api.offline"), 0, "network"); }
  let j: { error?: string; code?: string } & Record<string, unknown> = {};
  try { j = await res.json(); } catch { /* not json */ }
  if (!res.ok) throw new AuthError(j.error || `HTTP ${res.status}`, res.status, j.code || (res.status === 401 ? "unauthorized" : res.status === 429 ? "rate_limited" : ""));
  return j as T;
}
/** Owner key → a full-scope device token for this device. The owner key itself is not kept. */
export const exchangeOwnerKey = (url: string, key: string, name: string) =>
  rawPost<{ token: string; device: Device }>(url, "/api/auth/devices", { name }, key);
/** Pairing code (public endpoint, no Authorization) → a device token with the code's scope. */
export const pairWithCode = (url: string, code: string, name: string) =>
  rawPost<{ token: string; device: Device }>(url, "/api/auth/pair", { code: code.trim().toUpperCase().replace(/\s+/g, "-"), name });

// ---------------- device management (signed-in) ----------------
export const listDevices = () => api<Device[]>("/api/auth/devices");
export const renameDevice = (id: number | "current", name: string) => api<Device>(`/api/auth/devices/${id}`, "PATCH", { name });
export const revokeDevice = (id: number | "current") => api<void>(`/api/auth/devices/${id}`, "DELETE");
export const revokeOthers = () => api<{ revoked: number }>("/api/auth/devices?except=current", "DELETE");
export const createPairing = (scope: Scope, ttlDays: number | null) =>
  api<Pairing>("/api/auth/pairings", "POST", scope === "read" && ttlDays ? { scope, device_ttl_days: ttlDays } : { scope });

/** "iPhone · Safari", "Windows · Chrome" … from the user agent (shown in the device list). */
export function defaultDeviceName(ua = navigator.userAgent, touch = navigator.maxTouchPoints > 1): string {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || (/Macintosh/.test(ua) && touch) ? "iPad" : /Android/.test(ua) ? "Android"
    : /CrOS/.test(ua) ? "ChromeOS" : /Windows/.test(ua) ? "Windows" : /Macintosh|Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  const br = /Edg(e|A|iOS)?\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /SamsungBrowser/.test(ua) ? "Samsung Internet"
    : /Firefox|FxiOS/.test(ua) ? "Firefox" : /Chrome|CriOS|Chromium/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "";
  const app = "__TAURI_INTERNALS__" in window ? "DriveLens" : br;
  return [os, app].filter(Boolean).join(" · ") || t("dev.unnamed");
}

// ---------------- local state ----------------
/** Per-server caches written by the app (production namespace only; demo keys live under drivelens-demo~). */
export const isServerCacheKey = (k: string) => k.startsWith("drivelens-home-") || k === "drivelens-last-car" || k.startsWith("drivelens-list-");
export function clearServerCaches() {
  const drop: string[] = [];
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i)!; if (isServerCacheKey(k)) drop.push(k); }
  drop.forEach(k => localStorage.removeItem(k));
}
type Conn = Pick<Settings, "apiUrl" | "token" | "tokenKind" | "deviceId" | "deviceScope">;
/** Saves a new connection; switching to another server first drops the old server's cached data. */
export function saveConnection(c: Conn) {
  const old = realServer().apiUrl;
  if (old && old !== c.apiUrl) clearServerCaches();
  const n: Settings = { ...loadSettings(), ...c };
  for (const k of ["tokenKind", "deviceId", "deviceScope"] as const) if (c[k] === undefined) delete n[k];
  saveSettings(n);
  setMe(null);
}

/**
 * Before switching this device to another server (or re-pairing it): disconnect the old device on the OLD server,
 * best effort. Only for a device token on a server with device auth (level ≥ 15); short timeouts; failures ignored.
 * The old token goes only to the old server's own URL.
 */
export async function revokeOldDevice(old: { apiUrl: string; token: string; tokenKind?: string }) {
  if (old.tokenKind !== "device" || !old.apiUrl || !old.token) return;
  const base = old.apiUrl.replace(/\/+$/, "");
  const timed = async (url: string, init: RequestInit = {}) => {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 3000);
    try { return await fetch(url, { cache: "no-store", ...init, signal: ctl.signal }); } finally { clearTimeout(tm); }
  };
  try {
    const h = await (await timed(base + "/health")).json() as { api_level?: number };
    if (typeof h.api_level !== "number" || h.api_level < 15) return;
    await timed(base + "/api/auth/devices/current", { method: "DELETE", headers: { Authorization: `Bearer ${old.token}` } });
  } catch { /* offline / old server gone: it stays in that server's list until disconnected there */ }
}

let leaving = false;
/** True while this device is signing out (its own 401s must not start a second sign-out). */
export const isLeaving = () => leaving;
/** Forget the server on this device: URL + token + device info, server caches, push subscription. Display settings stay. */
export async function forgetServer() {
  leaving = true;
  // local state first: from here on no request can reach the server with the old token
  clearServerCaches();
  const s = loadSettings();
  for (const k of ["tokenKind", "deviceId", "deviceScope"] as const) delete s[k];
  saveSettings({ ...s, apiUrl: "", token: "" });
  setMe(null);
  // then the browser's push subscription (the server already dropped it with the device)
  await Promise.race([disablePush().catch(() => {}), new Promise(r => setTimeout(r, 1500))]);
}
/** Sign out of this device. Device token: revoke it on the server first (best effort). Owner key: local only. Demo: leave the demo. */
export async function signOut() {
  if (isDemo()) { exitDemo(); return; }
  leaving = true;
  if (loadSettings().tokenKind === "device") {
    await disablePush().catch(() => {});   // while the token still works
    await revokeDevice("current").catch(() => {});
  }
  await forgetServer();
}

// ---------------- automatic migration of saved owner keys (app 1.2.0) ----------------
/** Replaces a saved owner key by a device token. Silent: any failure is retried on the next start. */
export async function upgradeToDeviceToken(level: number) {
  if (level < 15 || isDemo()) return;
  const run = async () => {
    const s = loadSettings();   // re-read inside the lock: another tab may have upgraded already
    if (!s.apiUrl || !s.token || s.tokenKind === "device") return;
    const m = await whoAmI();
    if (m.kind === "device") return;   // whoAmI() already marked it
    if (!m.device_auth) { if (s.tokenKind !== "owner") saveSettings({ ...s, tokenKind: "owner" }); return; }
    const r = await exchangeOwnerKey(s.apiUrl, s.token, defaultDeviceName());
    const now = loadSettings();
    if (now.apiUrl !== s.apiUrl || now.token !== s.token) return;   // changed meanwhile
    saveSettings({ ...now, token: r.token, tokenKind: "device", deviceId: r.device.id, deviceScope: r.device.scope });
    setMe({ ...m, kind: "device", device: r.device });
  };
  try {
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (locks?.request) await locks.request("drivelens-upgrade", run); else await run();
  } catch { /* silent; the next start retries */ }
}
/** On start (level ≥ 15): learn who this device is, upgrading a saved owner key when possible. */
export async function initDeviceAuth(level: number) {
  if (level < 15) { setMe(null); return; }
  const s = loadSettings();
  if (!s.apiUrl || !s.token) return;
  if (!isDemo() && s.tokenKind !== "device") return upgradeToDeviceToken(level);
  await whoAmI().catch(() => {});
}
