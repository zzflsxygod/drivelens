// SPDX-License-Identifier: AGPL-3.0-or-later
// v0.17.0 line icons (24×24, currentColor) — replace the emoji that used to decorate the UI.
// ic("bolt") → inline <svg class="ic">; size follows the font size (1.15em) unless given.
const P: Record<string, string> = {
  home: `<path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/>`,
  route: `<circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8.2 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.8"/>`,
  bolt: `<path d="M13 3 5.5 13.2h5.6L10.5 21 18.5 10.6h-5.7z"/>`,
  gear: `<circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.5-2.4 1a7.5 7.5 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.5 7.5 0 0 0 7 6.5l-2.4-1-2 3.5 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.5 2.4-1a7.5 7.5 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.5 7.5 0 0 0 2.6-1.5l2.4 1 2-3.5z"/>`,
  pin: `<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>`,
  battery: `<rect x="3" y="7" width="16" height="10" rx="2.2"/><path d="M21.5 10.5v3"/><path d="M6.5 10.5v3M9.5 10.5v3"/>`,
  gauge: `<path d="M4.5 17a8.5 8.5 0 1 1 15 0"/><path d="m12 13 3.5-4"/><circle cx="12" cy="13" r="1.2"/>`,
  clock: `<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>`,
  compass: `<circle cx="12" cy="12" r="8.5"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>`,
  ruler: `<path d="M3.5 15.5 15.5 3.5l5 5-12 12z"/><path d="m7 12 2 2M10 9l2 2M13 6l2 2"/>`,
  plug: `<path d="M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0z"/><path d="M12 16v5"/>`,
  coin: `<circle cx="12" cy="12" r="8.5"/><path d="M14.8 9.2c-.5-.9-1.6-1.4-2.8-1.4-1.6 0-2.8.8-2.8 2s1.1 1.7 2.8 2.1 2.8 1 2.8 2.2-1.2 2-2.8 2c-1.3 0-2.4-.6-2.9-1.5M12 6v1.8M12 16.2V18"/>`,
  flag: `<path d="M5.5 21V4M5.5 4.5h11l-2 3.5 2 3.5h-11"/>`,
  alert: `<path d="M12 3.5 2.8 19.5h18.4z"/><path d="M12 10v4.2M12 16.8v.1"/>`,
  check: `<circle cx="12" cy="12" r="8.5"/><path d="m8.2 12.3 2.6 2.6 5-5.2"/>`,
  info: `<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.1"/>`,
  globe: `<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.4 5.2 3.4 8.5s-1 6.1-3.4 8.5c-2.4-2.4-3.4-5.2-3.4-8.5s1-6.1 3.4-8.5z"/>`,
  book: `<path d="M5 4.5h10.5A2.5 2.5 0 0 1 18 7v13H7.5A2.5 2.5 0 0 1 5 17.5z"/><path d="M5 17.5A2.5 2.5 0 0 1 7.5 15H18M9 8.5h5"/>`,
  box: `<path d="m12 3 8 4.2v9.6L12 21l-8-4.2V7.2z"/><path d="m4 7.2 8 4.3 8-4.3M12 11.5V21"/>`,
  chat: `<path d="M4.5 5.5h15v10h-8.5l-4.5 3.5v-3.5h-2z"/>`,
  bell: `<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5z"/><path d="M10 20.5h4"/>`,
  bellOff: `<path d="M8.6 6.4A5.5 5.5 0 0 1 17.5 11v4M6.5 10.8v5.7L5 18h11M10 20.5h4M3.5 3.5l17 17"/>`,
  chart: `<path d="M4.5 19.5h15"/><path d="M7 16v-4M11 16V8M15 16v-6M19 16V5.5"/>`,
  phone: `<rect x="7" y="2.8" width="10" height="18.4" rx="2.2"/><path d="M12 8v6m0 0-2.4-2.4M12 14l2.4-2.4"/>`,
  spark: `<path d="M12 3.5c.6 4.4 2.1 5.9 6.5 6.5-4.4.6-5.9 2.1-6.5 6.5-.6-4.4-2.1-5.9-6.5-6.5 4.4-.6 5.9-2.1 6.5-6.5z"/><path d="M18.5 15.5c.3 1.9.9 2.5 2.8 2.8-1.9.3-2.5.9-2.8 2.8-.3-1.9-.9-2.5-2.8-2.8 1.9-.3 2.5-.9 2.8-2.8z"/>`,
  lock: `<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>`,
  ban: `<circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/>`,
  wrench: `<path d="M14.5 4a4.5 4.5 0 0 0 4.9 6l-8.2 8.2a2.1 2.1 0 0 1-3-3L16.4 7a4.5 4.5 0 0 1-1.9-3z"/>`,
  up: `<circle cx="12" cy="12" r="8.5"/><path d="M12 16.5v-9M8.3 11 12 7.3l3.7 3.7"/>`,
  sun: `<circle cx="12" cy="12" r="3.8"/><path d="M12 2.8v2.2M12 19v2.2M2.8 12H5M19 12h2.2M5.5 5.5 7 7M17 17l1.5 1.5M5.5 18.5 7 17M17 7l1.5-1.5"/>`,
  rain: `<path d="M7 15.5a4.5 4.5 0 0 1 .4-9 5.5 5.5 0 0 1 10.3 1.6A3.7 3.7 0 0 1 17 15.5z"/><path d="m8.5 18.5-1 2M12.5 18.5l-1 2M16.5 18.5l-1 2"/>`,
  speed: `<path d="M3.8 16.5a8.5 8.5 0 1 1 16.4 0"/><path d="m12 13 5-5"/><circle cx="12" cy="13" r="1.3"/><path d="M6.5 13h1M12 6.8v1"/>`,
  image: `<rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><circle cx="9" cy="9.5" r="1.6"/><path d="m4 17 5-4.5 4 3.5 3-2.5 4 3.5"/>`,
  camera: `<path d="M4 8h3.2l1.6-2.5h6.4L16.8 8H20v11H4z"/><circle cx="12" cy="13" r="3.4"/>`,
  trash: `<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>`,
  coffee: `<path d="M4.5 9h12v5.5a5 5 0 0 1-5 5h-2a5 5 0 0 1-5-5z"/><path d="M16.5 10.5h1.5a2.5 2.5 0 0 1 0 5h-1.6M8 3.5v2.5M12 3.5v2.5"/>`,
  pause: `<circle cx="12" cy="12" r="8.5"/><path d="M10 9v6M14 9v6"/>`,
  car: `<path d="M5 16.5h14M6.5 16.5V19M17.5 16.5V19M4 13.5l1.6-4.6A2 2 0 0 1 7.5 7.5h9a2 2 0 0 1 1.9 1.4L20 13.5v3H4z"/>`,
  code: `<path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5M13.5 4.5l-3 15"/>`,
  scale: `<path d="M12 4v16M7.5 20h9M4.5 7.5h15M6.5 7.5 4 14a2.6 2.6 0 0 0 5 0zM17.5 7.5 15 14a2.6 2.6 0 0 0 5 0z"/>`,
  ext: `<path d="M13.5 4.5h6v6M19.5 4.5l-8 8M17 14v5.5H4.5V7H10"/>`,
};
export type IconName = keyof typeof P;
export function ic(name: string, cls = ""): string {
  const p = P[name] ?? P.info;
  return `<svg class="ic${cls ? " " + cls : ""}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
}
/** Strip a leading emoji (+ space) from a translated string — the UI draws its own icons now. */
export const noEmoji = (s: string) => s.replace(/^(?:\p{Extended_Pictographic}|\uFE0F|\u200D)+\s*/u, "");
