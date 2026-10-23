// SPDX-License-Identifier: AGPL-3.0-or-later
// First-run wizard + connection test (also used by Settings → save & test).
import { loadSettings, saveSettings } from "./api";
import { isPairingCode, pairWithCode, exchangeOwnerKey, defaultDeviceName, saveConnection, AuthError, type Device } from "./auth";
import { ic } from "./icons";
import { t, langSetting } from "./i18n";
import { MIN_API_LEVEL, FEATURE_LEVEL, checkServer } from "./version";
import { enterDemo } from "./demo";
import { isAndroid, isTauri } from "./platform";
import { installGuideUrl } from "./links";

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const LATEST_LEVEL = Math.max(...Object.values(FEATURE_LEVEL));
export const LATEST_SERVER = "0.14.0";

/** What gets saved after a successful test. A device token replaces the owner key, which is then not kept anywhere. */
export interface Creds { token: string; tokenKind?: "owner" | "device"; deviceId?: number; deviceScope?: "full" | "read" }
export interface TestResult { ok: boolean; url: string; message: string; warnings: string[]; cars?: number; creds?: Creds; device?: Device }

/** "drivelens.example.com/" → "https://drivelens.example.com" */
export function normalizeUrl(raw: string): string {
  let u = raw.trim().replace(/\/+$/, "");
  if (u && !/^[a-z]+:\/\//i.test(u)) u = "https://" + u;
  return u.replace(/\/(health|api)$/i, "");
}

export function tokenWarnings(token: string): string[] {
  const w: string[] = [];
  if (token && token.length < 32) w.push(t("su.tokShort", { n: token.length }));
  else if (token && new Set(token).size < 10) w.push(t("su.tokRepeat"));
  return w;
}

async function timed(url: string, init: RequestInit = {}, ms = 8000): Promise<Response> {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { cache: "no-store", ...init, signal: ctl.signal }); } finally { clearTimeout(t); }
}

/**
 * /health (no auth), then (server 0.14.0+) pairing code → device token or owner key → device token, then an authenticated
 * /api/cars; each failure mode gets its own message. `existing`: re-test the saved credentials (Settings, field left empty).
 */
