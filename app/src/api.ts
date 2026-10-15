export type Theme = "auto" | "light" | "dark";
export type LabelLang = "ja" | "zh" | "en" | "local";
export interface Settings { apiUrl: string; token: string; theme?: Theme; labelLang?: LabelLang }
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
  cost: number | null; start_battery_level: number | null; end_battery_level: number | null; duration_min: number | null;
  outside_temp_avg: number | null;
}
export interface ChargePoint { date: string; battery_level: number | null; charger_power: number | null; charge_energy_added: number | null }
export interface Drive {
  id: number; car_id: number; start_date: string; end_date: string; start_address: string | null; end_address: string | null;
  start_address_id: number | null; end_address_id: number | null; start_alias: string | null; end_alias: string | null;
  distance_km: number | null; duration_min: number | null; speed_max: number | null; start_battery_level: number | null;
  end_battery_level: number | null; energy_kwh: number | null; efficiency_wh_km: number | null; outside_temp_avg: number | null;
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
  if (!res.ok) throw new Error(`请求失败：HTTP ${res.status}`);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const setAlias = (addressId: number, name: string) => api(`/api/addresses/${addressId}/alias`, "PUT", { name });
export const resetAlias = (addressId: number) => api(`/api/addresses/${addressId}/alias`, "DELETE");
