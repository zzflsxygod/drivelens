// SPDX-License-Identifier: AGPL-3.0-or-later
// Read design tokens (CSS custom properties) for canvas / MapLibre / inline SVG that can't use var() directly.
export function cssVar(name: string, fallback = ""): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
export const isDarkUI = () => document.documentElement.dataset.theme === "dark";
