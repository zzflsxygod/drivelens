import { t, currentLang } from "./i18n";
import { isDemo, DEMO_URL, DEMO_TOKEN } from "./demo";
export type Theme = "auto" | "light" | "dark";
export type LabelLang = "ja" | "zh" | "en" | "local";
export interface Settings { apiUrl: string; token: string; uiLang?: "auto" | "zh" | "en" | "ja"; theme?: Theme; labelLang?: LabelLang; currency?: string; journeyGap?: number; speedColor?: boolean;
  suggestionsOff?: boolean; suggestionsCollapsed?: boolean; dismissedDrives?: number[] }
const KEY = "drivelens-settings";
function stored(): Settings {
  try { return { apiUrl: "", token: "", ...JSON.parse(localStorage.getItem(KEY) || "{}") }; }
  catch { return { apiUrl: "", token: "" }; }
}
/** In demo mode the API points at the local demo server; the real URL/token stay stored untouched. */
export function loadSettings(): Settings {
  const s = stored();
  return isDemo() ? { ...s, apiUrl: DEMO_URL, token: DEMO_TOKEN } : s;
}
/** The server configured by the user (ignores demo mode). */
export const realServer = () => { const s = stored(); return { apiUrl: s.apiUrl, token: s.token }; };
export function saveSettings(s: Settings) {
  // never persist the demo endpoint over the real configuration
  const v = isDemo() ? { ...s, ...realServer() } : s;
  localStorage.setItem(KEY, JSON.stringify(v));
}

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
  if (!s.apiUrl) throw new Error(t("api.noUrl"));
  const headers: Record<string, string> = { Authorization: `Bearer ${s.token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(s.apiUrl.replace(/\/+$/, "") + path,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    // browsers report CORS / DNS / TLS / offline all as a bare TypeError ("Failed to fetch")
    throw new Error(!navigator.onLine ? t("api.offline") : "__TAURI_INTERNALS__" in window ? t("api.network") : t("api.networkWeb"));
  }
  if (res.status === 401) throw new Error(t("api.401"));
  if (res.status === 429) throw new Error(t("api.429"));
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).error ?? ""; } catch { /* not json */ }
    if (res.status === 503 && /charge_costs/.test(detail))
      throw new Error(t("api.noCosts"));
    if (res.status === 503 && /v0\.7\.0|cover_image|weather_hourly/.test(detail))
      throw new Error(t("api.noCover"));
    if (res.status === 503 && /journey/.test(detail))
      throw new Error(t("api.noJourneys"));
    const err = new Error(t("api.failed", { s: res.status, d: detail ? t("api.detail", { d: detail }) : "" })) as Error & { status?: number };
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
const REGION_CUR: Record<string, string> = { JP: "JPY", CN: "CNY", US: "USD", HK: "HKD", TW: "TWD", KR: "KRW", GB: "GBP", AU: "AUD", CA: "CAD", SG: "SGD", CH: "CHF",
  DE: "EUR", FR: "EUR", IT: "EUR", ES: "EUR", NL: "EUR", BE: "EUR", AT: "EUR", IE: "EUR", FI: "EUR", PT: "EUR", GR: "EUR" };
const LANG_CUR: Record<string, string> = { ja: "JPY", zh: "CNY", ko: "KRW", de: "EUR", fr: "EUR", it: "EUR", es: "EUR", nl: "EUR" };
/** Default currency from the device locale (zh-TW → TWD, en-GB → GBP, ja → JPY …), USD when unknown. */
export function localeCurrency(lang = navigator.language || "en-US"): string {
  const [l, r] = lang.split(/[-_]/);
  const region = (r || "").toUpperCase();
  return REGION_CUR[region] || (l === "zh" && /hant/i.test(lang) ? "TWD" : LANG_CUR[l.toLowerCase()]) || "USD";
}
/** Map labels follow the app language unless set explicitly in Settings. */
export const defaultLabelLang = (): LabelLang => currentLang();
export const defaultCurrency = () => loadSettings().currency || localeCurrency();
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
