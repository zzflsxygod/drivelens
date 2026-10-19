// UI language: 中文 (source), English, 日本語. Strings live in ./locales/*.ts (generated keys are checked by scripts/check-i18n.mjs).
import zh from "./locales/zh";
import en from "./locales/en";
import ja from "./locales/ja";

export type Lang = "zh" | "en" | "ja";
export type LangSetting = "auto" | Lang;
export type Key = keyof typeof zh;
const DICTS: Record<Lang, Record<Key, string>> = { zh, en, ja };
const SETTINGS_KEY = "drivelens-settings";

/** First supported language in the system list (navigator.languages), else English. */
export function systemLang(langs: readonly string[] = navigator.languages?.length ? navigator.languages : [navigator.language || "en"]): Lang {
  for (const l of langs) {
    const p = l.slice(0, 2).toLowerCase();
    if (p === "zh" || p === "ja" || p === "en") return p;
  }
  return "en";
}
export function langSetting(): LangSetting {
  try { const v = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}").uiLang; return v === "zh" || v === "en" || v === "ja" ? v : "auto"; }
  catch { return "auto"; }
}
/** Installs from before v0.11.0 (already configured, no uiLang yet) keep Chinese; new installs follow the system. */
(function migrate() {
  try {
    const st = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    // (also pins the pre-v0.10 implicit defaults JPY / Japanese map labels)
    if (st.apiUrl && st.uiLang === undefined)
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...st, uiLang: "zh", currency: st.currency || "JPY", labelLang: st.labelLang || "ja" }));
    // fresh install: mark it so it isn't mistaken for an old one once the wizard saves the server
    else if (!st.apiUrl && st.uiLang === undefined) localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...st, uiLang: "auto" }));
  } catch { /* ignore */ }
})();
let lang: Lang = langSetting() === "auto" ? systemLang() : langSetting() as Lang;
export const currentLang = () => lang;
/** For tests / the language switch (the app re-renders by reloading). */
export function setLang(l: Lang) { lang = l; document.documentElement.lang = BCP[l]; }
const BCP: Record<Lang, string> = { zh: "zh-CN", en: "en-US", ja: "ja-JP" };
/** BCP-47 locale for Intl formatting. */
export const locale = () => BCP[lang];
if (typeof document !== "undefined") document.documentElement.lang = BCP[lang];

/** t("key", { n: 3 }) — `{name}` placeholders, `{n|one|other}` plurals. Falls back to Chinese, then the key. */
export function t(k: Key, p?: Record<string, string | number>): string {
  const s = DICTS[lang][k] ?? zh[k] ?? k;
  if (!p) return s;
  // {n|one|other}: plural form chosen by the numeric param n (used by English)
  return s.replace(/\{(\w+)\|([^|}]*)\|([^}]*)\}/g, (m, n, one, other) => (n in p ? (Number(p[n]) === 1 ? one : other) : m))
    .replace(/\{(\w+)\}/g, (m, n) => (n in p ? String(p[n]) : m));
}

// ---- formatting ----
const dtf = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale(), o);
/** 10/19 14:05 style (month/day + time). */
export const fmtDateTime = (iso: string | null | undefined) => iso ? dtf({ month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)) : "—";
export const fmtTime = (v: string | number) => dtf({ hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(v));
/** Full date (year/month/day). */
export const fmtDay = (d: Date) => dtf({ year: "numeric", month: "numeric", day: "numeric" }).format(d);
/** Short month/day, e.g. 10/19 (zh/ja) or Oct 19 (en). */
export const fmtMonthDay = (iso: string) => lang === "en"
  ? dtf({ month: "short", day: "numeric" }).format(new Date(iso))
  : `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
/** "2026-10" → 2026年10月 / Oct 2026. */
export const monthLabel = (m: string) => lang === "en"
  ? new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${m.slice(0, 7)}-01T00:00:00Z`))
  : t("fmt.month", { y: m.slice(0, 4), m: Number(m.slice(5, 7)) });
/** Minutes → 1小时5分 / 1h 5m / 1時間5分. */
export const fmtDur = (m: number | null | undefined) => m == null ? "—"
  : m >= 60 ? t("fmt.hm", { h: Math.floor(m / 60), m: Math.round(m % 60) }) : t("fmt.m", { m: Math.round(m) });
/** Relative time: 刚刚 / 5 min ago / 3日前. */
export function ago(iso: string): string {
  const m = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return t("ago.now");
  if (m < 60) return t("ago.min", { n: m });
  if (m < 1440) return t("ago.hour", { n: Math.floor(m / 60) });
  return t("ago.day", { n: Math.floor(m / 1440) });
}
/** Thousands separators with fixed decimals (locale grouping is the same "," for all three languages). */
export const fmtNum = (v: number | null | undefined, d = 0) => v == null || !isFinite(v) ? "—" : v.toLocaleString(locale(), { minimumFractionDigits: d, maximumFractionDigits: d });
/** Weekday header Mon..Sun. */
export const weekdays = () => t("fmt.weekdays").split(",");
