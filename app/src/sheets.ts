// SPDX-License-Identifier: AGPL-3.0-or-later
// Bottom sheets / dialogs (.modal > .sheet): keyboard-safe on iOS, accessible, Esc to cancel.
//
// iOS Safari / home-screen PWAs do not shrink the layout viewport when the on-screen keyboard opens, so a
// position:fixed sheet anchored to the bottom ends up *behind* the keyboard (and inputs < 16px make iOS zoom
// in on focus as well). We pin every open .modal to the *visual* viewport instead (--vv-top / --vv-h), so
// the sheet always sits right above the keyboard.

const root = document.documentElement;
let raf = 0;

function syncViewport() {
  raf = 0;
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight, top = vv ? vv.offsetTop : 0;
  root.style.setProperty("--vv-h", `${Math.round(h)}px`);
  root.style.setProperty("--vv-top", `${Math.round(top)}px`);
  // keyboard (or any big inset) open → the bottom safe-area padding is not needed
  root.classList.toggle("kb-open", window.innerHeight - h > 120);
  const a = document.activeElement as HTMLElement | null;
  if (a && a.closest(".modal .sheet") && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) a.scrollIntoView({ block: "nearest" });
}
const schedule = () => { if (!raf) raf = requestAnimationFrame(syncViewport); };

let seq = 0;
function prepare(m: HTMLElement) {
  if (m.dataset.sheet) return;
  m.dataset.sheet = "1";
  const sheet = m.querySelector<HTMLElement>(".sheet");
  m.setAttribute("role", "dialog"); m.setAttribute("aria-modal", "true");
  const h = sheet?.querySelector("h3");
  if (h) { h.id ||= `sheet-h-${++seq}`; m.setAttribute("aria-labelledby", h.id); }
  syncViewport();
}

/** Call once at start-up. */
export function initSheets() {
  syncViewport();
  window.visualViewport?.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("scroll", schedule);
  window.addEventListener("resize", schedule);
  new MutationObserver(recs => {
    for (const r of recs) r.addedNodes.forEach(n => { if (n instanceof HTMLElement && n.classList.contains("modal")) prepare(n); });
    document.body.classList.toggle("sheet-open", !!document.querySelector("body > .modal"));
  }).observe(document.body, { childList: true });
  // Esc closes the topmost sheet (same as Cancel / tapping the backdrop)
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    const all = document.querySelectorAll<HTMLElement>("body > .modal"); const top = all[all.length - 1];
    if (!top) return;
    e.preventDefault();
    const cancel = top.querySelector<HTMLElement>("#cancel, #sh-close, [data-cancel]");
    if (cancel) cancel.click(); else top.remove();
  });
}

/** Focus a field inside a just-opened sheet. Must run synchronously inside the tap handler, otherwise
 *  iOS does not open the keyboard. */
export function focusField(el: HTMLInputElement | HTMLTextAreaElement, select = false) {
  try { el.focus({ preventScroll: true }); } catch { el.focus(); }
  if (select) { try { el.select(); } catch { /* number inputs */ } }
}
