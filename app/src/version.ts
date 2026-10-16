// Server version / API level check. Never throws; features degrade instead of crashing.
import { loadSettings } from "./api";

export const APP_VERSION: string = __APP_VERSION__;
/** Lowest API level this app works with at all (split home endpoints). */
export const MIN_API_LEVEL = 3;
/** Per-feature levels (see API_LEVEL in api/src/main.rs). */
export const FEATURE_LEVEL = { chargePower: 4, costs: 5, report: 6 } as const;
export type Feature = keyof typeof FEATURE_LEVEL;
/** Server release that introduced each level (for messages). */
const LEVEL_VERSION: Record<number, string> = { 3: "0.3.1", 4: "0.3.2", 5: "0.4.0", 6: "0.5.0", 7: "0.5.1" };

export interface ServerInfo { state: "ok" | "legacy" | "unreachable" | "unknown"; version: string | null; level: number | null }
let info: ServerInfo = { state: "unknown", version: null, level: null };
const listeners: (() => void)[] = [];
export const serverInfo = () => info;
export const onServerInfo = (f: () => void) => { listeners.push(f); };

/** Servers before v0.5.1 answer plain "ok": treated as v0.5.0 (level 6). Older ones still 404 on newer endpoints, handled where called. */
export const LEGACY_LEVEL = 6;
let pending: Promise<ServerInfo> | null = null;
/** Resolves once the current /health check finished (immediately if none is running). */
export const serverReady = () => pending ?? Promise.resolve(info);
/** GET /health (unauthenticated, no DB). */
export function checkServer(): Promise<ServerInfo> {
  pending = doCheck().finally(() => { pending = null; });
  return pending;
}
async function doCheck(): Promise<ServerInfo> {
  const s = loadSettings();
  if (!s.apiUrl) return info;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch(s.apiUrl.replace(/\/+$/, "") + "/health", { cache: "no-store", signal: ctl.signal }).finally(() => clearTimeout(t));
    if (!res.ok) throw new Error(String(res.status));
    const text = await res.text();
    let j: { version?: unknown; api_level?: unknown } | null = null;
    try { j = JSON.parse(text); } catch { /* legacy "ok" */ }
    info = j && typeof j.api_level === "number"
      ? { state: "ok", version: typeof j.version === "string" ? j.version : null, level: j.api_level }
      : { state: "legacy", version: null, level: LEGACY_LEVEL };
  } catch {
    info = { state: "unreachable", version: info.version, level: info.level };
  }
  listeners.forEach(f => { try { f(); } catch { /* ignore */ } });
  return info;
}

/** Known to be unsupported by the server → hide/disable the entry point. Unknown level → optimistic (404s handled). */
export const lacks = (f: Feature) => info.level != null && info.level < FEATURE_LEVEL[f];
const have = () => info.state === "ok" ? `v${info.version ?? "?"}` : info.state === "legacy" ? "旧版（无版本信息）" : "未知";
const need = (lv: number) => `v${LEVEL_VERSION[lv] ?? "?"}+`;
export const tooOldText = (lv: number) => `服务器正在更新或版本过旧（服务器 ${have()}，需要 ${need(lv)}），请稍后再试`;
export const featureText = (f: Feature) => tooOldText(FEATURE_LEVEL[f]);
/** Global banner: unreachable, or older than the app's minimum. */
export function globalBanner(): string | null {
  if (info.state === "unreachable") return "服务器正在更新或暂时无法连接，请稍后再试";
  if (info.state === "ok" && (info.level ?? 0) < MIN_API_LEVEL) return tooOldText(MIN_API_LEVEL);
  return null;
}
export function serverLabel() {
  return info.state === "ok" ? `v${info.version ?? "?"}（API level ${info.level}）` : info.state === "legacy" ? "旧版（v0.5.1 之前，无版本信息）"
    : info.state === "unreachable" ? "无法连接" : "检查中…";
}
