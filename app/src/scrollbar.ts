// SPDX-License-Identifier: AGPL-3.0-or-later
// Overlay scrollbar: the native one is hidden everywhere (it took layout width on Windows), and a thin fixed
// thumb for the page scroll shows while scrolling / hovering the right edge, then fades out. Draggable.
export function initOverlayScrollbar() {
  // touch devices keep their native overlay scrollbar (it takes no layout width there)
  if (document.documentElement.classList.contains("touch")) return;
  const bar = document.createElement("div");
  bar.className = "osb"; bar.setAttribute("aria-hidden", "true");
  bar.innerHTML = `<i></i>`;
  document.body.appendChild(bar);
  const root = document.scrollingElement || document.documentElement;
  let hideT = 0, dragging = false, hover = false, raf = 0;
  const geom = () => {
    const vh = innerHeight, sh = root.scrollHeight, max = sh - vh;
    const h = Math.max(36, Math.round(vh * vh / Math.max(sh, 1)));
    return { vh, max, h, y: max > 0 ? Math.round((vh - h) * (root.scrollTop / max)) : 0 };
  };
  const paint = () => {
    raf = 0;
    const g = geom();
    bar.classList.toggle("none", g.max <= 1);
    bar.style.height = `${g.h}px`;
    bar.style.transform = `translateY(${g.y}px)`;
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };
  const show = () => {
    schedule(); bar.classList.add("on");
    clearTimeout(hideT);
    if (!dragging && !hover) hideT = window.setTimeout(() => bar.classList.remove("on"), 1000);
  };
  addEventListener("scroll", show, { passive: true });
  addEventListener("resize", schedule);
  new ResizeObserver(schedule).observe(document.body);
  // hover near the right edge (mouse only) reveals it
  addEventListener("pointermove", e => {
    if (e.pointerType !== "mouse") return;
    const near = innerWidth - e.clientX < 18;
    if (near !== hover) { hover = near; bar.classList.toggle("hot", near); if (near) show(); else show(); }
  }, { passive: true });
  // drag
  let startY = 0, startTop = 0;
  bar.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    e.preventDefault(); dragging = true; bar.classList.add("drag", "on");
    bar.setPointerCapture(e.pointerId); startY = e.clientY; startTop = root.scrollTop; clearTimeout(hideT);
  });
  bar.addEventListener("pointermove", e => {
    if (!dragging) return;
    const g = geom(); const track = g.vh - g.h;
    if (track > 0) root.scrollTop = startTop + (e.clientY - startY) * g.max / track;
  });
  const end = () => { if (!dragging) return; dragging = false; bar.classList.remove("drag"); show(); };
  bar.addEventListener("pointerup", end); bar.addEventListener("pointercancel", end);
  paint();
}
