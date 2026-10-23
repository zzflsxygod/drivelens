// SPDX-License-Identifier: AGPL-3.0-or-later
// Public places for users: the open-source main repo (AGPL-3.0-or-later) hosts the install guide
// (per UI language), releases + changelog and issues (feedback).
import { currentLang } from "./i18n";

export const PUBLIC_REPO = "https://github.com/zzflsxygod/drivelens";
/** English is the default page; Chinese / Japanese have their own files. */
export function installGuideUrl(): string {
  const l = currentLang();
  return `${PUBLIC_REPO}/blob/main/docs/install${l === "zh" ? ".zh" : l === "ja" ? ".ja" : ""}.md`;
}
export const RELEASES_URL = `${PUBLIC_REPO}/releases`;
export const ISSUES_URL = `${PUBLIC_REPO}/issues/new/choose`;
/** AGPL-3.0 §13: the app offers its Corresponding Source. */
export const SOURCE_URL = PUBLIC_REPO;
/** Licenses of the npm packages bundled into the app (generated at build time, see vite.config.ts). */
export const THIRD_PARTY_URL = __WEB_BUILD__ ? "/third-party-licenses.txt" : `${__WEB_ORIGIN__}/third-party-licenses.txt`;
