// First-run wizard + connection test (also used by 设置 → 保存并测试连接).
import { loadSettings, saveSettings } from "./api";
import { MIN_API_LEVEL, FEATURE_LEVEL, checkServer } from "./version";

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const LATEST_LEVEL = Math.max(...Object.values(FEATURE_LEVEL));
export const LATEST_SERVER = "0.10.0";

export interface TestResult { ok: boolean; url: string; message: string; warnings: string[]; cars?: number }

/** "drivelens.example.com/" → "https://drivelens.example.com" */
export function normalizeUrl(raw: string): string {
  let u = raw.trim().replace(/\/+$/, "");
  if (u && !/^[a-z]+:\/\//i.test(u)) u = "https://" + u;
  return u.replace(/\/(health|api)$/i, "");
}

export function tokenWarnings(token: string): string[] {
  const w: string[] = [];
  if (token && token.length < 32) w.push(`Token 只有 ${token.length} 位，建议在服务器上换成 32 位以上的随机字符串（如 openssl rand -hex 24 生成）`);
  else if (token && new Set(token).size < 10) w.push("Token 重复字符太多，建议换成随机生成的字符串");
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
  if (!url) return fail("请填写服务器地址，例如 https://drivelens.example.com");
  let parsed: URL;
  try { parsed = new URL(url); } catch { return fail("服务器地址格式不对，例如 https://drivelens.example.com"); }
  if (!/^https?:$/.test(parsed.protocol)) return fail("地址必须以 https:// 或 http:// 开头");
  if (!token) return fail("请填写 API Token（服务器 .env 里的 DRIVELENS_API_TOKEN）");
  const isHttp = parsed.protocol === "http:";
  const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.|\[?::1)/.test(parsed.hostname) || parsed.hostname.endsWith(".ts.net") || parsed.hostname.endsWith(".local");
  if (isHttp && location.protocol === "https:") return fail("当前页面是 https，浏览器会拦截 http 的服务器地址。请给服务器配置 https（推荐 Cloudflare Tunnel），或改用 https:// 地址");
  if (isHttp && !local) warnings.push("正在用不加密的 http 连接公网地址，Token 可能被窃听。建议使用 Cloudflare Tunnel（https）或 Tailscale");

  // 1) /health
  let res: Response;
  try { res = await timed(url + "/health"); }
  catch (e) {
    if ((e as Error).name === "AbortError") return fail(`连接超时：${parsed.host} 没有响应。请检查服务器 / 隧道是否在运行、地址和端口是否正确`);
    return fail(isHttp
      ? `无法连接 ${parsed.host}。请确认地址和端口（默认 8080）正确、手机和服务器在同一网络或已连上 Tailscale；如果服务器走 Cloudflare Tunnel，请改用 https://`
      : `无法连接 ${parsed.host}。请检查域名是否正确、隧道是否在运行；如果直接连接的是 API 端口（没有 https），请改用 http://地址:8080`);
  }
  const text = await res.text().catch(() => "");
  if (res.status === 404) return fail("这个地址上没有 DriveLens API（/health 返回 404）。请确认填的是 drivelens-api 的地址，而不是 TeslaMate 或 Grafana");
  if (!res.ok) return fail(res.status >= 500 ? `服务器出错或正在重启（HTTP ${res.status}），请稍后再试；也可以查看 docker compose logs drivelens-api` : `/health 返回 HTTP ${res.status}，请确认地址`);
  let h: { version?: string; api_level?: number } | null = null;
  try { h = JSON.parse(text); } catch { /* not json */ }
  if (!h || typeof h.api_level !== "number") {
    if (text.trim() === "ok") return fail("服务器版本过旧（v0.5.1 之前）。请在服务器上更新 drivelens-api 后再试");
    return fail("这个地址返回的不是 DriveLens API（可能是 TeslaMate、Grafana 或登录页面）。请填 drivelens-api 的地址");
  }
  if (h.api_level < MIN_API_LEVEL) return fail(`服务器版本过旧（v${h.version ?? "?"}），这个 App 至少需要 v0.3.1。请更新 drivelens-api`);
  if (h.api_level < LATEST_LEVEL) warnings.push(`服务器是 v${h.version ?? "?"}，部分新功能不可用；建议更新到 v${LATEST_SERVER} 或更新版本`);

  // 2) authenticated call
  try { res = await timed(url + "/api/cars", { headers: { Authorization: `Bearer ${token}` } }); }
  catch { return fail("/health 正常，但带 Token 的请求失败。请检查反向代理是否允许 Authorization 请求头"); }
  if (res.status === 401) return fail("Token 不正确（401）。请复制服务器 .env 里的 DRIVELENS_API_TOKEN，注意不要带空格或引号");
  if (res.status === 429) return fail("Token 错误次数太多，服务器已暂时拒绝这个 IP，请 10 分钟后再试");
  if (!res.ok) {
    let d = ""; try { d = (await res.json()).error ?? ""; } catch { /* ignore */ }
    return fail(`服务器连接成功，但读取车辆失败（HTTP ${res.status}${d ? `：${d}` : ""}）。请查看 docker compose logs drivelens-api，确认数据库账号和 setup.sql 已正确配置`);
  }
  const cars = await res.json().catch(() => []) as unknown[];
  const message = cars.length ? `连接成功：服务器 v${h.version ?? "?"}，找到 ${cars.length} 辆车` : `连接成功（服务器 v${h.version ?? "?"}），但 TeslaMate 里还没有车辆数据`;
  return { ok: true, url, message, warnings, cars: cars.length };
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
      <h1>欢迎使用 DriveLens</h1>
      <p class="muted">连接你自己的 TeslaMate 服务器上的 drivelens-api。还没部署？请看安装指南 docs/install.md。</p>
      <label>服务器地址<input id="su-url" inputmode="url" autocomplete="url" autocapitalize="off" spellcheck="false" placeholder="https://drivelens.example.com" value="${esc(s.apiUrl || "")}"></label>
      <label>API Token<input id="su-token" type="password" autocomplete="off" placeholder="服务器 .env 里的 DRIVELENS_API_TOKEN" value="${esc(s.token || "")}"></label>
      <label class="chk-row"><input type="checkbox" id="su-show"> 显示 Token</label>
      <button id="su-go" class="primary">测试连接并开始</button>
      <div id="su-msg"></div>
      <p class="muted small">Token 只保存在本机。推荐用 Cloudflare Tunnel（https）或 Tailscale 访问服务器，不要把 8080 端口直接暴露到公网。以后可以在「设置」里修改。</p>
    </div>
  </div>`;
  const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
  $("su-show").onchange = () => { $("su-token").type = $("su-show").checked ? "text" : "password"; };
  const go = $("su-go") as unknown as HTMLButtonElement;
  go.onclick = async () => {
    go.disabled = true; go.textContent = "正在测试…";
    $("su-msg").innerHTML = "";
    const r = await testConnection($("su-url").value, $("su-token").value.trim());
    go.disabled = false; go.textContent = "测试连接并开始";
    $("su-msg").innerHTML = renderResult(r);
    if (!r.ok) return;
    $("su-url").value = r.url;
    saveSettings({ ...loadSettings(), apiUrl: r.url, token: $("su-token").value.trim() });
    await checkServer();
    const finish = () => { document.body.classList.remove("setup-mode"); done(); };
    if (r.warnings.length) {
      go.textContent = "继续"; go.onclick = finish;
    } else setTimeout(finish, 900);
  };
}
