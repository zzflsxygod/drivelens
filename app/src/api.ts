export type Theme = "auto" | "light" | "dark";
export type LabelLang = "ja" | "zh" | "en" | "local";
export interface Settings { apiUrl: string; token: string; theme?: Theme; labelLang?: LabelLang; currency?: string; journeyGap?: number; speedColor?: boolean;
  suggestionsOff?: boolean; suggestionsCollapsed?: boolean; dismissedDrives?: number[] }
const KEY = "drivelens-settings";
export function loadSettings(): Settings {
  try { return { apiUrl: "", token: "", ...JSON.parse(localStorage.getItem(KEY) || "{}") }; }
  catch { return { apiUrl: "", token: "" }; }
}
export function saveSettings(s: Settings) { localStorage.setItem(KEY, JSON.stringify(s)); }

export interface Car { id: number; name: string | null; model: string | null; marketing_name: string | null; vin: string | null }
export interface Charge {
  id: number; car_id: number; start_date: string; end_date: string; address: string | null; geofence: string | null; address_id: number | null; alias: string | null;
  latitude: number | null; longitude: number | null; charge_energy_added: number | null; charge_energy_used: number | null;
  cost: number | null; currency?: string | null; cost_source?: "manual" | "teslamate" | null; cost_note?: string | null;
  teslamate_cost?: number | null; default_currency?: string | null;
  start_battery_level: number | null; end_battery_level: number | null; duration_min: number | null;
  outside_temp_avg: number | null;
}
export interface ChargePoint { date: string; battery_level: number | null; charger_power: number | null; charge_energy_added: number | null;
  power_kw?: number | null; power_source?: string | null }
export interface Drive {
  id: number; car_id: number; start_date: string; end_date: string; start_address: string | null; end_address: string | null;
  start_address_id: number | null; end_address_id: number | null; start_alias: string | null; end_alias: string | null;
  distance_km: number | null; duration_min: number | null; speed_max: number | null; start_battery_level: number | null;
  end_battery_level: number | null; energy_kwh: number | null; efficiency_wh_km: number | null; outside_temp_avg: number | null;
  start_lat?: number | null; start_lng?: number | null; end_lat?: number | null; end_lng?: number | null;
  journey_id?: number | null; journey_name?: string | null;
}
export interface PathPoint { date: string; lat: number; lng: number; speed: number | null; elevation: number | null; battery_level: number | null }

export async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const s = loadSettings();
  if (!s.apiUrl) throw new Error("请先在「设置」中填写 API 地址和 Token");
  const headers: Record<string, string> = { Authorization: `Bearer ${s.token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(s.apiUrl.replace(/\/+$/, "") + path,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) throw new Error("Token 无效（401）");
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).error ?? ""; } catch { /* not json */ }
    if (res.status === 503 && /charge_costs/.test(detail))
      throw new Error("服务器还没有启用手动费用：请在服务器上重新执行 drivelens-init.sql（见 README）");
    if (res.status === 503 && /journey/.test(detail))
      throw new Error("服务器还没有启用旅程：请在服务器上执行 drivelens-v0.6.0.sql（见 README）");
    const err = new Error(`请求失败：HTTP ${res.status}${detail ? `（${detail}）` : ""}`) as Error & { status?: number };
    err.status = res.status;
    // 404 on a known route = server older than the app; 502/503 = server restarting (update)
    if ([404, 502, 503].includes(res.status)) window.dispatchEvent(new Event("drivelens-server-error"));
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const setAlias = (addressId: number, name: string) => api(`/api/addresses/${addressId}/alias`, "PUT", { name });
export const resetAlias = (addressId: number) => api(`/api/addresses/${addressId}/alias`, "DELETE");

export const setCost = (chargeId: number, amount: number, currency: string, note: string | null) =>
  api(`/api/charges/${chargeId}/cost`, "PUT", { amount, currency, note });
export const resetCost = (chargeId: number) => api(`/api/charges/${chargeId}/cost`, "DELETE");

export const CURRENCIES = ["JPY", "CNY", "USD", "EUR", "HKD", "TWD", "KRW", "GBP", "AUD", "CAD", "SGD", "CHF"];
export const defaultCurrency = () => loadSettings().currency || "JPY";
const ZERO_DEC = new Set(["JPY", "KRW", "TWD"]);
const SYM: Record<string, string> = { JPY: "¥", CNY: "CN¥", USD: "$", EUR: "€", GBP: "£", KRW: "₩", HKD: "HK$", TWD: "NT$", AUD: "A$", CAD: "C$", SGD: "S$" };
/** ¥1,234 for JPY (no decimals); 2 decimals for most other currencies. */
/** unit=true: per-kWh price, one extra decimal for zero-decimal currencies (¥36.4/kWh). */
export function fmtMoney(v: number | null | undefined, cur?: string | null, unit = false): string {
  if (v == null) return "—";
  const c = (cur || defaultCurrency()).toUpperCase();
  const d = ZERO_DEC.has(c) ? (unit ? 1 : 0) : 2;
  const num = v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  return SYM[c] ? SYM[c] + num : `${num} ${c}`;
}
