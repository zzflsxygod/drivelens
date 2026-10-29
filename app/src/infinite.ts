// SPDX-License-Identifier: AGPL-3.0-or-later
import { skey } from "./demo";
import { ic } from "./icons";
import { setJumpedPeek, setJumpedReset } from "./totop";
// Infinite list with keyset paging (api_level ≥ 10), sticky month headers, month jump, first-page cache
// and scroll restore. Older servers: one request with limit=100 (no paging).
import { api } from "./api";
import { t, monthLabel } from "./i18n";
import { ICON } from "./toolbar";
import { popMenu, closeMenus } from "./ui";
export { monthLabel };

export interface MonthRow { month: string; drive_count: number; distance_km: number; duration_min: number; charge_count: number; energy_added_kwh: number }
interface Page<T> { items: T[]; next_cursor: string | null }

export interface ListState<T> {
  key: string; items: T[]; cursor: string | null; done: boolean; scrollY: number;
  /** month jump: list starts before this month (newer items not loaded) */
  jumpedTo: string | null; months: MonthRow[] | null;
}
const states = new Map<string, ListState<unknown>>();
export function getState<T>(key: string): ListState<T> | undefined { return states.get(key) as ListState<T> | undefined; }
export function dropState(key: string) { states.delete(key); }

export interface InfOpts<T> {
  container: HTMLElement;        // where cards go
  key: string;                   // e.g. "drives:1"
  path: string;                  // e.g. "/api/drives?car_id=1"
  paging: boolean;               // server supports keyset paging
  carId: number | null;          // for /months
  monthsSupported: boolean;
  restore: boolean;              // back from a detail page → keep items + scroll position
  dateOf(item: T): string;
  card(item: T): string;
  header(month: string, m: MonthRow | undefined, loaded: T[]): string;
  bind(root: HTMLElement): void; // attach click handlers to newly added cards
  empty: string;
  /** toolbar row (right side) to put the month-jump button in; default: own row above the list */
  toolbar?: HTMLElement;
  /** when false, hide the month-jump control (e.g. while place-searching) */
  allowJump?: boolean;
}

const PAGE = 50;
const ym = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
const skRows = () => Array.from({ length: 3 }, () => `<div class="card sk-card"><span class="sk" style="width:70%;height:16px"></span><br><span class="sk" style="width:45%;height:14px"></span><br><span class="sk" style="width:85%;height:14px"></span></div>`).join("");
const cacheKey = (k: string) => skey(`drivelens-list-${k}`);

