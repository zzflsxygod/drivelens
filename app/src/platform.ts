// SPDX-License-Identifier: AGPL-3.0-or-later
// Platform glue: touch devices, Android (Tauri mobile) safe areas / status bar / back button / share,
// and external links (always the system browser, never inside the app's webview).
import { closeMenus, hasOpenMenu } from "./ui";

interface AndroidBridge {   // MainActivity.kt → webView.addJavascriptInterface(…, "DriveLensAndroid")
  insets(): string; setDarkBars(dark: boolean): void;
  shareImage(base64: string, name: string, title: string): string; saveImage(base64: string, name: string): string;
}
declare global { interface Window { DriveLensAndroid?: AndroidBridge; __dlInsets?: (json: string) => void; __TAURI_INTERNALS__?: unknown } }

export const isTauri = () => "__TAURI_INTERNALS__" in window;
const bridge = () => window.DriveLensAndroid;
export const isAndroid = () => !!bridge() || (isTauri() && /Android/i.test(navigator.userAgent));
/** Touch-first device (no fine pointer at all): native overlay scrollbars, bigger targets. */
export const isTouch = () => matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches;

function applyInsets(json: string) {
  try {
    const v = JSON.parse(json) as { top: number; right: number; bottom: number; left: number; ime: boolean };
    const s = document.documentElement.style;
    s.setProperty("--a-sat", `${v.top}px`); s.setProperty("--a-sar", `${v.right}px`);
    s.setProperty("--a-sab", `${v.bottom}px`); s.setProperty("--a-sal", `${v.left}px`);
    document.documentElement.classList.toggle("ime", !!v.ime);
  } catch { /* ignore */ }
}

/** Light/dark status + navigation bar icons follow the app theme (bars themselves are transparent, edge-to-edge). */
export function syncSystemBars() {
  try { bridge()?.setDarkBars(document.documentElement.dataset.theme === "dark"); } catch { /* old bridge */ }
}

// ---------------- back button / gesture ----------------
let backHandler: (() => boolean) | null = null;
/** main.ts provides the root-level fallback (other tab → home); returns false when already at the root. */
export function setRootBack(fn: () => boolean) { backHandler = fn; }
/** In-app back: topmost overlay first, then the page's own back button, then the root tab. false = nothing left (exit). */
export function inAppBack(): boolean {
  if (hasOpenMenu()) { closeMenus(); return true; }
  const modal = [...document.querySelectorAll<HTMLElement>(".modal")].pop();
  if (modal) { modal.dispatchEvent(new MouseEvent("click", { bubbles: true })); if (modal.isConnected) modal.remove(); return true; }
  const jmenu = document.querySelector<HTMLElement>("#j-menu:not([hidden])");
  if (jmenu) { jmenu.hidden = true; document.querySelector("#j-more")?.classList.remove("open"); return true; }
  const sel = document.querySelector<HTMLElement>("#selmode.active");
  if (sel) { sel.click(); return true; }
  const back = document.querySelector<HTMLElement>("#view .page-head .back, #view .back");
  if (back && back.offsetParent !== null) { back.click(); return true; }
  return backHandler?.() ?? false;
}

async function initBackButton() {
  try {
    const app = await import("@tauri-apps/api/app");
    await app.onBackButtonPress(() => { if (!inAppBack()) void app.exit(0); });
  } catch (e) { console.warn("back button", e); }
}

// ---------------- external links ----------------
export async function openExternal(url: string) {
  if (isTauri()) {
    try { const { openUrl } = await import("@tauri-apps/plugin-opener"); await openUrl(url); return; } catch (e) { console.warn("opener", e); }
  }
  window.open(url, "_blank", "noopener");
}
function initLinks() {
  document.addEventListener("click", e => {
    const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || a.hasAttribute("download")) return;
    let u: URL; try { u = new URL(a.href, location.href); } catch { return; }
    if (!/^(https?|mailto|tel):$/.test(u.protocol) || u.origin === location.origin) return;
    e.preventDefault(); void openExternal(u.href);
  }, true);
}

// ---------------- share / save (Android) ----------------
const b64 = (blob: Blob) => new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] ?? ""); r.onerror = () => no(r.error); r.readAsDataURL(blob); });
export const canNativeShare = () => !!bridge()?.shareImage;
/** "" on success, else an error message. */
export async function nativeShareImage(blob: Blob, name: string, title: string) { return bridge()!.shareImage(await b64(blob), name, title); }
export const canNativeSave = () => !!bridge()?.saveImage;
export async function nativeSaveImage(blob: Blob, name: string) { return bridge()!.saveImage(await b64(blob), name); }

export function initPlatform() {
  const root = document.documentElement;
  if (isTouch()) root.classList.add("touch");
  initLinks();
  if (!isAndroid()) return;
  root.classList.add("android");
  window.__dlInsets = applyInsets;
  try { applyInsets(bridge()?.insets() ?? "{}"); } catch { /* ignore */ }
  syncSystemBars();
  new MutationObserver(syncSystemBars).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  void initBackButton();
}
