// Demo Mode controller (main bundle, tiny). The dataset + mock server live in ./demo/ and are lazy-loaded
// on the first API call made while demo mode is active — nothing is downloaded otherwise.
//  - flag in localStorage; the real server URL/token stay untouched in drivelens-settings
//  - window.fetch is wrapped: requests to DEMO_URL are answered locally, everything else (map tiles) passes through
import { FEATURE_LEVEL } from "./version";
import { LATEST_SERVER } from "./setup";

export const DEMO_URL = "https://demo.drivelens.invalid";
export const DEMO_TOKEN = "demo-mode-token-not-a-secret-0000000";
export const DEMO_CAR = 901;
const FLAG = "drivelens-demo";
const LEGACY_PREV_CAR = "drivelens-demo-prev-car";   // v0.13.0
const STATE = "drivelens-demo-state";
const NS = "drivelens-demo~";

export function isDemo(): boolean { try { return localStorage.getItem(FLAG) === "1"; } catch { return false; } }
/**
 * Storage namespace for per-server UI state (selected car, home snapshot, list caches, battery baseline …).
 * Demo mode gets its own keys, so real cached data can never be shown in demo (or sent to the demo server) and vice versa.
 */
export const skey = (key: string) => isDemo() ? NS + key.replace(/^drivelens-/, "") : key;

type Srv = typeof import("./demo/server");
let srv: Promise<Srv> | null = null;
const load = () => srv ??= import("./demo/server").then(m => { m.configure(Math.max(...Object.values(FEATURE_LEVEL)), LATEST_SERVER); m.initDemo(Date.now()); return m; });

let installed = false;
export function installDemoFetch() {
  if (installed) return; installed = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(DEMO_URL)) return orig(input, init);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    let body: unknown;
    if (typeof init?.body === "string") { try { body = JSON.parse(init.body); } catch { body = undefined; } }
    const m = await load();
    await new Promise(r => setTimeout(r, 25 + Math.random() * 45));   // feels like a (fast) network
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const r = m.handle(method, url.slice(DEMO_URL.length) || "/", body);
    return r.status === 204 ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  };
}

/** Removes everything the demo stored (its namespace, plus keys v0.13.0 wrote under car id 901 in the shared namespace). */
function purgeDemoCaches() {
  const drop: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (k.startsWith(NS) || k === STATE || k === LEGACY_PREV_CAR || k === `drivelens-home-${DEMO_CAR}` || (k.startsWith("drivelens-list-") && k.endsWith(`:${DEMO_CAR}`))) drop.push(k);
  }
  drop.forEach(k => localStorage.removeItem(k));
  try {
    const m = JSON.parse(localStorage.getItem("drivelens-battery-baseline") || "{}");
    if (m && DEMO_CAR in m) { delete m[DEMO_CAR]; localStorage.setItem("drivelens-battery-baseline", JSON.stringify(m)); }
  } catch { /* ignore */ }
}
/** Reload into a clean URL (no ?api= / ?view= of the previous session). */
const restart = () => location.replace(location.pathname);

export function enterDemo() {
  purgeDemoCaches();                      // a fresh demo every time
  localStorage.setItem(FLAG, "1");
  restart();
}
/** Back to the configured server (or the setup wizard when there is none); demo edits are discarded.
 *  Real keys (selected car, caches) were never touched while in demo, so the original car comes back. */
export function exitDemo() {
  localStorage.removeItem(FLAG);
  purgeDemoCaches();
  restart();
}
/** Data credits for the demo dataset (ODbL requires attribution of the OSM-derived routes). */
export const DEMO_CREDIT = "Demo routes © OpenStreetMap contributors (ODbL), routed with OSRM · elevation © Copernicus DEM via Open-Meteo (CC BY 4.0) · weather is synthetic";

if (isDemo()) installDemoFetch();