export function infiniteList<T>(o: InfOpts<T>) {
  let st = (o.restore && getState<T>(o.key)) || undefined;
  const fresh = !st;
  if (!st) {
    st = { key: o.key, items: [], cursor: null, done: false, scrollY: 0, jumpedTo: null, months: null };
    states.set(o.key, st as ListState<unknown>);
  }
  const S = st;
  const root = o.container;
  closeMenus();
  root.innerHTML = `${o.toolbar ? "" : `<div class="list-toolbar"><div></div><div class="tb-right" id="tb-own"></div></div>`}
    <div id="newer"></div><div id="items"></div><div id="sentinel"></div><div id="list-end"></div>`;
  const itemsEl = root.querySelector<HTMLElement>("#items")!, endEl = root.querySelector<HTMLElement>("#list-end")!;
  const sentinel = root.querySelector<HTMLElement>("#sentinel")!;
  // month jump: round icon button + popover (Latest / months), checkmark on the active one
  const host = o.toolbar ?? root.querySelector<HTMLElement>("#tb-own")!;
  host.querySelector(".tb-jump")?.remove();
  const jumpBtn = document.createElement("button");
  jumpBtn.className = "tb-btn tb-jump"; jumpBtn.innerHTML = ICON.sort;
  jumpBtn.title = t("list.jump"); jumpBtn.setAttribute("aria-label", t("list.jump")); jumpBtn.setAttribute("aria-haspopup", "menu");
  host.prepend(jumpBtn);
  let monthList: string[] = [];
  const jump = { set value(v: string) { jumpBtn.classList.toggle("on", !!v); }, hidden: false };
  let lastMonth = "";
  let loading = false;
  let alive = true;

  const monthOf = (m: string) => S.months?.find(x => x.month === m);
  const append = (items: T[]) => {
    let html = "";
    for (const it of items) {
      const m = ym(o.dateOf(it));
      if (m !== lastMonth) { lastMonth = m; html += `<div class="month-h" data-month="${m}">${o.header(m, monthOf(m), S.items.filter(x => ym(o.dateOf(x)) === m))}</div>`; }
      html += o.card(it);
    }
    const tmp = document.createElement("div"); tmp.innerHTML = html;
    const nodes = [...tmp.children] as HTMLElement[];
    nodes.forEach(n => itemsEl.appendChild(n));
    o.bind(itemsEl);
  };
  /** refresh month header texts (when totals are computed from loaded items) */
  const refreshHeaders = () => itemsEl.querySelectorAll<HTMLElement>(".month-h").forEach(h => {
    const m = h.dataset.month!; h.innerHTML = o.header(m, monthOf(m), S.items.filter(x => ym(o.dateOf(x)) === m));
  });
  const renderEnd = () => {
    endEl.innerHTML = S.done ? (S.items.length ? `<div class="list-end">${t("list.end")}</div>` : `<div class="empty">${ic("route")}<span>${o.empty}</span></div>`) : skRows();
    root.querySelector<HTMLElement>("#newer")!.innerHTML = S.jumpedTo
      ? `<button class="ghost small newer-btn">${t("list.newer", { m: monthLabel(S.jumpedTo) })}</button>` : "";
    const nb = root.querySelector<HTMLElement>(".newer-btn"); if (nb) nb.onclick = () => reset(null);
  };

  const url = () => {
    if (!o.paging) return `${o.path}&limit=100`;
    return `${o.path}&limit=${PAGE}&paged=true${S.cursor ? `&before=${encodeURIComponent(S.cursor)}` : ""}`;
  };
  const loadMore = async () => {
    if (loading || S.done || !alive) return;
    loading = true;
    let failed = false;
    try {
      const first = S.items.length === 0 && !S.jumpedTo;
      let items: T[], next: string | null;
      if (o.paging) { const p = await api<Page<T>>(url()); items = p.items; next = p.next_cursor; }
      else { items = await api<T[]>(url()); next = null; }
      if (!alive) return;
      if (first) {
        try { localStorage.setItem(cacheKey(o.key), JSON.stringify({ items, next })); } catch { /* quota */ }
        // replace cached first page
        if (itemsEl.childElementCount) { itemsEl.innerHTML = ""; lastMonth = ""; S.items = []; }
      }
      S.items.push(...items); S.cursor = next; S.done = !next;
      append(items);
      if (!S.months) refreshHeaders();
      renderEnd();
    } catch (e) {
      failed = true;
      endEl.innerHTML = `<div class="error card-error">${ic("alert")} ${String((e as Error).message).replace(/[<>&]/g, "")} <button class="retry">${t("common.retry")}</button></div>`;
      (endEl.querySelector(".retry") as HTMLElement).onclick = () => { endEl.innerHTML = skRows(); loadMore(); };
    } finally { loading = false; }
    // keep filling if the sentinel is still visible (not after an error: that waits for "retry", otherwise
    // a persistent error such as 401 / offline would retry in a tight loop)
    if (!failed && alive && !S.done && sentinel.getBoundingClientRect().top < innerHeight + 600) loadMore();
  };

  const reset = (month: string | null) => {
    S.items = []; S.done = false; S.jumpedTo = month; lastMonth = ""; itemsEl.innerHTML = "";
    // cursor: start of the month after `month`, in local time → items of `month` and older
    if (month) { const [y, m] = month.split("-").map(Number); S.cursor = new Date(y, m, 1).toISOString(); } else S.cursor = null;
    jump.value = month ?? "";
    window.scrollTo(0, 0); renderEnd(); loadMore();
  };

  // month picker + totals
  const fillJump = () => {
    monthList = S.months?.map(m => m.month) ?? [...new Set(S.items.map(x => ym(o.dateOf(x))))];
    jump.value = S.jumpedTo ?? "";
  };
  jumpBtn.onclick = () => { fillJump(); popMenu(jumpBtn,
    [{ value: "", label: t("list.latest"), active: !S.jumpedTo }, ...monthList.map(m => ({ value: m, label: monthLabel(m), active: S.jumpedTo === m }))],
    v => reset(v || null), t("list.jump")); };
  if (!o.paging || o.allowJump === false) jumpBtn.hidden = true;
  if (o.monthsSupported && o.carId != null && !S.months) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    api<MonthRow[]>(`/api/cars/${o.carId}/months?tz=${encodeURIComponent(tz)}`).then(m => { if (!alive) return; S.months = m; fillJump(); refreshHeaders(); }).catch(() => { /* totals from loaded items */ });
  }

  // initial render
  if (!fresh && S.items.length) {
    append(S.items); renderEnd(); fillJump();
    requestAnimationFrame(() => window.scrollTo(0, S.scrollY));
  } else {
    const cached = (() => { try { return JSON.parse(localStorage.getItem(cacheKey(o.key)) || "null"); } catch { return null; } })();
    if (cached?.items?.length) append(cached.items as T[]);   // instant; replaced when the network answers
    renderEnd(); fillJump(); loadMore();
  }

  setJumpedPeek(() => alive && itemsEl.isConnected && !!S.jumpedTo);
  setJumpedReset(() => { if (!alive || !itemsEl.isConnected || !S.jumpedTo) return false; reset(null); return true; });
  const io = new IntersectionObserver(es => { if (!itemsEl.isConnected) return cleanup(); if (es.some(e => e.isIntersecting)) loadMore(); }, { rootMargin: "600px" });
  io.observe(sentinel);
  // remember the scroll position while the list is on screen (ignored once a detail page replaced it)
  const onScroll = () => { if (!itemsEl.isConnected) return cleanup(); S.scrollY = window.scrollY; };
  function cleanup() { alive = false; io.disconnect(); removeEventListener("scroll", onScroll); }
  addEventListener("scroll", onScroll, { passive: true });
  return {
    state: S,
    rebind() { o.bind(itemsEl); },
    /** call before navigating to a detail page */
    leave() { S.scrollY = window.scrollY; cleanup(); },
  };
}
