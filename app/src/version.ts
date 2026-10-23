// SPDX-License-Identifier: AGPL-3.0-or-later
// Server version / API level check. Never throws; features degrade instead of crashing.
import { loadSettings } from "./api";
import { t } from "./i18n";

export const APP_VERSION: string = __APP_VERSION__;
/** Lowest API level this app works with at all (split home endpoints). */
export const MIN_API_LEVEL = 3;
/** Per-feature levels (see API_LEVEL in api/src/main.rs). */
export const FEATURE_LEVEL = { chargePower: 4, costs: 5, report: 6, journeys: 8, dismiss: 9, paging: 10, journey2: 11, insights: 12, push: 13, tmHealth: 14 } as const;
export type Feature = keyof typeof FEATURE_LEVEL;
/** Server release that introduced each level (for messages). */
const LEVEL_VERSION: Record<number, string> = { 3: "0.3.1", 4: "0.3.2", 5: "0.4.0", 6: "0.5.0", 7: "0.5.1", 8: "0.6.0", 9: "0.6.1", 10: "0.6.2", 11: "0.7.0", 12: "0.9.0", 13: "0.12.0", 14: "0.13.0" };

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
const have = () => info.state === "ok" ? `v${info.version ?? "?"}` : info.state === "legacy" ? t("ver.legacy") : t("ver.unknown");
const need = (lv: number) => `v${LEVEL_VERSION[lv] ?? "?"}+`;
export const tooOldText = (lv: number) => t("ver.tooOld", { have: have(), need: need(lv) });
export const featureText = (f: Feature) => tooOldText(FEATURE_LEVEL[f]);
/** Global banner: unreachable, or older than the app's minimum. */
export function globalBanner(): string | null {
  if (info.state === "unreachable") return t("ver.unreachable");
  if (info.state === "ok" && (info.level ?? 0) < MIN_API_LEVEL) return tooOldText(MIN_API_LEVEL);
  return null;
}
export function serverLabel() {
  return info.state === "ok" ? t("ver.label", { v: info.version ?? "?", l: info.level ?? "?" }) : info.state === "legacy" ? t("ver.legacyLong")
    : info.state === "unreachable" ? t("ver.cannotConnect") : t("common.checking");
}
