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
  b.className = "totop"; b.setAttribute("aria-label", "回到顶部"); b.textContent = "↑"; b.hidden = true;
  b.onclick = backToTop;
  document.body.appendChild(b);
  const upd = () => {
    const show = window.scrollY > innerHeight * 1.5 || (peek() && window.scrollY > innerHeight * 0.5);
    b.hidden = !show; b.title = peek() ? "回到最新记录" : "回到顶部";
  };
  addEventListener("scroll", upd, { passive: true });
  addEventListener("resize", upd);
}
