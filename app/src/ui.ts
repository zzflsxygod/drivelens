// v0.12.0: unified glass controls + motion. Upgrades whatever the page renderers put into #view
// (back links → round chevron buttons in a sticky page header, ✎ → pencil chips, native <select> → pill + popover)
// and plays push / pop / tab transitions. Transform + opacity only; prefers-reduced-motion disables it in CSS.
import { ICON } from "./toolbar";

const CHEV_L = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="m14.5 5.5-6.5 6.5 6.5 6.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const PEN = `<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;
const MORE = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="5.5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="18.5" cy="12" r="1.8" fill="currentColor"/></svg>`;
const SHARE = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3.5v11M7.5 8 12 3.5 16.5 8M5 12.5V18a2.5 2.5 0 0 0 2.5 2.5h9A2.5 2.5 0 0 0 19 18v-5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const REFRESH = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4v4.5H15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ---------------- shared popover positioning (v0.14.1) ----------------
// Popovers are position:fixed and clamped to the visible viewport minus safe-area insets, the sticky
// header and the bottom nav. They align with the anchor's left or right edge (whichever side the anchor
// is on), flip above/below by available space, scroll internally when taller than the space, and follow
// the anchor on resize / orientation / keyboard (visualViewport) / scroll.
const POP_GAP = 8, POP_EDGE = 8;
let insetProbe: HTMLElement | null = null;
/** resolved safe-area insets in px (the --sa* vars combine env() with the Android bridge values) */
function insets() {
  if (!insetProbe || !insetProbe.isConnected) {
    insetProbe = document.createElement("div");
    insetProbe.setAttribute("aria-hidden", "true");
    insetProbe.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:var(--sat,0px) var(--sar,0px) var(--sab,0px) var(--sal,0px)";
    document.body.appendChild(insetProbe);
  }
  const cs = getComputedStyle(insetProbe), n = (v: string) => parseFloat(v) || 0;
  return { top: n(cs.paddingTop), right: n(cs.paddingRight), bottom: n(cs.paddingBottom), left: n(cs.paddingLeft) };
}
// (offsetParent is null for position:fixed elements such as the bottom nav, so check the computed style)
const shown = (el: Element | null): el is HTMLElement => {
  if (!el) return false;
  const cs = getComputedStyle(el), r = el.getBoundingClientRect();
  return cs.display !== "none" && cs.visibility !== "hidden" && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
};

/** Place `el` (any parent) next to `anchor`, fully inside the usable viewport. */
export function placePopover(el: HTMLElement, anchor: HTMLElement) {
  const vv = window.visualViewport;
  const vw = vv ? vv.width : document.documentElement.clientWidth, vh = vv ? vv.height : innerHeight;
  const ox = vv ? vv.offsetLeft : 0, oy = vv ? vv.offsetTop : 0;
  const ins = insets();
  const a = anchor.getBoundingClientRect();
  let top = oy + ins.top + POP_EDGE, bottom = oy + vh - ins.bottom - POP_EDGE;
  const left = ox + ins.left + POP_EDGE, right = ox + vw - ins.right - POP_EDGE;
  // keep clear of the sticky header and the bottom nav (unless the anchor itself lives in them)
  const head = document.querySelector("body > header");
  if (shown(head) && !head.contains(anchor)) { const r = head.getBoundingClientRect(); if (r.bottom <= a.top + 1) top = Math.max(top, r.bottom + 4); }
  const nav = document.querySelector("body > nav");
  if (shown(nav) && !nav.contains(anchor)) { const r = nav.getBoundingClientRect(); if (r.top >= a.bottom - 1) bottom = Math.min(bottom, r.top - 4); }

  Object.assign(el.style, { position: "fixed", left: "0px", top: "0px", right: "auto", bottom: "auto", maxWidth: `${Math.max(120, right - left)}px`, maxHeight: "" });
  // a fixed element under a transformed / backdrop-filtered ancestor is positioned relative to that ancestor:
  // measure the real origin with an untransformed probe in the same parent
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;margin:0;padding:0;border:0;visibility:hidden";
  (el.parentElement ?? document.body).appendChild(probe);
  const o = probe.getBoundingClientRect(); probe.remove();

  const cssMax = parseFloat(getComputedStyle(el).maxHeight) || Infinity;   // CSS cap (e.g. min(60vh, 420px))
  const w = Math.min(el.offsetWidth, right - left);
  const natural = Math.min(el.scrollHeight + (el.offsetHeight - el.clientHeight), cssMax);
  const below = bottom - a.bottom - POP_GAP, above = a.top - POP_GAP - top;
  const down = natural <= below || below >= above;
  const space = Math.max(80, down ? below : above);
  const h = Math.min(natural, space);
  // align to the anchor edge on the side of the screen the anchor is on, then clamp
  const alignRight = a.left + a.width / 2 > ox + vw / 2;
  let x = alignRight ? a.right - w : a.left;
  x = Math.min(Math.max(x, left), Math.max(left, right - w));
  let y = down ? a.bottom + POP_GAP : a.top - POP_GAP - h;
  y = Math.min(Math.max(y, top), Math.max(top, bottom - h));
  Object.assign(el.style, { left: `${Math.round(x - o.left)}px`, top: `${Math.round(y - o.top)}px`, maxHeight: `${Math.floor(Math.min(space, cssMax))}px`, overflowY: "auto",
    transformOrigin: `${down ? "top" : "bottom"} ${alignRight ? "right" : "left"}` });
  el.dataset.side = down ? "below" : "above";
}

