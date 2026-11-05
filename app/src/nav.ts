// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser history for the in-app back stack (web / PWA only; the Tauri apps get their back button from platform.ts).
//
// The app renders its screens imperatively, so instead of a router this keeps the browser history *as deep* as the UI:
//   depth = (a tab other than 首页 ? 1 : 0) + detail pages + open sheets / popover menus / journey menu / select mode
// Opening something pushes one entry per level (same URL; only history.state.dl changes — nothing private ever goes
// into the address). Closing it in the app (its back / cancel button, backdrop, Esc, a tab switch) consumes the entries
// again with history.go(-n). The browser / Android back button fires popstate, which runs one in-app back step
// (inAppBack: topmost sheet or menu → detail page → 首页). At the root nothing is left, so the next back leaves the
// page (Android: closes the installed app). Switching between tabs keeps the same depth, so no entries pile up.
//
// Scroll: history.scrollRestoration is manual. When pushing a detail page we remember window.scrollY for the parent
// surface (tab root or intermediate page). On pop we mark that key for restore; after the parent re-paints,
// settleScroll() retries until the document is tall enough (async Home sections / list remount) or a timeout elapses.
import { hasOpenMenu } from "./ui";

interface Page { key: string; back: () => void }
let pages: Page[] = [];
let raf = 0;
const schedule = () => { if (!raf && enabled) raf = requestAnimationFrame(sync); };

/** Active tab id, or "home" when none is marked. */
function activeTab(): string {
  return document.querySelector<HTMLElement>("nav button.active")?.dataset.tab ?? "home";
}

/** Key for the surface that is currently showing (tab root, or the top detail page). */
function surfaceKey(): string {
  if (pages.length === 0) return `tab:${activeTab()}`;
  return `page:${pages[pages.length - 1].key}`;
}

const scrollByKey = new Map<string, number>();
/** Parent key to restore after the next paint; set on pop. */
let restoreKey: string | null = null;
/** In-flight restore target (survives async height growth). */
let pendingY: number | null = null;
let pendingUntil = 0;
const RESTORE_MS = 2500;

function markRestoreAfterPop() {
  restoreKey = pages.length === 0 ? `tab:${activeTab()}` : `page:${pages[pages.length - 1].key}`;
  pendingY = null;
}

/** Drop any pending restore (tab switch, explicit top). */
export function clearScrollRestore() {
  restoreKey = null;
  pendingY = null;
}

/**
 * After painting a screen: if we just came back from a child, restore the remembered scrollY once the document
 * is tall enough (rAF retries, ~2.5 s cap, then clamp). Otherwise, when `forwardTop` is true (default), scroll to top.
 */
export function settleScroll(opts?: { forwardTop?: boolean }): void {
  if (restoreKey != null) {
    pendingY = scrollByKey.get(restoreKey) ?? 0;
    restoreKey = null;
    pendingUntil = performance.now() + RESTORE_MS;
  }
  if (pendingY != null) {
    const y = pendingY;
    const tick = () => {
      if (pendingY !== y) return;   // superseded or cleared
      const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
      if (y <= 0) { window.scrollTo(0, 0); pendingY = null; return; }
      if (max >= y || performance.now() >= pendingUntil) {
        window.scrollTo(0, Math.min(y, max));
        pendingY = null;
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return;
  }
  if (opts?.forwardTop !== false) window.scrollTo(0, 0);
}

/** A detail page was rendered (drive, charge, report, battery, journey …). The same key again (re-render, month
 *  switch, coming back from a page above it) keeps / returns to its level; a new key is one level deeper. */
export function navPage(key: string, back: () => void) {
  const i = pages.findIndex(p => p.key === key);
  if (i >= 0) {
    const wasDeeper = pages.length > i + 1;
    pages.length = i + 1; pages[i].back = back;
    if (wasDeeper) {
      restoreKey = `page:${key}`;
      pendingY = null;
    }
  } else {
    // Going deeper: remember the parent surface's scroll before the child replaces the view.
    scrollByKey.set(surfaceKey(), window.scrollY);
    pages.push({ key, back });
  }
  schedule();
}
/** A tab root (list / 首页 / settings) was rendered: no detail pages above it. */
export function navRoot() { if (pages.length) { pages = []; schedule(); } }
/** Leave the top detail page when its back button is not on screen (still loading). false = no detail page open. */
export function popPage(): boolean {
  const p = pages.pop(); if (!p) return false;
  markRestoreAfterPop();
  schedule(); p.back(); return true;
}

function depth(): number {
  const overlays = document.querySelectorAll("body > .modal").length + (hasOpenMenu() ? 1 : 0)
    + (document.querySelector("#j-menu:not([hidden])") ? 1 : 0) + (document.querySelector("#view #selmode.active") ? 1 : 0);
  if (document.body.classList.contains("setup-mode")) return overlays;   // the setup wizard: only its own sheets
  const tab = document.querySelector<HTMLElement>("nav button.active")?.dataset.tab;
  return (tab && tab !== "home" ? 1 : 0) + pages.length + overlays;
}

let enabled = false;
let cur = 0;                                     // history.state.dl of the entry we are on
let waiting: number | null = null;               // a history.go() of ours is in flight
let waitTimer = 0;
const stateDl = () => { const s = history.state as { dl?: unknown } | null; return s && typeof s.dl === "number" && s.dl >= 0 ? s.dl : 0; };

function go(delta: number) {
  waiting = delta; clearTimeout(waitTimer);
  // a traversal that never fires popstate (nothing to go back to) must not block the sync for good
  waitTimer = window.setTimeout(() => { if (waiting != null) { waiting = null; cur = stateDl(); schedule(); } }, 1500);
  history.go(delta);
}

function sync() {
  raf = 0;
  if (waiting != null) return;                   // re-run once our own traversal has landed
  const d = depth();
  if (d > cur) {
    while (cur < d) { cur++; history.pushState({ dl: cur }, ""); }
  } else if (d < cur) go(d - cur);
}

/** Call once at start-up, after the first screen was chosen. `back` = one in-app back step (false = at the root). */
export function initHistory(back: () => boolean) {
  if (enabled || typeof history.pushState !== "function") return;
  enabled = true;
  try { history.scrollRestoration = "manual"; } catch { /* old browsers */ }   // app restores scroll on back itself
  cur = stateDl();
  addEventListener("popstate", () => {
    const to = stateDl();
    if (waiting != null) { waiting = null; clearTimeout(waitTimer); cur = to; schedule(); return; }
    if (to < cur) {
      // back (possibly several steps from the browser's history menu): one in-app step per entry
      let steps = cur - to; cur = to;
      while (steps-- > 0) if (!back()) { pages = []; break; }
      schedule();
    } else if (to > cur) go(cur - to);           // forward: there is nothing to re-open, stay where we are
  });
  // a page's own back button (also when inAppBack clicks it) leaves that page
  document.addEventListener("click", e => {
    const b = (e.target as Element | null)?.closest?.("#view .back");
    if (b && pages.length) { pages.pop(); markRestoreAfterPop(); schedule(); }
  }, true);
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "hidden"] });
  schedule();
}
