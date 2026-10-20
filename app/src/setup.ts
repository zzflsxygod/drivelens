// First-run wizard + connection test (also used by Settings → save & test).
import { loadSettings, saveSettings } from "./api";
import { t, langSetting } from "./i18n";
import { MIN_API_LEVEL, FEATURE_LEVEL, checkServer } from "./version";
import { enterDemo } from "./demo";
import { isAndroid, isTauri } from "./platform";
import { installGuideUrl } from "./links";

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const LATEST_LEVEL = Math.max(...Object.values(FEATURE_LEVEL));
export const LATEST_SERVER = "0.12.0";

export interface TestResult { ok: boolean; url: string; message: string; warnings: string[]; cars?: number }

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

/** /health (no auth) then an authenticated /api/cars; each failure mode gets its own message. */
export async function testConnection(rawUrl: string, token: string): Promise<TestResult> {
  const url = normalizeUrl(rawUrl);
  const warnings = tokenWarnings(token);
  const fail = (message: string): TestResult => ({ ok: false, url, message, warnings });
  if (!url) return fail(t("su.noUrl"));
  let parsed: URL;
  try { parsed = new URL(url); } catch { return fail(t("su.badUrl")); }
  if (!/^https?:$/.test(parsed.protocol)) return fail(t("su.scheme"));
  if (!token) return fail(t("su.noToken"));
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

  // 2) authenticated call
  try { res = await timed(url + "/api/cars", { headers: { Authorization: `Bearer ${token}` } }); }
  catch { return fail(isTauri() ? t("su.authFetch") : t("su.authFetchWeb", { origin: location.origin })); }
  if (res.status === 401) return fail(t("su.401"));
  if (res.status === 429) return fail(t("su.429"));
  if (!res.ok) {
    let d = ""; try { d = (await res.json()).error ?? ""; } catch { /* ignore */ }
    return fail(t("su.carsFail", { s: res.status, d: d ? `: ${d}` : "" }));
  }
  const cars = await res.json().catch(() => []) as unknown[];
  const message = cars.length ? t("su.ok", { v: h.version ?? "?", n: cars.length }) : t("su.okNoCars", { v: h.version ?? "?" });
  return { ok: true, url, message, warnings, cars: cars.length };
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
  return `<div class="${r.ok ? "ok" : "error"}">${r.ok ? "✅ " : ""}${esc(r.message)}</div>` +
    r.warnings.map(w => `<div class="warn">⚠️ ${esc(w)}</div>`).join("");
}

/** Full-screen first-run wizard; resolves once a working server was saved. */
export function showSetupWizard(root: HTMLElement, done: () => void) {
  document.body.classList.add("setup-mode");
  const s = loadSettings();
  root.innerHTML = `
  <div class="setup">
    <div class="setup-card">
      <div class="setup-logo">🚗</div>
      <select id="su-lang" class="su-lang" aria-label="Language"><option value="auto">🌐 Auto</option><option value="zh">中文</option><option value="en">English</option><option value="ja">日本語</option></select>
      <h1>${t("su.welcome")}</h1>
      <p class="muted">${t("su.intro")}</p>
      <a class="su-guide" href="${esc(installGuideUrl())}" target="_blank" rel="noopener noreferrer">📘 ${t("su.guide")} <span aria-hidden="true">→</span></a>
      ${isTauri() ? "" : `<div class="su-webnote"><b>🌐 ${t("su.webTitle")}</b><ul><li>${t("su.webHttps")}</li><li>${t("su.webCors", { origin: esc(location.origin) })}</li></ul></div>`}
      <label>${t("su.url")}<input id="su-url" inputmode="url" autocomplete="url" autocapitalize="off" spellcheck="false" placeholder="https://drivelens.example.com" value="${esc(s.apiUrl || "")}"></label>
      <label>API Token<input id="su-token" type="password" autocomplete="off" placeholder="${t("su.tokenPh")}" value="${esc(s.token || "")}"></label>
      <label class="chk-row"><input type="checkbox" id="su-show"> ${t("su.show")}</label>
      <button id="su-go" class="primary">${t("su.go")}</button>
      <div id="su-msg"></div>
      <div class="su-or"><span>${t("demo.or")}</span></div>
      <button id="su-demo" class="su-demo" type="button">✨ ${t("demo.try")}</button>
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
    const r = await testConnection($("su-url").value, $("su-token").value.trim());
    go.disabled = false; go.textContent = t("su.go");
    $("su-msg").innerHTML = renderResult(r);
    if (!r.ok) return;
    $("su-url").value = r.url;
    saveSettings({ ...loadSettings(), apiUrl: r.url, token: $("su-token").value.trim() });
    await checkServer();
    const finish = () => { document.body.classList.remove("setup-mode"); done(); };
    if (r.warnings.length) {
      go.textContent = t("su.continue"); go.onclick = finish;
    } else setTimeout(finish, 900);
  };
}