/** Keep `el` attached to `anchor` until the returned stop() is called (or the popover/anchor disappears). */
export function trackPopover(el: HTMLElement, anchor: HTMLElement, onGone?: () => void) {
  let raf = 0;
  const update = (e?: Event) => {
    if (e?.type === "scroll" && e.target instanceof Node && el.contains(e.target)) return;   // the menu's own scroll
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (!el.isConnected || el.hidden || !anchor.isConnected) { stop(); return; }
      const a = anchor.getBoundingClientRect();
      if (a.bottom < 0 || a.top > innerHeight || a.width === 0) { stop(); onGone?.(); return; }   // anchor scrolled away
      placePopover(el, anchor);
    });
  };
  const vv = window.visualViewport;
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => update()) : null;
  ro?.observe(el); ro?.observe(document.documentElement);
  addEventListener("resize", update); addEventListener("orientationchange", update); addEventListener("scroll", update, true);
  vv?.addEventListener("resize", update); vv?.addEventListener("scroll", update);
  const stop = () => {
    cancelAnimationFrame(raf); ro?.disconnect();
    removeEventListener("resize", update); removeEventListener("orientationchange", update); removeEventListener("scroll", update, true);
    vv?.removeEventListener("resize", update); vv?.removeEventListener("scroll", update);
  };
  placePopover(el, anchor);
  return stop;
}

