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
const PREV_CAR = "drivelens-demo-prev-car";
const STATE = "drivelens-demo-state";
const LAST_CAR = "drivelens-last-car";

export function isDemo(): boolean { try { return localStorage.getItem(FLAG) === "1"; } catch { return false; } }

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

/** Removes everything the demo cached under its own car id (lists, home snapshot, battery baseline). */
function purgeDemoCaches() {
  const drop: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (k === `drivelens-home-${DEMO_CAR}` || (k.startsWith("drivelens-list-") && k.endsWith(`:${DEMO_CAR}`))) drop.push(k);
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
  purgeDemoCaches();
  localStorage.removeItem(STATE);
  const last = localStorage.getItem(LAST_CAR);
  if (last != null) localStorage.setItem(PREV_CAR, last); else localStorage.removeItem(PREV_CAR);
  localStorage.setItem(FLAG, "1");
  restart();
}
/** Back to the configured server (or the setup wizard when there is none); demo edits are discarded. */
export function exitDemo() {
  localStorage.removeItem(FLAG);
  localStorage.removeItem(STATE);
  purgeDemoCaches();
  const prev = localStorage.getItem(PREV_CAR);
  if (prev != null) localStorage.setItem(LAST_CAR, prev); else if (localStorage.getItem(LAST_CAR) === String(DEMO_CAR)) localStorage.removeItem(LAST_CAR);
  localStorage.removeItem(PREV_CAR);
  restart();
}
/** Data credits for the demo dataset (ODbL requires attribution of the OSM-derived routes). */
export const DEMO_CREDIT = "Demo routes © OpenStreetMap contributors (ODbL), routed with OSRM · elevation © Copernicus DEM via Open-Meteo (CC BY 4.0) · weather is synthetic";

if (isDemo()) installDemoFetch();