export async function testConnection(rawUrl: string, input: string, existing?: Creds): Promise<TestResult> {
  const url = normalizeUrl(rawUrl);
  const cred = input.trim(), code = !existing && isPairingCode(cred);
  const ownerKey = existing ? (existing.tokenKind === "device" ? "" : existing.token) : code ? "" : cred;
  const warnings = tokenWarnings(ownerKey);   // weak-token hints are about the server's owner key only
  const fail = (message: string): TestResult => ({ ok: false, url, message, warnings });
  if (!url) return fail(t("su.noUrl"));
  let parsed: URL;
  try { parsed = new URL(url); } catch { return fail(t("su.badUrl")); }
  if (!/^https?:$/.test(parsed.protocol)) return fail(t("su.scheme"));
  if (!cred && !existing?.token) return fail(t("su.noToken"));
  const isHttp = parsed.protocol === "http:";
  const host = parsed.hostname.toLowerCase();
  // private / tailnet hosts: RFC1918, CGNAT 100.64/10 (Tailscale), link-local, loopback, *.ts.net, mDNS / home suffixes, dot-less MagicDNS names
  const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.|\[?::1|\[?f[cd][0-9a-f]{2}:|\[?fe80:)/.test(host)
    || /\.(ts\.net|local|lan|home\.arpa|internal)$/.test(host) || !host.includes(".");
  if (isHttp && location.protocol === "https:") return fail(t("su.mixed"));
  // mobile app: https only, except a server on your own network / tailnet (explicit http:// + warning)
  if (isHttp && !local && isAndroid()) return fail(t("su.httpPublic"));
  if (isHttp && !local) warnings.push(t("su.plainHttp"));
  else if (isHttp) warnings.push(t("su.httpLan"));

  // 1) /health
  let res: Response;
  try { res = await timed(url + "/health"); }
  catch (e) {
    if ((e as Error).name === "AbortError") return fail(t("su.timeout", { host: parsed.host }));
    if (!isTauri()) return fail(await webFetchFailure(url, parsed));
    return fail(isHttp
      ? t("su.unreachHttp", { host: parsed.host })
      : t("su.unreachHttps", { host: parsed.host }));
  }
  const text = await res.text().catch(() => "");
  if (res.status === 404) return fail(t("su.404"));
  if (!res.ok) return fail(res.status >= 500 ? t("su.5xx", { s: res.status }) : t("su.healthStatus", { s: res.status }));
  let h: { version?: string; api_level?: number } | null = null;
  try { h = JSON.parse(text); } catch { /* not json */ }
  if (!h || typeof h.api_level !== "number") {
    if (text.trim() === "ok") return fail(t("su.veryOld"));
    return fail(t("su.notDl"));
  }
  if (h.api_level < MIN_API_LEVEL) return fail(t("su.old", { v: h.version ?? "?" }));
  if (h.api_level < LATEST_LEVEL) warnings.push(t("su.partial", { v: h.version ?? "?", latest: LATEST_SERVER }));

  // 2) device auth (API level 15): never store the owner key when a device token can be had
  let creds: Creds, device: Device | undefined;
  if (existing) creds = existing;
  else if (code) {
    if (h.api_level < 15) return fail(t("su.codeOld", { v: h.version ?? "?" }));
    try { const r = await pairWithCode(url, cred, defaultDeviceName()); device = r.device; creds = { token: r.token, tokenKind: "device", deviceId: r.device.id, deviceScope: r.device.scope }; }
    catch (e) { return fail(authFail(e, true)); }
  } else if (h.api_level >= 15) {
    try { const r = await exchangeOwnerKey(url, cred, defaultDeviceName()); device = r.device; creds = { token: r.token, tokenKind: "device", deviceId: r.device.id, deviceScope: r.device.scope }; }
    catch (e) {
      // server can't store devices (no CREATE on the schema): keep the owner key, exactly as before 0.14.0
      if (e instanceof AuthError && e.status === 503 && e.code === "device_auth_unavailable") creds = { token: cred, tokenKind: "owner" };
      else return fail(authFail(e, false));
    }
  } else creds = { token: cred };
  const token = creds.token;

  // 3) authenticated call
  try { res = await timed(url + "/api/cars", { headers: { Authorization: `Bearer ${token}` } }); }
  catch { return fail(isTauri() ? t("su.authFetch") : t("su.authFetchWeb", { origin: location.origin })); }
  if (res.status === 401) return fail(t(creds.tokenKind === "device" ? "su.401device" : "su.401"));
  if (res.status === 429) return fail(t("su.429"));
  if (!res.ok) {
    let d = "", c = ""; try { const j = await res.json(); d = j.error ?? ""; c = j.code ?? ""; } catch { /* ignore */ }
    if (res.status === 403 && c === "owner_key_pair_only") return fail(t("su.pairOnly"));
    return fail(t("su.carsFail", { s: res.status, d: d ? `: ${d}` : "" }));
  }
  const cars = await res.json().catch(() => []) as unknown[];
  let message = cars.length ? t("su.ok", { v: h.version ?? "?", n: cars.length }) : t("su.okNoCars", { v: h.version ?? "?" });
  if (device) message += " " + t(device.scope === "read" ? "su.asDeviceRead" : "su.asDevice", { name: device.name });
  return { ok: true, url, message, warnings, cars: cars.length, creds, device };
}

/** Pairing / exchange failures → a message that says what to do. */
function authFail(e: unknown, code: boolean): string {
  if (!(e instanceof AuthError)) return String((e as Error)?.message ?? e);
  if (e.status === 0) return isTauri() ? t("su.authFetch") : t("su.authFetchWeb", { origin: location.origin });
  if (e.code === "rate_limited" || e.status === 429) return t(code ? "su.code429" : "su.429");
  if (e.code === "invalid_code") return t("su.codeInvalid");
  if (e.code === "too_many_devices") return t("su.tooMany");
  if (e.code === "device_auth_unavailable") return t("su.codeUnavailable");
  if (e.status === 401) return t("su.401");
  return t("su.carsFail", { s: e.status, d: e.message ? `: ${e.message}` : "" });
}

/**
 * Browsers hide why a fetch failed (CORS, DNS, TLS, offline all look the same: TypeError).
 * An opaque no-cors request tells "server answered but this site is not allowed (CORS)" apart from "server not reachable".
 */
async function webFetchFailure(url: string, parsed: URL): Promise<string> {
  if (!navigator.onLine) return t("su.offline");
  try {
    await timed(url + "/health", { mode: "no-cors" }, 6000);
    return t("su.cors", { host: parsed.host, origin: location.origin });
  } catch (e) {
    if ((e as Error).name === "AbortError") return t("su.timeout", { host: parsed.host });
    return t("su.unreachWeb", { host: parsed.host });
  }
}

export function renderResult(r: TestResult): string {
  return `<div class="${r.ok ? "ok" : "error"}">${r.ok ? ic("check") : ""}${esc(r.message)}</div>` +
    r.warnings.map(w => `<div class="warn">${ic("alert")} ${esc(w)}</div>`).join("");
}

/** Full-screen first-run wizard; resolves once a working server was saved. */
export function showSetupWizard(root: HTMLElement, done: () => void, notice = "") {
  document.body.classList.add("setup-mode");
  const s = loadSettings();
  root.innerHTML = `
  <div class="setup">
    <div class="setup-card">
      <div class="setup-logo">${ic("car")}</div>
      <select id="su-lang" class="su-lang" aria-label="Language"><option value="auto">Auto</option><option value="zh">中文</option><option value="en">English</option><option value="ja">日本語</option></select>
      ${notice ? `<div class="warn su-notice" role="status">${ic("alert")} ${esc(notice)}</div>` : ""}
      <h1>${t("su.welcome")}</h1>
      <p class="muted">${t("su.intro")}</p>
      <a class="su-guide" href="${esc(installGuideUrl())}" target="_blank" rel="noopener noreferrer">${ic("book")} ${t("su.guide")} <span aria-hidden="true">→</span></a>
      ${isTauri() ? "" : `<div class="su-webnote"><b>${ic("globe")} ${t("su.webTitle")}</b><ul><li>${esc(t("su.webHttps")).replace("tailscale serve", "<code>tailscale serve</code>")} <a class="su-tslink" href="${esc(installGuideUrl())}#tailscale" target="_blank" rel="noopener noreferrer">${t("su.webTsGuide")}<span aria-hidden="true">→</span></a></li><li>${t("su.webCors", { origin: esc(location.origin) })}</li></ul></div>`}
      <label>${t("su.url")}<input id="su-url" inputmode="url" autocomplete="url" autocapitalize="off" spellcheck="false" placeholder="https://drivelens.example.com" value="${esc(s.apiUrl || "")}"></label>
      <label>${t("su.cred")}<input id="su-token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${t("su.credPh")}"></label>
      <p class="muted small su-credhint">${t("su.credHint")}</p>
      <label class="chk-row"><input type="checkbox" id="su-show"> ${t("su.show")}</label>
      <button id="su-go" class="primary">${t("su.go")}</button>
      <div id="su-msg"></div>
      <div class="su-or"><span>${t("demo.or")}</span></div>
      <button id="su-demo" class="su-demo" type="button">${ic("spark")} ${t("demo.try")}</button>
      <p class="muted small su-demo-hint">${t("demo.tryHint")}</p>
      <p class="muted small">${isTauri() ? t("su.foot") : t("su.footWeb")}</p>
    </div>
  </div>`;
  const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
  $("su-show").onchange = () => { $("su-token").type = $("su-show").checked ? "text" : "password"; };
  const ls = document.getElementById("su-lang") as HTMLSelectElement;
  ls.value = langSetting();
  ls.onchange = () => {   // keep what was typed, then re-render in the new language
    saveSettings({ ...loadSettings(), apiUrl: "", token: "", uiLang: ls.value as "auto" });
    sessionStorage.setItem("drivelens-setup-draft", JSON.stringify({ url: $("su-url").value, token: $("su-token").value }));
    location.reload();
  };
  try {
    const dr = JSON.parse(sessionStorage.getItem("drivelens-setup-draft") || "null");
    if (dr) { $("su-url").value = dr.url || ""; $("su-token").value = dr.token || ""; sessionStorage.removeItem("drivelens-setup-draft"); }
  } catch { /* ignore */ }
  (document.getElementById("su-demo") as HTMLElement).onclick = () => enterDemo();
  const go = $("su-go") as unknown as HTMLButtonElement;
  go.onclick = async () => {
    go.disabled = true; go.textContent = t("set.testing");
    $("su-msg").innerHTML = "";
    const r = await testConnection($("su-url").value, $("su-token").value);
    go.disabled = false; go.textContent = t("su.go");
    $("su-msg").innerHTML = renderResult(r);
    if (!r.ok || !r.creds) return;
    $("su-url").value = r.url; $("su-token").value = "";
    saveConnection({ apiUrl: r.url, ...r.creds });
    await checkServer();
    const finish = () => { document.body.classList.remove("setup-mode"); done(); };
    if (r.warnings.length) {
      go.textContent = t("su.continue"); go.onclick = finish;
    } else setTimeout(finish, 900);
  };
}
