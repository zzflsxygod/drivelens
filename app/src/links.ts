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
