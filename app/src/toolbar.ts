// List toolbar: one row = segmented control / title on the left, round glass icon buttons on the right.
export const ICON = {
  sort: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 6h16M4 12h11M4 18h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M18 14v6m0 0-2.5-2.5M18 20l2.5-2.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  select: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m8 12.2 2.8 2.8L16.2 9.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  check: `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  close: `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,
};
const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

export interface MenuItem { value: string; label: string; active?: boolean }
let openMenu: (() => void) | null = null;
/** Popover anchored under `anchor` (right-aligned); closes on outside tap / Esc / pick. */
export function popMenu(anchor: HTMLElement, items: MenuItem[], onPick: (v: string) => void, title?: string) {
  if (openMenu) { const wasMine = anchor.classList.contains("open"); openMenu(); if (wasMine) return; }
  const m = document.createElement("div");
  m.className = "tb-menu"; m.setAttribute("role", "menu");
  m.innerHTML = (title ? `<div class="tb-menu-t">${esc(title)}</div>` : "") + items.map(i =>
    `<button role="menuitemradio" aria-checked="${!!i.active}" data-v="${esc(i.value)}" class="${i.active ? "on" : ""}"><span>${esc(i.label)}</span><i>${i.active ? ICON.check : ""}</i></button>`).join("");
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.top = `${r.bottom + window.scrollY + 8}px`;
  m.style.right = `${Math.max(8, document.documentElement.clientWidth - r.right)}px`;
  anchor.classList.add("open"); anchor.setAttribute("aria-expanded", "true");
  const close = () => { m.remove(); anchor.classList.remove("open"); anchor.setAttribute("aria-expanded", "false"); document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", key); openMenu = null; };
  const outside = (e: Event) => { if (!m.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); };
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  setTimeout(() => { document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", key); });
  m.querySelectorAll<HTMLButtonElement>("button").forEach(b => b.onclick = () => { close(); onPick(b.dataset.v!); });
  m.querySelector<HTMLElement>("button.on")?.scrollIntoView({ block: "nearest" });
  openMenu = close;
}
export const closeMenus = () => openMenu?.();
