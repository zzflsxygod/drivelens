// SPDX-License-Identifier: AGPL-3.0-or-later
// Web / PWA glue (web build only): service worker (app shell cache), install prompt, theme-color, update toast.
// Tauri apps never register a service worker (__WEB_BUILD__ is false there, and isTauri() is checked again at runtime).
import { t } from "./i18n";
import { isTauri } from "./platform";

interface BIPEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> }
let deferred: BIPEvent | null = null;
const listeners: (() => void)[] = [];
export const onInstallChange = (f: () => void) => { listeners.push(f); };

export const isWeb = () => !isTauri();
export const isStandalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
/** iPhone / iPad Safari (iPadOS reports itself as a Mac with touch). No install prompt there: Share → Add to Home Screen. */
export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
/** "prompt": Chrome/Edge/Android offered an install prompt · "ios": manual steps · "" = installed or not installable. */
export function installMode(): "prompt" | "ios" | "" {
  if (!isWeb() || isStandalone()) return "";
  if (deferred) return "prompt";
  return isIOS() ? "ios" : "";
}
export async function promptInstall(): Promise<boolean> {
  const d = deferred; if (!d) return false;
  deferred = null;
  await d.prompt();
  const r = await d.userChoice.catch(() => ({ outcome: "dismissed" as const }));
  listeners.forEach(f => f());
  return r.outcome === "accepted";
}

const COLORS = { light: "#f3f4f7", dark: "#07080a" };
function syncThemeColor() {
  const c = document.documentElement.dataset.theme === "dark" ? COLORS.dark : COLORS.light;
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach(m => { m.content = c; m.removeAttribute("media"); });
}

function toast(text: string, action: string, onAction: () => void) {
  if (document.querySelector(".pwa-toast")) return;
  const el = document.createElement("div"); el.className = "pwa-toast"; el.setAttribute("role", "status");
  el.innerHTML = `<span></span><button type="button" class="primary small"></button>`;
  el.querySelector("span")!.textContent = text;
  const b = el.querySelector("button")!; b.textContent = action; b.onclick = onAction;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("in"));
}

function registerSW() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      const offer = (w: ServiceWorker) => toast(t("pwa.update"), t("pwa.reload"), () => w.postMessage("skipWaiting"));
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const w = reg.installing; if (!w) return;
        w.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) offer(w); });
      });
      let reloading = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloading) { reloading = true; location.reload(); } });
      // installed PWAs can stay open for days: look for a new shell when the app comes back to the foreground
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
    } catch (e) { console.warn("service worker", e); }
  });
}

export function initWeb() {
  if (!isWeb()) return;
  const root = document.documentElement;
  root.classList.add("web");
  if (isStandalone()) root.classList.add("standalone");
  if (isIOS()) root.classList.add("ios");
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferred = e as BIPEvent; listeners.forEach(f => f()); });
  window.addEventListener("appinstalled", () => { deferred = null; listeners.forEach(f => f()); });
  if (__WEB_BUILD__) {
    syncThemeColor();
    new MutationObserver(syncThemeColor).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    registerSW();
  }
}
