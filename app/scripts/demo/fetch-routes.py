#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Builds app/src/demo/routes.json for Demo Mode: real road geometry between fictional-but-realistic places.
Routing: OSRM public demo server (router.project-osrm.org, data © OpenStreetMap contributors, ODbL).
Elevation: Open-Meteo elevation API (Copernicus DEM GLO-90, CC BY 4.0). Run once; the output is committed."""
import json, math, time, urllib.request, sys, os

PLACES = {  # key: (lat, lng, address as TeslaMate would show it, geofence or None)
  "H":   (35.65860, 139.74512, "東京タワー（デモ）, 港区", "🗼 Demo Home"),  # Tokyo Tower's own underground car park (OSM way 30525072): obviously fictional, no residence
  "O":   (35.54790, 139.75620, "羽田イノベーションシティ, 大田区", None),  # commercial complex (OSM landuse=retail, way 762948208)
  "SH":  (35.65810, 139.69970, "道玄坂1丁目, 渋谷区", None),
  "FT":  (35.61190, 139.62620, "二子玉川ライズ, 世田谷区", None),
  "MM":  (35.45630, 139.63220, "みなとみらい, 横浜市西区", None),
  "OD":  (35.62700, 139.77560, "台場1丁目, 港区", None),
  "KM":  (35.31960, 139.55130, "鎌倉駅東口, 鎌倉市", None),
  "EN":  (35.30290, 139.48030, "片瀬海岸, 藤沢市", None),
  "MK":  (35.64830, 140.03490, "幕張メッセ, 千葉市美浜区", None),
  "KJ":  (35.70300, 139.57960, "吉祥寺本町, 武蔵野市", None),
  "SCK": (35.52080, 139.59640, "Supercharger 港北", None),
  "SCE": (35.44560, 139.39070, "Supercharger 海老名", None),
  "SCH": (35.65700, 139.33300, "Supercharger 八王子", None),
  "HY":  (35.23300, 139.10570, "箱根湯本駅, 箱根町", None),
  "AS":  (35.19950, 139.02590, "元箱根港, 箱根町", None),
  "KW":  (35.49840, 138.76880, "河口湖駅, 富士河口湖町", None),
  "DF":  (35.47380, 138.79030, "道の駅 富士吉田 急速充電器, 富士吉田市", None),
  "GO":  (35.30750, 138.96540, "御殿場アウトレット, 御殿場市", None),
}
PAIRS = ["H>O", "O>H", "H>SH", "SH>H", "H>FT", "FT>H", "H>MM", "MM>OD", "OD>H", "MM>H", "H>OD",
         "H>KM", "KM>EN", "EN>H", "KM>H", "H>MK", "MK>H", "H>KJ", "KJ>H", "H>SCK", "SCK>H", "O>SH",
         "H>SCE", "SCE>HY", "HY>AS", "AS>H", "H>SCH", "SCH>KW", "KW>DF", "DF>GO", "GO>H"]

def get(url):
    for i in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "DriveLens-demo-builder"}), timeout=30) as r:
                return json.load(r)
        except Exception as e:
            print("retry", e, file=sys.stderr); time.sleep(2 + i * 2)
    raise SystemExit("failed " + url)

def decode6(s):
    coords, i, lat, lng = [], 0, 0, 0
    while i < len(s):
        vals = []
        for _ in range(2):
            shift = res = 0
            while True:
                b = ord(s[i]) - 63; i += 1; res |= (b & 0x1f) << shift; shift += 5
                if b < 0x20: break
            vals.append(~(res >> 1) if res & 1 else res >> 1)
        lat += vals[0]; lng += vals[1]; coords.append((lat / 1e6, lng / 1e6))
    return coords

def enc(v):
    v = ~(v << 1) if v < 0 else v << 1
    out = ""
    while v >= 0x20: out += chr((0x20 | (v & 0x1f)) + 63); v >>= 5
    return out + chr(v + 63)
def encode5(pts):
    out, pl, pg = "", 0, 0
    for la, lo in pts:
        a, b = round(la * 1e5), round(lo * 1e5); out += enc(a - pl) + enc(b - pg); pl, pg = a, b
    return out

def hav(a, b):
    la1, la2 = math.radians(a[0]), math.radians(b[0]); dl = la2 - la1; dn = math.radians(b[1] - a[1])
    h = math.sin(dl / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dn / 2) ** 2
    return 6371000 * 2 * math.asin(math.sqrt(h))

def dp(pts, tol):  # Douglas-Peucker on local metres, returns kept indices
    k = math.cos(math.radians(pts[0][0]))
    xy = [(p[1] * 111320 * k, p[0] * 110540) for p in pts]
    keep = [False] * len(pts); keep[0] = keep[-1] = True; st = [(0, len(pts) - 1)]
    while st:
        a, b = st.pop(); ax, ay = xy[a]; bx, by = xy[b]; dx, dy = bx - ax, by - ay; L = math.hypot(dx, dy) or 1e-9
        best, bi = 0, -1
        for i in range(a + 1, b):
            d = abs(dy * (xy[i][0] - ax) - dx * (xy[i][1] - ay)) / L
            if d > best: best, bi = d, i
        if best > tol: keep[bi] = True; st += [(a, bi), (bi, b)]
    return [i for i, v in enumerate(keep) if v]

out = {"attribution": "Routes © OpenStreetMap contributors (ODbL), routed with OSRM; elevation © Copernicus DEM via Open-Meteo (CC BY 4.0)",
       "places": {k: {"lat": v[0], "lng": v[1], "address": v[2], "geofence": v[3]} for k, v in PLACES.items()}, "routes": {}}
dst = os.path.join(os.path.dirname(__file__), "../../src/demo/routes.json")
# `fetch-routes.py H>O O>H ...` re-fetches only those legs and keeps the rest of the committed routes.json
only = sys.argv[1:]
if only:
    out["routes"] = json.load(open(dst))["routes"]
    bad = [p for p in only if p not in PAIRS]
    if bad: raise SystemExit("unknown pair(s): " + " ".join(bad))
for pair in (only or PAIRS):
    a, b = pair.split(">"); A, B = PLACES[a], PLACES[b]
    j = get(f"https://router.project-osrm.org/route/v1/driving/{A[1]},{A[0]};{B[1]},{B[0]}?overview=full&geometries=polyline6&annotations=distance,duration")
    r = j["routes"][0]; pts = decode6(r["geometry"]); an = r["legs"][0]["annotation"]
    dist, dur = an["distance"], an["duration"]
    idx = dp(pts, 6.0)
    spd = []
    for s, e in zip(idx, idx[1:]):
        dm = sum(dist[s:e]); dt = sum(dur[s:e]) or 1
        spd.append(max(5, min(120, round(dm / dt * 3.6))))
    kept = [pts[i] for i in idx]
    # elevation: sample every ~400 m, interpolate per vertex
    cum = [0.0]
    for p, q in zip(kept, kept[1:]): cum.append(cum[-1] + hav(p, q))
    samples, nxt = [], 0.0
    for i, c in enumerate(cum):
        if c >= nxt or i == len(cum) - 1: samples.append(i); nxt = c + 400
    ele_s = []
    for i in range(0, len(samples), 100):
        chunk = samples[i:i + 100]
        e = get("https://api.open-meteo.com/v1/elevation?latitude=" + ",".join(f"{kept[x][0]:.5f}" for x in chunk) + "&longitude=" + ",".join(f"{kept[x][1]:.5f}" for x in chunk))
        ele_s += e["elevation"]; time.sleep(0.4)
    ele = []
    for i in range(len(kept)):
        # piecewise-linear between samples
        import bisect
        k2 = bisect.bisect_left(samples, i)
        if k2 < len(samples) and samples[k2] == i: ele.append(round(ele_s[k2])); continue
        s0, s1 = samples[k2 - 1], samples[k2]; f = (cum[i] - cum[s0]) / ((cum[s1] - cum[s0]) or 1)
        ele.append(round(ele_s[k2 - 1] + (ele_s[k2] - ele_s[k2 - 1]) * f))
    out["routes"][pair] = {"poly": encode5(kept), "spd": spd, "ele": ele, "km": round(r["distance"] / 1000, 2), "min": round(r["duration"] / 60, 1)}
    print(pair, len(pts), "->", len(kept), "pts", out["routes"][pair]["km"], "km", out["routes"][pair]["min"], "min", file=sys.stderr)
    time.sleep(1.1)
out["routes"] = {k: out["routes"][k] for k in PAIRS}
os.makedirs(os.path.dirname(dst), exist_ok=True)
json.dump(out, open(dst, "w"), ensure_ascii=False, separators=(",", ":"))
print("wrote", dst, os.path.getsize(dst), file=sys.stderr)
