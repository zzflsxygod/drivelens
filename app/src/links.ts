// Public places for users (the source repo is private). Everything user-facing links to the public
// distribution repo: install guide (per UI language), releases (installers + changelog), issues (feedback).
import { currentLang } from "./i18n";

export const PUBLIC_REPO = "https://github.com/zzflsxygod/drivelens-releases";
/** English is the default page; Chinese / Japanese have their own files. */
export function installGuideUrl(): string {
  const l = currentLang();
  return `${PUBLIC_REPO}/blob/main/docs/install${l === "zh" ? ".zh" : l === "ja" ? ".ja" : ""}.md`;
}
export const RELEASES_URL = `${PUBLIC_REPO}/releases`;
export const ISSUES_URL = `${PUBLIC_REPO}/issues/new/choose`;
