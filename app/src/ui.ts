// v0.12.0: unified glass controls + motion. Upgrades whatever the page renderers put into #view
// (back links → round chevron buttons in a sticky page header, ✎ → pencil chips, native <select> → pill + popover)
// and plays push / pop / tab transitions. Transform + opacity only; prefers-reduced-motion disables it in CSS.
import { ICON, popMenu } from "./toolbar";

const CHEV_L = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="m14.5 5.5-6.5 6.5 6.5 6.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const PEN = `<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;
const MORE = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="5.5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="18.5" cy="12" r="1.8" fill="currentColor"/></svg>`;
const SHARE = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3.5v11M7.5 8 12 3.5 16.5 8M5 12.5V18a2.5 2.5 0 0 0 2.5 2.5h9A2.5 2.5 0 0 0 19 18v-5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const REFRESH = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4v4.5H15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const label = (s: string | null) => (s ?? "").replace(/^[←‹<]\s*/, "").trim();

function upgradeBack(b: HTMLButtonElement) {
  b.dataset.up = "1";
  const txt = label(b.textContent);
  b.classList.add("tb-btn", "back-btn");
  b.setAttribute("aria-label", txt); b.title = txt;
  b.innerHTML = CHEV_L;
  const par = b.parentElement!;
  if (par.classList.contains("jtop")) { par.classList.add("page-head"); return; }
  const head = document.createElement("div"); head.className = "page-head";
  par.insertBefore(head, b); head.appendChild(b);
}

function upgradeSelect(s: HTMLSelectElement) {
  s.dataset.up = "1";
  const p = document.createElement("button"); p.type = "button"; p.className = "sel-pill"; p.setAttribute("aria-haspopup", "menu");
  if (s.id) p.dataset.for = s.id;
  const lab = s.getAttribute("aria-label") || s.closest("label")?.firstChild?.textContent?.trim() || "";
  if (lab) p.setAttribute("aria-label", lab);
  const sync = () => { p.innerHTML = `<span>${s.options[s.selectedIndex]?.text ?? ""}</span>${ICON.chev}`; p.disabled = s.disabled; };
  sync(); s.addEventListener("change", sync);
  s.classList.add("sel-native"); s.tabIndex = -1; s.setAttribute("aria-hidden", "true");
  s.after(p);
  p.onclick = e => { e.preventDefault(); sync();
    popMenu(p, [...s.options].map(o => ({ value: o.value, label: o.text, active: o.selected })), v => {
      if (s.value === v) return; s.value = v; sync(); s.dispatchEvent(new Event("change", { bubbles: true })); s.dispatchEvent(new Event("input", { bubbles: true }));
    }, lab || undefined); };
  // programmatic `select.value = …` after render: resync on the next frame(s)
  requestAnimationFrame(sync); setTimeout(sync, 300);
}

export function enhance(root: ParentNode) {
  root.querySelectorAll<HTMLButtonElement>("button.back:not([data-up])").forEach(upgradeBack);
  root.querySelectorAll<HTMLElement>(".pen:not([data-up])").forEach(p => { p.dataset.up = "1"; p.innerHTML = PEN; p.setAttribute("role", "button"); });
  root.querySelectorAll<HTMLButtonElement>(".icon-btn:not([data-up])").forEach(b => {
    b.dataset.up = "1"; b.classList.add("tb-btn");
    const c = b.textContent?.trim();
    if (c === "⋯") b.innerHTML = MORE; else if (c === "📤") b.innerHTML = SHARE; else if (c === "⟳") b.innerHTML = REFRESH;
  });
  root.querySelectorAll<HTMLSelectElement>("select:not([data-up]):not(#car)").forEach(upgradeSelect);
}

// ---- motion ----
type Dir = "push" | "pop" | "tab";
let pending: { dir: Dir; at: number } | null = null;
const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const PUSH_SEL = ".card, [data-drive], [data-charge], [data-report], [data-battery], [data-journey], [data-id], .jcard, .month-card";

export function initUI(view: HTMLElement) {
  document.addEventListener("click", e => {
    const el = e.target as HTMLElement;
    if (el.closest(".back")) pending = { dir: "pop", at: Date.now() };
    else if (el.closest("nav button")) pending = { dir: "tab", at: Date.now() };
    else if (el.closest("#view") && el.closest(PUSH_SEL) && !el.closest(".sel-on, .selecting")) pending = { dir: "push", at: Date.now() };
  }, true);
  let lastAnim = 0;
  const mo = new MutationObserver(recs => {
    enhance(view);
    const replaced = recs.some(r => r.target === view && r.type === "childList" && r.removedNodes.length > 0);
    if (!replaced) return;
    const now = Date.now();
    if (pending && now - pending.at < 1500) {
      // a push that only rendered "loading…" and then the real page stays one transition
      if (pending.dir === "push" && view.querySelector(".back") == null && view.children.length <= 1) { play(view, "fade"); return; }
      play(view, pending.dir); pending = null; lastAnim = now; return;
    }
    if (now - lastAnim < 1600) play(view, "fade");   // skeleton / loading → content
  });
  mo.observe(view, { childList: true, subtree: true });
  // dialogs / setup wizard live outside #view
  new MutationObserver(recs => recs.forEach(r => r.addedNodes.forEach(n => { if (n instanceof HTMLElement && !n.classList.contains("tb-menu")) enhance(n); })))
    .observe(document.body, { childList: true });
  enhance(document.body);
}

function play(view: HTMLElement, kind: Dir | "fade") {
  if (reduce()) return;
  view.classList.remove("mv-push", "mv-pop", "mv-tab", "mv-fade");
  void view.offsetWidth;
  view.classList.add(`mv-${kind}`);
  view.addEventListener("animationend", () => view.classList.remove(`mv-${kind}`), { once: true });
  stagger(view);
}

function stagger(view: HTMLElement) {
  if (reduce()) return;
  let i = 0;
  view.querySelectorAll<HTMLElement>(":scope > .card, :scope > .pane, :scope > .grid > div, :scope > * > .card, .hero-card").forEach(el => {
    if (el.dataset.st || i > 10) return;
    el.dataset.st = "1"; el.style.setProperty("--i", String(i++)); el.classList.add("st-in");
  });
}
