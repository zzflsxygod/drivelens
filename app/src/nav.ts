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
// Scroll: history.scrollRestoration is manual. On push we remember scrollY plus an element anchor (e.g. #sec-cc and
// its viewport offset). On back, settleScroll keeps re-applying that anchor while async Home sections change height,
// until the position is stable ~300 ms, a 2.5 s timeout, or the user scrolls/touches. overflow-anchor is disabled
// while restoring so the browser does not fight us.
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

/** Saved scroll for a parent surface. Prefer restoring via anchorId + anchorOffset when the element exists. */
interface ScrollMark {
  y: number;
  anchorId: string | null;
  /** getBoundingClientRect().top of the anchor when saved (viewport Y). */
  anchorOffset: number;
}

const scrollByKey = new Map<string, ScrollMark>();
/** Parent key to restore after the next paint; set on pop. */
let restoreKey: string | null = null;
/** In-flight restore target (survives async height growth). */
let pendingMark: ScrollMark | null = null;
let pendingUntil = 0;
let stableSince = 0;
let restoreGen = 0;
let mutObs: MutationObserver | null = null;
const RESTORE_MS = 2500;
const STABLE_MS = 300;

function stopMutObs() {
  mutObs?.disconnect();
  mutObs = null;
}

function startMutObs() {
  stopMutObs();
  mutObs = new MutationObserver(() => { stableSince = 0; });
  const root = document.getElementById("home")
    ?? document.getElementById("view")
    ?? document.body;
  mutObs.observe(root, { childList: true, subtree: true, characterData: true });
}

function markRestoreAfterPop() {
  restoreKey = pages.length === 0 ? `tab:${activeTab()}` : `page:${pages[pages.length - 1].key}`;
  pendingMark = null;
  restoreGen++;   // cancel any in-flight tick
  stopMutObs();
  document.documentElement.classList.remove("scroll-restoring");
}

/** Drop any pending restore (tab switch, explicit top, user gesture). */
export function clearScrollRestore() {
  restoreKey = null;
  pendingMark = null;
  restoreGen++;
  stopMutObs();
  document.documentElement.classList.remove("scroll-restoring");
}

/** Topmost visible `#sec-*` (or other id'd block in `#view` / `#home`) and its viewport offset. */
function captureMark(): ScrollMark {
  const y = window.scrollY;
  const nodes = document.querySelectorAll<HTMLElement>(
    "#home > [id], #view > [id], #view [id^='sec-'], #clist, #j-list, #dlist");
  let best: HTMLElement | null = null;
  let bestTop = Infinity;
  for (const el of nodes) {
    if (!el.id) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 1 && r.width < 1) continue;
    if (r.bottom <= 0) continue;                 // fully above the viewport
    if (r.top >= innerHeight) continue;          // fully below
    if (r.top < bestTop) { bestTop = r.top; best = el; }
  }
  if (!best) {
    // Nothing intersecting: use the last section that ends above the fold, else first below.
    let above: HTMLElement | null = null;
    let below: HTMLElement | null = null;
    for (const el of nodes) {
      if (!el.id) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom <= 0) above = el;
      else if (!below && r.top >= innerHeight) below = el;
    }
    best = above ?? below;
  }
  if (best) {
    return { y, anchorId: best.id, anchorOffset: best.getBoundingClientRect().top };
  }
  return { y, anchorId: null, anchorOffset: 0 };
}

/** Apply a mark once. Returns the post-apply scrollY (for stability checks). */
function applyMark(mark: ScrollMark): number {
  if (mark.anchorId) {
    const el = document.getElementById(mark.anchorId);
    if (el) {
      const top = el.getBoundingClientRect().top;
      const delta = top - mark.anchorOffset;
      if (Math.abs(delta) > 0.5) {
        // instant jump; avoid smooth scroll fighting the loop
        window.scrollTo(0, Math.max(0, window.scrollY + delta));
      }
      return window.scrollY;
    }
  }
  const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  window.scrollTo(0, Math.min(Math.max(0, mark.y), max));
  return window.scrollY;
}

let userCancelBound = false;
function bindUserCancel() {
  if (userCancelBound) return;
  userCancelBound = true;
  const cancel = () => { if (pendingMark) clearScrollRestore(); };
  // only real user gestures — not our own scrollTo
  addEventListener("wheel", cancel, { passive: true });
  addEventListener("touchstart", cancel, { passive: true });
  addEventListener("pointerdown", e => { if (e.isTrusted) cancel(); }, { passive: true });
}

/**
 * After painting a screen: if we just came back from a child, restore the remembered mark and keep re-applying
 * while layout shifts (async Home sections), until stable ~300 ms, timeout, or user scroll/touch.
 * Otherwise, when `forwardTop` is true (default), scroll to top.
 */
export function settleScroll(opts?: { forwardTop?: boolean }): void {
  if (restoreKey != null) {
    pendingMark = scrollByKey.get(restoreKey) ?? { y: 0, anchorId: null, anchorOffset: 0 };
    restoreKey = null;
    pendingUntil = performance.now() + RESTORE_MS;
    stableSince = 0;
    document.documentElement.classList.add("scroll-restoring");
    startMutObs();
    bindUserCancel();
  }
  if (pendingMark != null) {
    const mark = pendingMark;
    const gen = ++restoreGen;
    let lastY = NaN;
    let lastOffset = NaN;
    const tick = () => {
      if (gen !== restoreGen || pendingMark !== mark) return;
      const now = performance.now();
      applyMark(mark);
      const y = window.scrollY;
      const el = mark.anchorId ? document.getElementById(mark.anchorId) : null;
      const off = el ? el.getBoundingClientRect().top : mark.anchorOffset;
      const stable = el
        ? Math.abs(off - mark.anchorOffset) <= 1 && Math.abs(y - lastY) <= 1
        : Math.abs(y - mark.y) <= 1 && Math.abs(y - lastY) <= 1;
      if (stable && Math.abs(off - lastOffset) <= 1) {
        if (!stableSince) stableSince = now;
        if (now - stableSince >= STABLE_MS) {
          pendingMark = null;
          stopMutObs();
          document.documentElement.classList.remove("scroll-restoring");
          return;
        }
      } else {
        stableSince = 0;
      }
      lastY = y;
      lastOffset = off;
      if (now >= pendingUntil) {
        applyMark(mark);
        pendingMark = null;
        stopMutObs();
        document.documentElement.classList.remove("scroll-restoring");
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
      pendingMark = null;
      restoreGen++;
    }
  } else {
    // Going deeper: remember the parent surface's scroll (+ anchor) before the child replaces the view.
    scrollByKey.set(surfaceKey(), captureMark());
    pages.push({ key, back });
  }
  schedule();
}
/** A tab root (list / 首页 / settings) was rendered: no detail pages above it. */
export function navRoot() { if (pages.length) { pages = []; schedule(); } }
/** Leave the top detail page. Runs the stored back action. false = no detail page open.
 *  Both the in-app back button and browser/Android back (via inAppBack → popPage) use this so restore is identical. */
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
  // In-app back button → same popPage path as browser back (inAppBack also calls popPage first).
  // stopImmediatePropagation so the button's own onclick does not run showX a second time.
  document.addEventListener("click", e => {
    const b = (e.target as Element | null)?.closest?.("#view .back");
    if (b && pages.length) {
      e.preventDefault();
      e.stopImmediatePropagation();
      popPage();
    }
  }, true);
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "hidden"] });
  schedule();
}