const escH = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
export interface MenuItem { value: string; label: string; sub?: string; active?: boolean }
let openMenu: (() => void) | null = null;
/** Popover menu anchored to `anchor`; closes on outside tap / Esc / pick / back. */
export function popMenu(anchor: HTMLElement, items: MenuItem[], onPick: (v: string) => void, title?: string) {
  if (openMenu) { const wasMine = anchor.classList.contains("open"); openMenu(); if (wasMine) return; }
  const m = document.createElement("div");
  m.className = "tb-menu"; m.setAttribute("role", "menu");
  m.innerHTML = (title ? `<div class="tb-menu-t">${escH(title)}</div>` : "") + items.map(i =>
    `<button role="menuitemradio" aria-checked="${!!i.active}" data-v="${escH(i.value)}" class="${i.active ? "on" : ""}"><span>${escH(i.label)}${i.sub ? `<small>${escH(i.sub)}</small>` : ""}</span><i>${i.active ? ICON.check : ""}</i></button>`).join("");
  document.body.appendChild(m);
  anchor.classList.add("open"); anchor.setAttribute("aria-expanded", "true");
  const close = () => { stopTrack(); m.remove(); anchor.classList.remove("open"); anchor.setAttribute("aria-expanded", "false"); document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", key); openMenu = null; };
  const stopTrack = trackPopover(m, anchor, () => close());
  const outside = (e: Event) => { if (!m.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); };
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  setTimeout(() => { document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", key); });
  m.querySelectorAll<HTMLButtonElement>("button").forEach(b => b.onclick = () => { close(); onPick(b.dataset.v!); });
  const on = m.querySelector<HTMLElement>("button.on");
  if (on) m.scrollTop = Math.max(0, on.offsetTop - (m.clientHeight - on.offsetHeight) / 2);   // no scrollIntoView: it would scroll the page
  openMenu = close;
}
export const closeMenus = () => openMenu?.();
export const hasOpenMenu = () => openMenu != null;

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
  if (b.dataset.title) {
    const h = document.createElement("h2"); h.className = "ph-title"; h.textContent = b.dataset.title;
    head.appendChild(h); head.appendChild(document.createElement("span")).className = "ph-spacer";
  }
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
  root.querySelectorAll<HTMLElement>(".seg-tabs:not([data-up]), .seg:not([data-up])").forEach(upgradeSeg);
}

// ---- segmented controls: sliding thumb ----
const segItems = (g: HTMLElement) => [...g.children].filter(c => !c.classList.contains("seg-thumb")) as HTMLElement[];
const segKey = (g: HTMLElement) => g.id || segItems(g).map(i => i.dataset.seg || i.dataset.v).join("|");
const lastSegIdx = new Map<string, number>();
let segDir: { dir: "segL" | "segR"; at: number; key: string } | null = null;
function placeThumb(g: HTMLElement, th: HTMLElement, animate: boolean) {
  const items = segItems(g), i = items.findIndex(x => x.classList.contains("on"));
  if (i < 0) { th.style.opacity = "0"; return; }
  const it = items[i];
  if (!animate) th.classList.add("no-anim");
  th.style.opacity = "1"; th.style.width = `${it.offsetWidth}px`; th.style.height = `${it.offsetHeight}px`;
  th.style.transform = `translate(${it.offsetLeft}px, ${it.offsetTop}px)`;
  if (!animate) { void th.offsetWidth; th.classList.remove("no-anim"); }
  lastSegIdx.set(segKey(g), i);
}
function upgradeSeg(g: HTMLElement) {
  g.dataset.up = "1"; g.classList.add("has-thumb");
  const th = document.createElement("i"); th.className = "seg-thumb"; th.setAttribute("aria-hidden", "true");
  g.prepend(th);
  const key = segKey(g), prev = lastSegIdx.get(key);
  const items = segItems(g), cur = items.findIndex(x => x.classList.contains("on"));
  requestAnimationFrame(() => {
    if (prev != null && prev !== cur && items[prev] && !reduce() && g.classList.contains("seg-tabs")) {
      // re-rendered page: start where the previous control's thumb was, then glide
      const o = items[prev]; th.classList.add("no-anim"); th.style.opacity = "1";
      th.style.width = `${o.offsetWidth}px`; th.style.height = `${o.offsetHeight}px`; th.style.transform = `translate(${o.offsetLeft}px, ${o.offsetTop}px)`;
      void th.offsetWidth; th.classList.remove("no-anim");
      requestAnimationFrame(() => placeThumb(g, th, true));
    } else placeThumb(g, th, false);
  });
  new MutationObserver(rs => { if (rs.some(r => r.target !== th)) placeThumb(g, th, true); }).observe(g, { subtree: true, attributes: true, attributeFilter: ["class"] });
  new ResizeObserver(() => placeThumb(g, th, false)).observe(g);
}
const SEG_TARGET: Record<string, string> = { "rp-seg": "#rp-daily" };
function onSegClick(item: HTMLElement) {
  const g = item.parentElement as HTMLElement;
  const items = segItems(g), to = items.indexOf(item), from = items.findIndex(x => x.classList.contains("on"));
  if (to < 0 || to === from) return;
  const dir = to > from ? "segR" : "segL";
  if (g.classList.contains("seg-tabs")) {
    segDir = { dir, at: Date.now(), key: segKey(g) };
    ghostToolbar(g.closest(".list-toolbar"));
    if (window.scrollY > 0) window.scrollTo(0, 0);   // each segment opens at its top
  } else {
    const sel = SEG_TARGET[g.id]; if (!sel) return;
    setTimeout(() => { const el = document.querySelector<HTMLElement>(sel); if (el) playOn(el, dir); });
  }
}
/** toolbar buttons that vanish on a segment switch fade/scale out as fixed ghosts (no layout jump) */
function ghostToolbar(tb: Element | null) {
  if (!tb || reduce()) return;
  tb.querySelectorAll<HTMLElement>(".tb-right .tb-btn").forEach(b => {
    const r = b.getBoundingClientRect(), c = b.cloneNode(true) as HTMLElement;
    c.removeAttribute("id"); c.classList.add("tb-ghost");
    Object.assign(c.style, { position: "fixed", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, margin: "0", zIndex: "950" });
    document.body.appendChild(c); setTimeout(() => c.remove(), 260);
    (b as any)._ghost = c;
  });
}
function playOn(el: HTMLElement, kind: string) {
  if (reduce()) return;
  el.classList.remove("mv-segL", "mv-segR"); void el.offsetWidth; el.classList.add(`mv-${kind}`);
  el.addEventListener("animationend", () => el.classList.remove(`mv-${kind}`), { once: true });
}

// ---- motion ----
type Dir = "push" | "pop" | "tab";
let pending: { dir: Dir; at: number } | null = null;
const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const PUSH_SEL = ".card, [data-drive], [data-charge], [data-report], [data-battery], [data-journey], [data-id], .jcard, .month-card";

export function initUI(view: HTMLElement) {
  document.addEventListener("click", e => {
    const el = e.target as HTMLElement;
    if (el.closest(".msw [data-m]")) return;   // the report animates its own month swap
    const segItem = el.closest(".seg-tabs > button, .seg > span") as HTMLElement | null;
    if (segItem) { onSegClick(segItem); return; }
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
    if (segDir && now - segDir.at < 1500) {
      // segment switch: toolbar stays put, the content below slides in from the segment's side
      [...view.children].forEach(c => { if (!c.matches(".list-toolbar, .page-head, .msw")) playOn(c as HTMLElement, segDir!.dir); });
      view.querySelectorAll<HTMLElement>(".list-toolbar .tb-right .tb-btn").forEach(b => b.classList.add("tb-pop"));
      segDir = null; lastAnim = now; return;
    }
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
