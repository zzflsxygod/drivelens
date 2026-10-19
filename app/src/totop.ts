import { t } from "./i18n";
// Floating "back to top" button + tap-active-tab-to-top.
let jumpedReset: (() => boolean) | null = null;
/** infinite lists register a handler that resets a month-jumped list to the newest records (returns true if it did) */
export function setJumpedReset(fn: (() => boolean) | null) { jumpedReset = fn; }
export function isJumped() { return peek(); }
let peek = () => false;
export function setJumpedPeek(fn: () => boolean) { peek = fn; }

export function backToTop() {
  if (peek() && jumpedReset?.()) return;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

export function initBackToTop() {
  const b = document.createElement("button");
  b.className = "totop"; b.setAttribute("aria-label", t("top.top")); b.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 19V5.5M6 11.5l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`; b.tabIndex = -1;
  b.onclick = backToTop;
  document.body.appendChild(b);
  const upd = () => {
    const show = window.scrollY > innerHeight * 1.5 || (peek() && window.scrollY > innerHeight * 0.5);
    b.classList.toggle("show", show); b.tabIndex = show ? 0 : -1; b.setAttribute("aria-hidden", String(!show)); b.title = peek() ? t("top.latest") : t("top.top");
  };
  addEventListener("scroll", upd, { passive: true });
  addEventListener("resize", upd);
}
