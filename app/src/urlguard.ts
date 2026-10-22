// Privacy guard — imported first by main.ts, so it runs before any other module code.
// The server URL and token live only in localStorage and are sent only to the user's own server. Older builds accepted
// ?api=…&token=… in the address; that is gone (since 1.1.1). If such a URL still arrives (old bookmark, pasted link), the
// parameters are dropped from the address bar / history at once and never read or saved.
export const SENSITIVE_PARAMS = ["api", "token", "key"];
export function stripSensitiveParams(loc: Location = location, hist: History = history): boolean {
  const q = new URLSearchParams(loc.search);
  const h = new URLSearchParams(loc.hash.startsWith("#") ? loc.hash.slice(1) : "");
  const hit = (p: URLSearchParams) => [...p.keys()].filter(k => SENSITIVE_PARAMS.includes(k.toLowerCase()));
  const qs = hit(q), hs = loc.hash.includes("=") ? hit(h) : [];
  if (!qs.length && !hs.length) return false;
  qs.forEach(k => q.delete(k)); hs.forEach(k => h.delete(k));
  const search = q.toString(), hash = hs.length ? h.toString() : loc.hash.slice(1);
  hist.replaceState(hist.state, "", loc.pathname + (search ? `?${search}` : "") + (hash ? `#${hash}` : ""));
  return true;
}
if (typeof location !== "undefined" && typeof history !== "undefined") stripSensitiveParams();
