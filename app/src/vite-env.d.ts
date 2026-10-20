/// <reference types="vite/client" />
declare const __APP_VERSION__: string;
/** true for `npm run build:web` (PWA bundle in dist-web/), false for the Tauri apps. */
declare const __WEB_BUILD__: boolean;
/** Origin of the official hosted web app (VITE_WEB_ORIGIN at build time). */
declare const __WEB_ORIGIN__: string;
interface ImportMetaEnv {
  /** Donation page (Buy Me a Coffee / Ko-fi / Stripe Payment Link …). Empty → the Settings support card is hidden. */
  readonly VITE_DONATE_URL?: string;
  /** "1" → show the support card only in the web build (e.g. for store builds whose rules forbid external payment links). */
  readonly VITE_DONATE_WEB_ONLY?: string;
}
