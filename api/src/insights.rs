// SPDX-License-Identifier: AGPL-3.0-or-later
//! api_level 12: monthly footprint (all drive routes of a month) and battery degradation. Read-only.
//! api_level 14: TeslaMate-identical battery health (`tm` object in /battery). Read-only.
//! api_level 17: vampire drain (battery lost while parked between drives). Read-only.
use super::*;

#[derive(Deserialize)]
pub struct FootParams { month: Option<String>, tz: Option<String> }

#[derive(FromRow)]
struct P { drive_id: i64, lat: f64, lng: f64 }

/// GET /api/cars/:id/footprint?month=YYYY-MM&tz= → {lines: [[[lng,lat],…],…], points, raw_points}
/// One range scan of positions (car_id + date window → BRIN on date), thinned server-side: a point is kept when it is
/// ≥ `step` metres from the last kept one (step grows with the amount of data, ≤ ~8000 points returned).
pub async fn footprint(State(s): State<AppState>, Path(id): Path<i64>, Query(p): Query<FootParams>) -> Result<Response, ApiError> {
    let bad = |m: &str| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": m}))).into_response();
    if let Some(m) = &p.month { let b = m.as_bytes(); if !(b.len() == 7 && b[4] == b'-' && m[..4].parse::<u32>().is_ok() && matches!(m[5..].parse::<u32>(), Ok(1..=12))) { return Ok(bad("month must be YYYY-MM")); } }
    let tz = p.tz.unwrap_or_else(|| "UTC".into());
    let r: Result<(String, String), _> = sqlx::query_as(
        "WITH x AS (SELECT (COALESCE($1::text, to_char(now() AT TIME ZONE $2, 'YYYY-MM')) || '-01')::timestamp AS lm0)
         SELECT to_char((lm0 AT TIME ZONE $2) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
                to_char(((lm0 + interval '1 month') AT TIME ZONE $2) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') FROM x")
        .bind(&p.month).bind(&tz).fetch_one(&s.db).await;
    let (t0, t1) = match r { Ok(v) => v, Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("22023") => return Ok(bad("unknown tz")), Err(e) => return Err(e.into()) };
    let rows = sqlx::query_as::<_, P>(
        "SELECT drive_id::int8 AS drive_id, latitude::float8 AS lat, longitude::float8 AS lng FROM positions
         WHERE car_id = $1 AND date >= $2::timestamp AND date < $3::timestamp AND drive_id IS NOT NULL
         ORDER BY drive_id, date").bind(id as i16).bind(&t0).bind(&t1).fetch_all(&s.db).await?;
    let raw = rows.len();
    let dist = |a: (f64, f64), b: (f64, f64)| {
        let k = (a.1.to_radians()).cos();
        (((a.0 - b.0) * k).powi(2) + (a.1 - b.1).powi(2)).sqrt() * 111_320.0
    };
    let thin = |step_m: f64| {
        let mut lines: Vec<Vec<[f64; 2]>> = vec![];
        let mut cur_drive = -1i64; let mut last = (0.0, 0.0); let mut pend: Option<[f64; 2]> = None;
        for r in &rows {
            let pt = (r.lng, r.lat);
            if r.drive_id != cur_drive {
                if let (Some(l), Some(pp)) = (lines.last_mut(), pend.take()) { l.push(pp); }
                lines.push(vec![[pt.0, pt.1]]); cur_drive = r.drive_id; last = pt; continue;
            }
            if dist(pt, last) >= step_m { lines.last_mut().unwrap().push([pt.0, pt.1]); last = pt; pend = None; } else { pend = Some([pt.0, pt.1]); }
        }
        if let (Some(l), Some(pp)) = (lines.last_mut(), pend) { l.push(pp); }
        lines.retain(|l| l.len() > 1);
        lines
    };
    // grow the step until ≤ ~8000 points (always keeps each drive's first and last point)
    let mut step = 25.0;
    let mut lines = thin(step);
    while lines.iter().map(|l| l.len()).sum::<usize>() > 8000 && step < 1600.0 { step *= 2.0; lines = thin(step); }
    // erratic tracks (GPS jumps) can still be too dense: keep every k-th point (+ ends)
    let total: usize = lines.iter().map(|l| l.len()).sum();
    if total > 8000 {
        let k = total.div_ceil(8000);
        for l in &mut lines { let n = l.len(); *l = l.iter().enumerate().filter(|(i, _)| i % k == 0 || *i == n - 1).map(|(_, p)| *p).collect(); }
    }
    for l in &mut lines { for p in l.iter_mut() { p[0] = (p[0] * 1e5).round() / 1e5; p[1] = (p[1] * 1e5).round() / 1e5; } }
    let n: usize = lines.iter().map(|l| l.len()).sum();
    Ok(Json(serde_json::json!({"lines": lines, "points": n, "raw_points": raw})).into_response())
}

#[derive(FromRow, Serialize)]
pub struct BPoint { date: String, odometer_km: Option<f64>, range100_km: f64, end_level: i32, capacity_kwh: Option<f64> }
#[derive(Serialize)]
pub struct BMonth { month: String, range100_km: f64, capacity_kwh: Option<f64>, odometer_km: Option<f64>, n: i64 }

/// GET /api/cars/:id/battery → projected 100 % rated range per charge (sessions ending ≥ 50 % SoC:
/// end_rated_range_km / end_battery_level × 100), monthly medians, and an energy-based capacity estimate
/// (charge_energy_added / SoC gained, sessions gaining ≥ 30 %). Reads charging_processes (+ positions by primary key).
#[derive(Deserialize)]
pub struct BatParams { summary: Option<bool>, tz: Option<String>, new_kwh: Option<f64> }
pub async fn battery(State(s): State<AppState>, Path(id): Path<i64>, Query(q): Query<BatParams>) -> Result<Response, ApiError> {
    let eff: Option<f64> = sqlx::query_scalar("SELECT efficiency::float8 FROM cars WHERE id = $1").bind(id).fetch_optional(&s.db).await?.flatten();
    let pts = sqlx::query_as::<_, BPoint>(&format!(
        "SELECT to_char(cp.end_date, '{TS}') AS date, p.odometer::float8 AS odometer_km,
                (cp.end_rated_range_km / cp.end_battery_level * 100)::float8 AS range100_km, cp.end_battery_level::int4 AS end_level,
                CASE WHEN cp.end_battery_level - cp.start_battery_level >= 30 AND cp.charge_energy_added > 0
                     THEN (cp.charge_energy_added / (cp.end_battery_level - cp.start_battery_level) * 100)::float8 END AS capacity_kwh
         FROM charging_processes cp
         -- per-row primary-key probe (OFFSET 0 keeps the planner from merge-joining all of positions)
         LEFT JOIN LATERAL (SELECT odometer FROM positions WHERE id = cp.position_id OFFSET 0) p ON true
         WHERE cp.car_id = $1 AND cp.end_date IS NOT NULL AND cp.end_battery_level >= 50 AND cp.end_rated_range_km > 0
         ORDER BY cp.end_date")).bind(id).fetch_all(&s.db).await?;
    let med = |mut v: Vec<f64>| -> Option<f64> { if v.is_empty() { return None; } v.sort_by(|a, b| a.total_cmp(b)); Some(v[v.len() / 2]) };
    let k = 10.min(pts.len());
    let initial = med(pts.iter().take(k).map(|p| p.range100_km).collect());
    let current = med(pts.iter().rev().take(k).map(|p| p.range100_km).collect());
    let r1 = |v: f64| (v * 10.0).round() / 10.0;
    // monthly medians (by UTC month of the session end)
    let mut months: Vec<BMonth> = vec![];
    let mut i = 0;
    while i < pts.len() {
        let m = pts[i].date[..7].to_string(); let mut j = i;
        while j < pts.len() && pts[j].date[..7] == m { j += 1; }
        let g = &pts[i..j];
        months.push(BMonth { month: m, range100_km: r1(med(g.iter().map(|p| p.range100_km).collect()).unwrap_or(0.0)),
            capacity_kwh: med(g.iter().filter_map(|p| p.capacity_kwh).collect()).map(r1),
            odometer_km: g.iter().filter_map(|p| p.odometer_km).fold(None, |a: Option<f64>, b| Some(a.map_or(b, |a| a.max(b)))), n: g.len() as i64 });
        i = j;
    }
    let retained = match (initial, current) { (Some(a), Some(b)) if a > 0.0 => Some(r1(b / a * 100.0)), _ => None };
    let cap_now = med(pts.iter().rev().filter_map(|p| p.capacity_kwh).take(10).collect());
    let summary = q.summary.unwrap_or(false);
    let tm = tm_health(&s, id, q.tz.clone(), q.new_kwh, summary).await?;
    let n_points = pts.len();
    let first_date = pts.first().map(|p| p.date.clone());
    let (pts, months) = if summary { (vec![], vec![]) } else { (pts, months) };
    Ok(Json(serde_json::json!({
        "points": pts, "months": months, "n_points": n_points, "first_date": first_date, "initial_range100_km": initial.map(r1), "current_range100_km": current.map(r1), "retained_pct": retained,
        "efficiency_kwh_km": eff, "capacity_from_range_kwh": match (current, eff) { (Some(c), Some(e)) => Some(r1(c * e)), _ => None },
        "capacity_from_energy_kwh": cap_now.map(r1),
        "tm": tm,
    })).into_response())
}

// ---------------- api_level 14: TeslaMate "Battery Health" dashboard, ported ----------------
// Portions derived from TeslaMate (https://github.com/teslamate-org/teslamate), Copyright (C) TeslaMate contributors,
// licensed under AGPL-3.0 (-or-later). Modified: re-implemented as one SQL query for this API (see THE ONE DEVIATION
// below); this is not the original TeslaMate. TeslaMate's NOTICE is preserved in third_party/teslamate/NOTICE.
// Source: teslamate-org/teslamate grafana/dashboards/battery-health.json (variable `aux` + "Battery Capacity by Mileage"),
// main @ 9f4098e (2026-10-21). Same tables, filters and aggregates; units are always km / kWh here (the app converts).
//  efficiency  = mode of ROUND(charge_energy_added / (end_rated_range_km − start_rated_range_km), 3) × 100 over sessions with
//                duration_min > 10, end_battery_level ≤ 95, both rated ranges set, energy > 0; fallback cars.efficiency × 100
//                (kWh per 100 rated km). Ties in the mode are broken by the larger value (TeslaMate leaves them unordered).
//  sample      = charges.rated_battery_range_km × efficiency / charges.usable_battery_level   (kWh at 100 %)
//  qualifying  = finished session (end_date set) with charge_energy_added ≥ efficiency, sample rows with usable_battery_level > 0
//  current     = AVG(sample) over the latest 100 `charges` rows of qualifying sessions (ORDER BY end_date DESC, date DESC)
//  max (new)   = MAX(sample) over the last row of each qualifying session; a user value (`new_kwh`) replaces it like the
//                dashboard's custom_kwh_new
//  health      = LEAST(100, current / new × 100); degradation = GREATEST(0, 100 − current / new × 100)
//  cycles      = FLOOR(SUM(charge_energy_added) / new) over sessions with charge_energy_added > 0.01
//  points      = per local day: AVG(odometer of the session position), AVG(last-row sample)   ("Battery Capacity by Mileage")
//  half-months = per local half-month (1st–15th / 16th–end): MIN(odometer), PERCENTILE_CONT(0.5)(last-row sample)
// THE ONE DEVIATION: samples outside 20–150 kWh (e.g. a bogus usable_battery_level of 1 %) are treated as if the row did not
// exist (`SANE` below). TeslaMate keeps them, and one such row can make its MAX (and so the health %) meaningless.
const SANE: &str = "(c.rated_battery_range_km IS NULL OR c.rated_battery_range_km * aux.efficiency / c.usable_battery_level BETWEEN 20 AND 150)";

#[derive(FromRow, Serialize)]
pub struct TmPoint { date: String, odometer_km: Option<f64>, capacity_kwh: f64 }
#[derive(FromRow, Serialize)]
pub struct TmHalf { period: String, odometer_km: Option<f64>, capacity_kwh: f64, n: i64 }

async fn tm_health(s: &AppState, id: i64, tz: Option<String>, new_kwh: Option<f64>, summary: bool) -> Result<serde_json::Value, ApiError> {
    let aux = "aux AS (
        SELECT COALESCE(derived_efficiency, car_efficiency)::float8 AS efficiency, (derived_efficiency IS NOT NULL) AS derived
        FROM (
            SELECT ROUND((charge_energy_added / NULLIF(end_rated_range_km - start_rated_range_km, 0))::numeric, 3) * 100 AS derived_efficiency,
                   COUNT(*) AS count, cars.id AS car_id, cars.efficiency * 100 AS car_efficiency
            FROM cars
            LEFT JOIN charging_processes ON cars.id = charging_processes.car_id AND duration_min > 10 AND end_battery_level <= 95
                 AND start_rated_range_km IS NOT NULL AND end_rated_range_km IS NOT NULL AND charge_energy_added > 0
            WHERE cars.id = $1
            GROUP BY 1, 3, 4
            ORDER BY 2 DESC, 1 DESC NULLS LAST
            LIMIT 1
        ) e)";
    let last = format!("last AS (
        SELECT DISTINCT ON (c.charging_process_id) c.charging_process_id AS cp_id, c.date,
               (c.rated_battery_range_km * aux.efficiency / c.usable_battery_level)::float8 AS cap
        FROM charging_processes cp JOIN charges c ON c.charging_process_id = cp.id CROSS JOIN aux
        WHERE cp.car_id = $1 AND cp.end_date IS NOT NULL AND cp.charge_energy_added >= aux.efficiency
              AND c.usable_battery_level > 0 AND {SANE}
        ORDER BY c.charging_process_id, c.date DESC)");
    let row: (Option<f64>, Option<bool>, Option<f64>, i64, Option<f64>, Option<f64>, i64) = sqlx::query_as(&format!(
        "WITH {aux}, {last},
         cur AS (
            SELECT AVG(cap)::float8 AS cap, COUNT(*) AS n FROM (
                SELECT (c.rated_battery_range_km * aux.efficiency / c.usable_battery_level)::float8 AS cap
                FROM charging_processes cp JOIN charges c ON c.charging_process_id = cp.id CROSS JOIN aux
                WHERE cp.car_id = $1 AND cp.end_date IS NOT NULL AND cp.charge_energy_added >= aux.efficiency
                      AND c.usable_battery_level > 0 AND {SANE}
                ORDER BY cp.end_date DESC, c.date DESC
                LIMIT 100) x),
         tot AS (SELECT SUM(charge_energy_added)::float8 AS kwh, COUNT(*) AS n FROM charging_processes WHERE car_id = $1 AND charge_energy_added > 0.01)
         SELECT aux.efficiency, aux.derived, cur.cap, cur.n, (SELECT MAX(cap) FROM last), tot.kwh, tot.n
         FROM (SELECT 1) b LEFT JOIN aux ON true LEFT JOIN cur ON true LEFT JOIN tot ON true")).bind(id as i32).fetch_one(&s.db).await?;
    let (eff, derived, cur, cur_n, max, kwh, n_charges) = row;
    let custom = new_kwh.filter(|v| v.is_finite() && *v >= 20.0 && *v <= 250.0);
    let new = custom.or(max);
    let ratio = match (cur, new) { (Some(c), Some(n)) if n > 0.0 => Some(c * 100.0 / n), _ => None };
    let r1 = |v: f64| (v * 10.0).round() / 10.0;
    let r2 = |v: f64| (v * 100.0).round() / 100.0;
    // Half-months are needed for trend even on summary; daily points only on the full page.
    let (points, halves): (Vec<TmPoint>, Vec<TmHalf>) = if eff.is_none() {
        (vec![], vec![])
    } else {
        let tz = tz.unwrap_or_else(|| "UTC".into());
        let tz_ok: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = $1)").bind(&tz).fetch_one(&s.db).await?;
        let tz = if tz_ok { tz } else { "UTC".to_string() };
        let base = format!("WITH {aux}, {last},
            l AS (SELECT timezone($2, timezone('UTC', cp.end_date)) AS t, p.odometer, last.cap
                  FROM last JOIN charging_processes cp ON cp.id = last.cp_id JOIN positions p ON p.id = cp.position_id
                  WHERE last.cap IS NOT NULL)");
        let pts = if summary {
            vec![]
        } else {
            sqlx::query_as::<_, TmPoint>(&format!("{base}
            SELECT to_char(t, 'YYYY-MM-DD') AS date, ROUND(AVG(odometer)::numeric, 1)::float8 AS odometer_km, ROUND(AVG(cap)::numeric, 2)::float8 AS capacity_kwh
            FROM l GROUP BY 1 ORDER BY 1")).bind(id as i32).bind(&tz).fetch_all(&s.db).await?
        };
        let hs = sqlx::query_as::<_, TmHalf>(&format!("{base}
            SELECT to_char(t, 'YYYYMM') || CASE WHEN to_char(t, 'DD')::int <= 15 THEN '1' ELSE '2' END AS period,
                   ROUND(MIN(odometer)::numeric, 0)::float8 AS odometer_km,
                   ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cap))::numeric, 1)::float8 AS capacity_kwh, COUNT(*) AS n
            FROM l GROUP BY 1 ORDER BY 1")).bind(id as i32).bind(&tz).fetch_all(&s.db).await?;
        (pts, hs)
    };
    let trend_halves: Vec<TrendHalf> = halves.iter().map(|h| TrendHalf {
        period: h.period.clone(), odometer_km: h.odometer_km, capacity_kwh: h.capacity_kwh,
    }).collect();
    let trend = new.map(|n| compute_battery_trend(&trend_halves, n));
    // Summary keeps spark via trend; omit the full half_months list to keep the home-card payload small.
    let halves_out = if summary { vec![] } else { halves };
    Ok(serde_json::json!({
        "method": "teslamate-battery-health",
        "efficiency_kwh_100km": eff.map(r2), "efficiency_source": derived.map(|d| if d { "derived" } else { "car" }),
        "capacity_now_kwh": cur.map(r2), "now_samples": cur_n,
        "capacity_max_kwh": max.map(r2), "capacity_new_kwh": new.map(r2), "new_source": if custom.is_some() { "custom" } else { "max" },
        "health_pct": ratio.map(|r| r1(r.min(100.0))), "degradation_pct": ratio.map(|r| r1((100.0 - r).max(0.0))),
        "cycles": match (kwh, new) { (Some(k), Some(n)) if n > 0.0 => Some((k / n).floor() as i64), _ => None },
        "energy_added_kwh": kwh.map(r1), "charges": n_charges,
        "points": points, "half_months": halves_out,
        "trend": trend.as_ref().map(trend_json),
    }))
}



// ---------------- api_level 19: battery trend (rates + projections + spark) ----------------
// Fit least-squares on half-month capacity medians (same series as the charts) to cut charge-to-charge noise.
// Thresholds for "enough data": ≥ 4 half-month points, calendar span ≥ 3 months, odometer span ≥ 5 000 km
// (odo span required only for %/10k km and odometer projections; %/yr needs the time span + points).

#[derive(Clone, Debug)]
pub struct TrendHalf {
    pub period: String,
    pub odometer_km: Option<f64>,
    pub capacity_kwh: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BatProjection {
    pub odometer_km: i64,
    pub capacity_kwh: f64,
    pub health_pct: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BatTrend {
    pub enough_time: bool,
    pub enough_odo: bool,
    pub pct_per_10k_km: Option<f64>,
    pub pct_per_year: Option<f64>,
    pub no_measurable_degradation: bool,
    pub projections: Vec<BatProjection>,
    pub spark: Vec<f64>,
    pub months_span: f64,
    pub km_span: f64,
    pub n_halves: usize,
}

fn round1(v: f64) -> f64 { (v * 10.0).round() / 10.0 }

/// Mid-point of a half-month period key `YYYYMM1` / `YYYYMM2` as an ordinal day (enough for slope).
pub fn period_day(period: &str) -> Option<f64> {
    if period.len() < 7 { return None; }
    let y: f64 = period.get(0..4)?.parse().ok()?;
    let m: f64 = period.get(4..6)?.parse().ok()?;
    if !(1.0..=12.0).contains(&m) { return None; }
    let day: f64 = if period.ends_with('1') { 8.0 } else { 23.0 };
    Some(y * 365.25 + (m - 1.0) * 30.4375 + day)
}

fn ls_fit(xs: &[f64], ys: &[f64]) -> Option<(f64, f64)> {
    let n = xs.len();
    if n < 2 || ys.len() != n { return None; }
    let mx = xs.iter().sum::<f64>() / n as f64;
    let my = ys.iter().sum::<f64>() / n as f64;
    let mut sxy = 0.0;
    let mut sxx = 0.0;
    for i in 0..n {
        sxy += (xs[i] - mx) * (ys[i] - my);
        sxx += (xs[i] - mx) * (xs[i] - mx);
    }
    if sxx.abs() < 1e-12 { return None; }
    let b = sxy / sxx;
    Some((my - b * mx, b))
}

const MIN_HALVES: usize = 4;
const MIN_MONTHS: f64 = 3.0;
const MIN_KM: f64 = 5_000.0;
const PROJ_TARGETS: [i64; 2] = [100_000, 200_000];

/// Build trend stats from half-month medians and the new-capacity baseline (kWh).
pub fn compute_battery_trend(halves: &[TrendHalf], new_kwh: f64) -> BatTrend {
    let spark: Vec<f64> = halves.iter().rev().take(12).map(|h| round1(h.capacity_kwh)).collect::<Vec<_>>().into_iter().rev().collect();
    let n_halves = halves.len();
    let mut empty = BatTrend {
        enough_time: false, enough_odo: false,
        pct_per_10k_km: None, pct_per_year: None,
        no_measurable_degradation: false, projections: vec![],
        spark, months_span: 0.0, km_span: 0.0, n_halves,
    };
    if new_kwh <= 0.0 || n_halves < MIN_HALVES {
        return empty;
    }

    // ---- time fit ----
    let mut t_xs = Vec::new();
    let mut t_ys = Vec::new();
    for h in halves {
        if let Some(d) = period_day(&h.period) {
            t_xs.push(d);
            t_ys.push(h.capacity_kwh);
        }
    }
    let months_span = if t_xs.len() >= 2 {
        (t_xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max) - t_xs.iter().cloned().fold(f64::INFINITY, f64::min)) / 30.4375
    } else { 0.0 };
    empty.months_span = round1(months_span);
    let enough_time = t_xs.len() >= MIN_HALVES && months_span >= MIN_MONTHS;
    empty.enough_time = enough_time;

    let mut pct_year: Option<f64> = None;
    if enough_time {
        if let Some((_a, b)) = ls_fit(&t_xs, &t_ys) {
            // b = kWh per day → % of new per year
            let pct = b * 365.25 / new_kwh * 100.0;
            pct_year = Some(if pct >= -0.05 { 0.0 } else { round1(pct) });
        }
    }

    // ---- odometer fit ----
    let mut o_xs = Vec::new();
    let mut o_ys = Vec::new();
    for h in halves {
        if let Some(o) = h.odometer_km {
            if o.is_finite() && o > 0.0 {
                o_xs.push(o);
                o_ys.push(h.capacity_kwh);
            }
        }
    }
    let (odo_min, odo_max) = if o_xs.is_empty() {
        (0.0, 0.0)
    } else {
        (o_xs.iter().cloned().fold(f64::INFINITY, f64::min), o_xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max))
    };
    let km_span = odo_max - odo_min;
    empty.km_span = round1(km_span);
    let enough_odo = o_xs.len() >= MIN_HALVES && km_span >= MIN_KM;
    empty.enough_odo = enough_odo;

    let mut pct_10k: Option<f64> = None;
    let mut fit_odo: Option<(f64, f64)> = None;
    if enough_odo {
        if let Some((a, b)) = ls_fit(&o_xs, &o_ys) {
            fit_odo = Some((a, b));
            let pct = b * 10_000.0 / new_kwh * 100.0;
            pct_10k = Some(if pct >= -0.05 { 0.0 } else { round1(pct) });
        }
    }

    // Flat or rising capacity → "no measurable degradation" (do not show a negative degradation %).
    let no_measurable = match (pct_10k, pct_year) {
        (Some(a), Some(b)) => a >= -0.05 && b >= -0.05,
        (Some(a), None) => a >= -0.05,
        (None, Some(b)) => b >= -0.05,
        (None, None) => false,
    };

    let mut projections = Vec::new();
    if let Some((a, b)) = fit_odo {
        for &target in &PROJ_TARGETS {
            if (target as f64) <= odo_max + 1.0 { continue; } // already passed / at target
            let mut cap = a + b * target as f64;
            // physical clamp: not above new, not below 50% of new (or 20 kWh floor)
            let lo = (new_kwh * 0.5).max(20.0);
            cap = cap.clamp(lo, new_kwh);
            let health = round1((cap / new_kwh * 100.0).min(100.0));
            projections.push(BatProjection { odometer_km: target, capacity_kwh: round1(cap), health_pct: health });
        }
    }

    BatTrend {
        enough_time, enough_odo,
        pct_per_10k_km: pct_10k,
        pct_per_year: pct_year,
        no_measurable_degradation: no_measurable,
        projections,
        spark: empty.spark,
        months_span: empty.months_span,
        km_span: empty.km_span,
        n_halves,
    }
}

fn trend_json(t: &BatTrend) -> serde_json::Value {
    serde_json::json!({
        "enough_time": t.enough_time,
        "enough_odo": t.enough_odo,
        "pct_per_10k_km": t.pct_per_10k_km,
        "pct_per_year": t.pct_per_year,
        "no_measurable_degradation": t.no_measurable_degradation,
        "projections": t.projections.iter().map(|p| serde_json::json!({
            "odometer_km": p.odometer_km, "capacity_kwh": p.capacity_kwh, "health_pct": p.health_pct
        })).collect::<Vec<_>>(),
        "spark": t.spark,
        "months_span": t.months_span,
        "km_span": t.km_span,
        "n_halves": t.n_halves,
    })
}


// ---------------- api_level 17: vampire drain (parked SoC / range loss) ----------------

#[derive(Deserialize)]
pub struct VampireParams {
    /// Look-back window in calendar days (default 30, clamped 1..=90).
    days: Option<i32>,
    tz: Option<String>,
}

#[derive(FromRow)]
struct DriveEdge {
    id: i64,
    start_date: String,
    end_date: String,
    start_soc: Option<i32>,
    end_soc: Option<i32>,
    start_rated_km: Option<f64>,
    end_rated_km: Option<f64>,
}

/// One charging_processes row used to punch holes in parked gaps.
/// `end_date` is never null here: active sessions use "now"; stale open rows are dropped in SQL.
#[derive(FromRow, Clone, Debug)]
struct ChargeWin {
    start_date: String,
    end_date: String,
    start_soc: Option<i32>,
    end_soc: Option<i32>,
    start_rated_km: Option<f64>,
    end_rated_km: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct VampirePeriod {
    pub start: String,
    pub end: String,
    pub duration_hours: f64,
    pub start_soc: Option<i32>,
    pub end_soc: Option<i32>,
    pub soc_lost: Option<i32>,
    pub start_rated_km: Option<f64>,
    pub end_rated_km: Option<f64>,
    pub range_lost_km: Option<f64>,
    pub ongoing: bool,
    pub after_drive_id: Option<i64>,
    pub before_drive_id: Option<i64>,
}

/// Charge interval for the pure bucketer: (start, end, start_soc, end_soc, start_rated, end_rated).
pub type VampireCharge = (String, String, Option<i32>, Option<i32>, Option<f64>, Option<f64>);

fn parse_ts(s: &str) -> Option<i64> {
    // Accept "YYYY-MM-DD HH:MM:SS" (TeslaMate naive UTC) or "YYYY-MM-DDTHH:MM:SSZ".
    let t = s.trim().replace('T', " ").trim_end_matches('Z').to_string();
    let b = t.as_bytes();
    if b.len() < 19 { return None; }
    let y: i64 = t.get(0..4)?.parse().ok()?;
    let mo: i64 = t.get(5..7)?.parse().ok()?;
    let d: i64 = t.get(8..10)?.parse().ok()?;
    let h: i64 = t.get(11..13)?.parse().ok()?;
    let mi: i64 = t.get(14..16)?.parse().ok()?;
    let se: i64 = t.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) { return None; }
    // days from civil date (Howard Hinnant) → Unix seconds UTC
    let y = if mo <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = if mo > 2 { mo - 3 } else { mo + 9 };
    let doy = (153 * m + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(days * 86400 + h * 3600 + mi * 60 + se)
}

fn fmt_ts(secs: i64) -> String {
    let (days, sod) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    let h = sod / 3600; let mi = (sod % 3600) / 60; let se = sod % 60;
    // civil_from_days (Howard Hinnant)
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{se:02}Z")
}

fn iso_z(s: &str) -> String {
    if s.contains('T') { s.to_string() } else { format!("{}Z", s.replace(' ', "T")) }
}

fn overlaps(a0: &str, a1: &str, b0: &str, b1: &str) -> bool {
    a0 < b1 && b0 < a1
}

fn r1(v: f64) -> f64 { (v * 10.0).round() / 10.0 }

fn soc_lost_of(start: Option<i32>, end: Option<i32>) -> Option<i32> {
    match (start, end) {
        (Some(s), Some(e)) if s >= e => Some(s - e),
        (Some(_), Some(_)) => Some(0), // rose without a logged charge — treat as 0, still list
        _ => None,
    }
}

fn range_lost_of(start: Option<f64>, end: Option<f64>) -> Option<f64> {
    match (start, end) {
        (Some(s), Some(e)) if s >= e => Some(r1(s - e)),
        (Some(_), Some(_)) => Some(0.0),
        _ => None,
    }
}

/// Average drain per parked day: total loss ÷ (parked_hours / 24).
/// Returns (avg_soc_per_day, avg_range_km_per_day); None when there is no parked time / no samples.
pub fn vampire_averages(soc_lost: Option<i32>, range_lost_km: Option<f64>, parked_hours: f64) -> (Option<f64>, Option<f64>) {
    if !(parked_hours > 0.0) { return (None, None); }
    let days = parked_hours / 24.0;
    (
        soc_lost.map(|s| r1(s as f64 / days)),
        range_lost_km.map(|r| r1(r / days)),
    )
}

/// Uncharged slices of `[park_start, park_end]` after subtracting overlapping charges.
/// Each slice carries the SoC / rated range at its ends (from the enclosing drive or the
/// charge that borders it). Charging itself is never reported as vampire drain.
fn uncharged_slices(
    park_start: &str,
    park_end: &str,
    start_soc: Option<i32>,
    end_soc: Option<i32>,
    start_rated: Option<f64>,
    end_rated: Option<f64>,
    charges: &[VampireCharge],
) -> Vec<(String, String, Option<i32>, Option<i32>, Option<f64>, Option<f64>)> {
    if park_end <= park_start { return vec![]; }
    let mut hit: Vec<&VampireCharge> = charges.iter()
        .filter(|c| overlaps(park_start, park_end, &c.0, &c.1))
        .collect();
    hit.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut out = Vec::new();
    let mut cursor = park_start.to_string();
    let mut cur_soc = start_soc;
    let mut cur_rated = start_rated;
    for c in hit {
        // charge may start before the park (still overlapping) — clamp
        let c0 = if c.0.as_str() < park_start { park_start.to_string() } else { c.0.clone() };
        let c1 = if c.1.as_str() > park_end { park_end.to_string() } else { c.1.clone() };
        if c0.as_str() > cursor.as_str() {
            out.push((cursor.clone(), c0.clone(), cur_soc, c.2, cur_rated, c.4));
        }
        if c1.as_str() > cursor.as_str() {
            cursor = c1;
            cur_soc = c.3;   // after charging, SoC is the charge's end
            cur_rated = c.5;
        }
    }
    if park_end > cursor.as_str() {
        out.push((cursor, park_end.to_string(), cur_soc, end_soc, cur_rated, end_rated));
    }
    out
}

fn push_segment(
    out: &mut Vec<VampirePeriod>,
    start: &str,
    end: &str,
    start_soc: Option<i32>,
    end_soc: Option<i32>,
    start_rated: Option<f64>,
    end_rated: Option<f64>,
    ongoing: bool,
    after_drive_id: Option<i64>,
    before_drive_id: Option<i64>,
    window_start: &str,
) {
    if end <= start { return; }
    // Drop slices that ended entirely before the window (a slice that spans the window edge is kept).
    if end < window_start && start < window_start { return; }
    let hours = match (parse_ts(start), parse_ts(end)) {
        (Some(s), Some(e)) if e > s => (e - s) as f64 / 3600.0,
        _ => return,
    };
    if hours < 0.25 { return; } // ignore sub-15-minute gaps (door open / short stop)
    out.push(VampirePeriod {
        start: iso_z(start),
        end: iso_z(end),
        duration_hours: r1(hours),
        start_soc, end_soc, soc_lost: soc_lost_of(start_soc, end_soc),
        start_rated_km: start_rated.map(r1), end_rated_km: end_rated.map(r1),
        range_lost_km: range_lost_of(start_rated, end_rated),
        ongoing, after_drive_id, before_drive_id,
    });
}

/// Build parked periods between consecutive completed drives.
///
/// A gap that contains charging is **split** around each charge: only the uncharged
/// slices count as vampire drain (home charging every night no longer zeroes the card).
/// `now` fills an ongoing park after the latest drive when present.
pub fn build_vampire_periods(
    drives: &[(i64, String, String, Option<i32>, Option<i32>, Option<f64>, Option<f64>)],
    charges: &[VampireCharge],
    now: Option<(String, Option<i32>, Option<f64>)>,
    window_start: &str,
) -> Vec<VampirePeriod> {
    // drives: (id, start, end, start_soc, end_soc, start_rated, end_rated), ordered by end ascending
    let mut out = Vec::new();
    for w in drives.windows(2) {
        let (a, b) = (&w[0], &w[1]);
        let (park_start, park_end) = (&a.2, &b.1); // end of A → start of B
        for (s, e, ss, es, sr, er) in uncharged_slices(
            park_start, park_end, a.4, b.3, a.6, b.5, charges,
        ) {
            push_segment(&mut out, &s, &e, ss, es, sr, er, false, Some(a.0), Some(b.0), window_start);
        }
    }
    if let (Some(last), Some((now_s, now_soc, now_rated))) = (drives.last(), now) {
        let park_start = &last.2;
        if now_s.as_str() > park_start.as_str() {
            for (s, e, ss, es, sr, er) in uncharged_slices(
                park_start, &now_s, last.4, now_soc, last.6, now_rated, charges,
            ) {
                // only the final slice (ending at "now") is the ongoing park
                let ongoing = e == now_s || iso_z(&e) == iso_z(&now_s);
                push_segment(&mut out, &s, &e, ss, es, sr, er, ongoing, Some(last.0), None, window_start);
            }
        }
    }
    out.sort_by(|a, b| b.start.cmp(&a.start));
    out
}

/// Drain of the parked gap immediately before `drive_id` (for push alerts).
/// Sums uncharged slices between the previous drive and this one. None when unknown / fully charged / too short.
pub fn gap_before_drive(
    drives: &[(i64, String, String, Option<i32>, Option<i32>, Option<f64>, Option<f64>)],
    charges: &[VampireCharge],
    drive_id: i64,
) -> Option<VampirePeriod> {
    let idx = drives.iter().position(|d| d.0 == drive_id)?;
    if idx == 0 { return None; }
    let periods = build_vampire_periods(&drives[idx - 1 ..= idx], charges, None, "0000-01-01");
    let mine: Vec<_> = periods.into_iter().filter(|p| p.before_drive_id == Some(drive_id)).collect();
    if mine.is_empty() { return None; }
    let duration_hours = r1(mine.iter().map(|p| p.duration_hours).sum::<f64>());
    if duration_hours < 0.25 { return None; }
    let mut soc = 0i32; let mut soc_n = 0i32;
    let mut range = 0.0; let mut range_n = 0i32;
    for p in &mine {
        if let Some(s) = p.soc_lost { soc += s; soc_n += 1; }
        if let Some(r) = p.range_lost_km { range += r; range_n += 1; }
    }
    let first = mine.last().unwrap(); // chronological first (mine was sorted newest-first)
    let last = mine.first().unwrap();
    Some(VampirePeriod {
        start: first.start.clone(),
        end: last.end.clone(),
        duration_hours,
        start_soc: first.start_soc,
        end_soc: last.end_soc,
        soc_lost: if soc_n > 0 { Some(soc) } else { None },
        start_rated_km: first.start_rated_km,
        end_rated_km: last.end_rated_km,
        range_lost_km: if range_n > 0 { Some(r1(range)) } else { None },
        ongoing: false,
        after_drive_id: Some(drives[idx - 1].0),
        before_drive_id: Some(drive_id),
    })
}

/// How long a charging_processes row with NULL end_date may still be treated as "active".
/// Older open rows are a common TeslaMate leftover; treating them as open-until-now would
/// blank every parked gap since they started. Completed rows (`end_date IS NOT NULL`) are unaffected.
pub const VAMPIRE_ACTIVE_CHARGE_HOURS: i32 = 48;

/// GET /api/cars/:id/vampire?days=30&tz=
/// Parked SoC / rated-range loss between drives. Charging intervals are punched out of each gap
/// (not "exclude the whole gap"). Stale open charging_processes rows are ignored.
pub async fn vampire(State(s): State<AppState>, Path(id): Path<i64>, Query(p): Query<VampireParams>) -> Result<Response, ApiError> {
    let bad = |m: &str| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": m}))).into_response();
    let days = p.days.unwrap_or(30).clamp(1, 90);
    let tz = p.tz.unwrap_or_else(|| "UTC".into());
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM cars WHERE id = $1)").bind(id as i16).fetch_one(&s.db).await?;
    if !exists { return Ok((StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "car not found"}))).into_response()); }
    let tz_ok: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = $1)").bind(&tz).fetch_one(&s.db).await?;
    if !tz_ok { return Ok(bad("unknown tz")); }
    // Window start = now − days in the caller's tz, expressed as TeslaMate naive-UTC.
    // Final AT TIME ZONE 'UTC' yields timestamp without time zone, so to_char is session-TZ-safe.
    let win: (String, String) = sqlx::query_as(&format!(
        "SELECT to_char((((now() AT TIME ZONE $1) - ($2::int * interval '1 day')) AT TIME ZONE $1) AT TIME ZONE 'UTC', '{TS}'),
                to_char(now() AT TIME ZONE 'UTC', '{TS}')"))
        .bind(&tz).bind(days).fetch_one(&s.db).await?;
    let (from, now_utc) = win;
    // One extra look-back day of drives so a park that started just before the window still appears.
    let drive_from: String = sqlx::query_scalar(&format!(
        "SELECT to_char((replace(replace($1, 'T', ' '), 'Z', '')::timestamp - interval '2 days'), '{TS}')"))
        .bind(&from).fetch_one(&s.db).await?;
    // TeslaMate stores UTC in timestamp-without-time-zone. Format with to_char(col, …) directly —
    // `to_char(col AT TIME ZONE 'UTC', …)` re-interprets through the session TimeZone and can shift
    // the wall clock while still appending "Z" (see main.rs drive list, which formats the same way).
    let edges = sqlx::query_as::<_, DriveEdge>(
        &format!("SELECT d.id::int8 AS id,
                to_char(d.start_date, '{TS}') AS start_date,
                to_char(d.end_date, '{TS}') AS end_date,
                sp.battery_level::int4 AS start_soc, ep.battery_level::int4 AS end_soc,
                d.start_rated_range_km::float8 AS start_rated_km, d.end_rated_range_km::float8 AS end_rated_km
         FROM drives d
         LEFT JOIN positions sp ON sp.id = d.start_position_id
         LEFT JOIN positions ep ON ep.id = d.end_position_id
         WHERE d.car_id = $1 AND d.end_date IS NOT NULL
           AND d.end_date >= replace(replace($2, 'T', ' '), 'Z', '')::timestamp
         ORDER BY d.end_date ASC, d.id ASC")).bind(id as i16).bind(&drive_from).fetch_all(&s.db).await?;
    // Completed charges always count. Open (end_date IS NULL) rows only count when recent —
    // otherwise a forgotten open session would extend to "now" and punch out every park since.
    let charges = sqlx::query_as::<_, ChargeWin>(
        &format!("SELECT to_char(start_date, '{TS}') AS start_date,
                to_char(COALESCE(end_date, now() AT TIME ZONE 'UTC'), '{TS}') AS end_date,
                start_battery_level::int4 AS start_soc, end_battery_level::int4 AS end_soc,
                start_rated_range_km::float8 AS start_rated_km, end_rated_range_km::float8 AS end_rated_km
         FROM charging_processes
         WHERE car_id = $1
           AND start_date < replace(replace($3, 'T', ' '), 'Z', '')::timestamp
           AND COALESCE(end_date, now() AT TIME ZONE 'UTC') > replace(replace($2, 'T', ' '), 'Z', '')::timestamp
           AND (
             end_date IS NOT NULL
             OR start_date >= (now() AT TIME ZONE 'UTC') - make_interval(hours => $4)
           )"))
        .bind(id as i16).bind(&drive_from).bind(&now_utc).bind(VAMPIRE_ACTIVE_CHARGE_HOURS)
        .fetch_all(&s.db).await?;
    // Latest position for the ongoing park (PK / recent date — same pattern as /status).
    let latest: Option<(Option<i32>, Option<f64>, Option<String>)> = sqlx::query_as(
        &format!("SELECT battery_level::int4, rated_battery_range_km::float8,
                to_char(date, '{TS}')
         FROM positions WHERE car_id = $1 ORDER BY date DESC LIMIT 1")).bind(id as i16).fetch_optional(&s.db).await?;
    let drive_tuples: Vec<_> = edges.iter().map(|e| {
        (e.id, e.start_date.clone(), e.end_date.clone(), e.start_soc, e.end_soc, e.start_rated_km, e.end_rated_km)
    }).collect();
    let charge_tuples: Vec<VampireCharge> = charges.iter().map(|c| (
        c.start_date.clone(), c.end_date.clone(), c.start_soc, c.end_soc, c.start_rated_km, c.end_rated_km,
    )).collect();
    let now_opt = latest.and_then(|(soc, rated, date)| date.map(|d| (d, soc, rated)));
    let periods = build_vampire_periods(&drive_tuples, &charge_tuples, now_opt, &from);
    let mut parked_hours = 0.0;
    let mut soc_lost = 0i32;
    let mut range_lost = 0.0;
    let mut soc_n = 0i32;
    let mut range_n = 0i32;
    for p in &periods {
        parked_hours += p.duration_hours;
        if let Some(s) = p.soc_lost { soc_lost += s; soc_n += 1; }
        if let Some(r) = p.range_lost_km { range_lost += r; range_n += 1; }
    }
    let soc_opt = if soc_n > 0 { Some(soc_lost) } else { None };
    let range_opt = if range_n > 0 { Some(r1(range_lost)) } else { None };
    let (avg_soc, avg_range) = vampire_averages(soc_opt, range_opt, parked_hours);
    let summary = serde_json::json!({
        "parked_hours": r1(parked_hours),
        "soc_lost_pct": soc_opt,
        "range_lost_km": range_opt,
        "avg_soc_per_day": avg_soc,
        "avg_range_km_per_day": avg_range,
        "period_count": periods.len(),
    });
    let period_json: Vec<_> = periods.iter().take(60).map(|p| serde_json::json!({
        "start": p.start, "end": p.end, "duration_hours": p.duration_hours,
        "start_soc": p.start_soc, "end_soc": p.end_soc, "soc_lost": p.soc_lost,
        "start_rated_km": p.start_rated_km, "end_rated_km": p.end_rated_km, "range_lost_km": p.range_lost_km,
        "ongoing": p.ongoing,
        "after_drive_id": p.after_drive_id, "before_drive_id": p.before_drive_id,
    })).collect();
    Ok(Json(serde_json::json!({
        "days": days, "timezone": tz, "from": from,
        "summary": summary, "periods": period_json,
    })).into_response())
}

#[cfg(test)]
mod vampire_tests {
    use super::*;

    fn d(id: i64, start: &str, end: &str, ss: i32, es: i32, sr: f64, er: f64)
        -> (i64, String, String, Option<i32>, Option<i32>, Option<f64>, Option<f64>)
    {
        (id, start.into(), end.into(), Some(ss), Some(es), Some(sr), Some(er))
    }

    fn c(start: &str, end: &str, ss: i32, es: i32, sr: f64, er: f64) -> VampireCharge {
        (start.into(), end.into(), Some(ss), Some(es), Some(sr), Some(er))
    }

    #[test]
    fn keeps_uncharged_overnight_and_splits_around_home_charge() {
        // Realistic TeslaMate-shaped fixture: commute + overnight home charge.
        // Drive 1 → 2: pure parked overnight, −2% SoC (must appear).
        // Drive 2 → 3: park 09:00, plug in 22:00–06:00, leave 08:00.
        //   Old bug: whole gap dropped because a charge overlapped → home chargers saw 0 periods.
        //   Fix: keep 09:00→22:00 (−2%) and 06:00→08:00 (−1%); drop only the charging window.
        let drives = vec![
            d(1, "2026-10-01T08:00:00Z", "2026-10-01T09:00:00Z", 70, 60, 280.0, 240.0),
            d(2, "2026-10-02T08:00:00Z", "2026-10-02T09:00:00Z", 58, 50, 232.0, 200.0),
            d(3, "2026-10-03T08:00:00Z", "2026-10-03T09:00:00Z", 79, 70, 316.0, 280.0),
        ];
        let charges = vec![c("2026-10-02T22:00:00Z", "2026-10-03T06:00:00Z", 48, 80, 192.0, 320.0)];
        let periods = build_vampire_periods(&drives, &charges, None, "2026-09-01T00:00:00Z");
        assert_eq!(periods.len(), 3, "{periods:?}");
        // newest first
        assert_eq!(periods[0].start, "2026-10-03T06:00:00Z");
        assert_eq!(periods[0].soc_lost, Some(1)); // 80 → 79
        assert_eq!(periods[1].start, "2026-10-02T09:00:00Z");
        assert_eq!(periods[1].end, "2026-10-02T22:00:00Z");
        assert_eq!(periods[1].soc_lost, Some(2)); // 50 → 48
        assert_eq!(periods[2].soc_lost, Some(2)); // overnight 60 → 58
        assert_eq!(periods[2].after_drive_id, Some(1));
        assert_eq!(periods[2].before_drive_id, Some(2));
        let g2 = gap_before_drive(&drives, &charges, 2).unwrap();
        assert_eq!(g2.soc_lost, Some(2));
        let g3 = gap_before_drive(&drives, &charges, 3).unwrap();
        assert_eq!(g3.soc_lost, Some(3)); // 2 + 1 from the two free slices
        assert!(g3.duration_hours > 14.0); // 13h + 2h, charging hours excluded
    }

    #[test]
    fn stale_open_charge_extending_to_now_must_not_wipe_history() {
        // Simulates what the SQL used to feed the bucketer: a forgotten charging_processes
        // row with end_date NULL, COALESCE'd to "now", overlapping every park since Oct 1.
        // With whole-gap exclusion that blanked the card; with split + dropping stale opens
        // in SQL, the bucketer must still keep free slices when such a row is NOT passed in.
        let drives = vec![
            d(1, "2026-10-01T08:00:00Z", "2026-10-01T09:00:00Z", 70, 60, 280.0, 240.0),
            d(2, "2026-10-10T08:00:00Z", "2026-10-10T09:00:00Z", 55, 50, 220.0, 200.0),
            d(3, "2026-10-20T08:00:00Z", "2026-10-20T09:00:00Z", 54, 48, 216.0, 192.0),
        ];
        // No charges passed (= SQL filtered the stale open row out) → both parks kept.
        let periods = build_vampire_periods(&drives, &[], None, "2026-09-01T00:00:00Z");
        assert_eq!(periods.len(), 2);
        // If a stale open WERE wrongly passed through as open-until-now, every park vanishes:
        let stale = vec![c("2026-10-01T12:00:00Z", "2026-10-25T00:00:00Z", 58, 58, 232.0, 232.0)];
        let wiped = build_vampire_periods(&drives, &stale, None, "2026-09-01T00:00:00Z");
        // first park 09:00–10th 08:00 overlaps stale from 12:00 → keeps only 09:00–12:00 slice
        // second park fully inside stale → gone
        assert_eq!(wiped.len(), 1);
        assert_eq!(wiped[0].end, "2026-10-01T12:00:00Z");
        assert_eq!(VAMPIRE_ACTIVE_CHARGE_HOURS, 48);
    }

    #[test]
    fn ongoing_park_after_last_drive() {
        let drives = vec![d(1, "2026-10-01T08:00:00Z", "2026-10-01T09:00:00Z", 70, 65, 280.0, 260.0)];
        let periods = build_vampire_periods(
            &drives, &[], Some(("2026-10-02T09:00:00Z".into(), Some(62), Some(248.0))), "2026-09-01T00:00:00Z");
        assert_eq!(periods.len(), 1);
        assert!(periods[0].ongoing);
        assert_eq!(periods[0].soc_lost, Some(3));
        assert_eq!(periods[0].range_lost_km, Some(12.0));
    }

    #[test]
    fn ongoing_park_split_around_active_charge() {
        let drives = vec![d(1, "2026-10-01T08:00:00Z", "2026-10-01T09:00:00Z", 70, 50, 280.0, 200.0)];
        // Plugged in at 18:00; still charging at "now" 22:00.
        let charges = vec![c("2026-10-01T18:00:00Z", "2026-10-01T22:00:00Z", 48, 60, 192.0, 240.0)];
        let periods = build_vampire_periods(
            &drives, &charges, Some(("2026-10-01T22:00:00Z".into(), Some(60), Some(240.0))), "2026-09-01T00:00:00Z");
        // Only the pre-charge slice 09:00–18:00; the "ongoing" part is inside the charge → omitted.
        assert_eq!(periods.len(), 1);
        assert!(!periods[0].ongoing);
        assert_eq!(periods[0].end, "2026-10-01T18:00:00Z");
        assert_eq!(periods[0].soc_lost, Some(2)); // 50 → 48
    }

    #[test]
    fn averages_use_parked_days_not_window_days() {
        // 31% over 138.5 h ≈ 5.775 parked days → ~5.4 %/d (not 31/30 ≈ 1.0)
        let (avg_soc, avg_range) = vampire_averages(Some(31), Some(136.4), 138.5);
        assert_eq!(avg_soc, Some(5.4));
        assert_eq!(avg_range, Some(23.6));
        // no parked time → no average
        assert_eq!(vampire_averages(Some(5), Some(10.0), 0.0), (None, None));
        // 6% over 120 h = 5 parked days → 1.2 %/d
        assert_eq!(vampire_averages(Some(6), Some(26.4), 120.0), (Some(1.2), Some(5.3)));
    }

    #[test]
    fn parse_and_fmt_roundtrip_noon() {
        let s = parse_ts("2026-10-01 12:00:00").unwrap();
        assert_eq!(fmt_ts(s), "2026-10-01T12:00:00Z");
        assert_eq!(parse_ts("2026-10-01T12:00:00Z"), Some(s));
    }
}


#[cfg(test)]
mod battery_trend_tests {
    use super::*;

    fn h(period: &str, odo: f64, cap: f64) -> TrendHalf {
        TrendHalf { period: period.into(), odometer_km: Some(odo), capacity_kwh: cap }
    }

    #[test]
    fn period_day_orders_halves() {
        let a = period_day("2026011").unwrap();
        let b = period_day("2026012").unwrap();
        let c = period_day("2026021").unwrap();
        assert!(a < b && b < c);
    }

    #[test]
    fn insufficient_when_short_span() {
        let halves = vec![
            h("2026101", 10_000.0, 60.0),
            h("2026102", 11_000.0, 59.9),
            h("2026111", 12_000.0, 59.8),
        ];
        let t = compute_battery_trend(&halves, 60.0);
        assert!(!t.enough_time);
        assert!(!t.enough_odo); // km span 2000 < 5000
        assert!(t.pct_per_year.is_none());
        assert!(t.projections.is_empty());
        assert_eq!(t.spark.len(), 3);
    }

    #[test]
    fn rates_and_projections_from_gentle_fade() {
        // ~2% over 40 000 km and ~1 year → about −0.5 %/10k km, roughly −2 %/yr
        let mut halves = Vec::new();
        let new = 60.0_f64;
        for i in 0..8 {
            let month = 1 + i;
            let period = format!("2026{:02}1", month);
            let odo = 20_000.0 + i as f64 * 5_000.0; // 20k .. 55k
            let cap = new * (1.0 - (odo - 20_000.0) / 40_000.0 * 0.02);
            halves.push(h(&period, odo, cap));
        }
        let t = compute_battery_trend(&halves, new);
        assert!(t.enough_time && t.enough_odo);
        let p10 = t.pct_per_10k_km.unwrap();
        let pyr = t.pct_per_year.unwrap();
        assert!(p10 < -0.2 && p10 > -0.8, "p10={p10}");
        assert!(pyr < -1.0 && pyr > -4.0, "pyr={pyr}");
        assert!(!t.no_measurable_degradation);
        assert!(!t.projections.is_empty());
        // 100k is ahead of 55k
        let p100 = t.projections.iter().find(|p| p.odometer_km == 100_000).unwrap();
        assert!(p100.capacity_kwh < new && p100.capacity_kwh >= new * 0.5);
        assert!(p100.health_pct <= 100.0);
        // spark last up to 12
        assert_eq!(t.spark.len(), 8);
    }

    #[test]
    fn rising_capacity_is_no_measurable_degradation() {
        let halves: Vec<_> = (0..6).map(|i| {
            let period = format!("2026{:02}1", i + 1);
            h(&period, 10_000.0 + i as f64 * 3_000.0, 58.0 + i as f64 * 0.2)
        }).collect();
        let t = compute_battery_trend(&halves, 60.0);
        assert!(t.enough_odo && t.enough_time);
        assert_eq!(t.pct_per_10k_km, Some(0.0));
        assert_eq!(t.pct_per_year, Some(0.0));
        assert!(t.no_measurable_degradation);
    }

    #[test]
    fn skips_projection_already_passed() {
        let halves: Vec<_> = (0..6).map(|i| {
            let period = format!("2025{:02}1", i + 1);
            // odo already past 100k
            h(&period, 150_000.0 + i as f64 * 5_000.0, 55.0 - i as f64 * 0.1)
        }).collect();
        let t = compute_battery_trend(&halves, 60.0);
        assert!(t.enough_odo);
        assert!(t.projections.iter().all(|p| p.odometer_km > 175_000 || p.odometer_km == 200_000));
        assert!(t.projections.iter().all(|p| p.odometer_km != 100_000));
    }
}
