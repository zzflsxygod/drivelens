//! api_level 12: monthly footprint (all drive routes of a month) and battery degradation. Read-only.
//! api_level 14: TeslaMate-identical battery health (`tm` object in /battery). Read-only.
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
    let (points, halves): (Vec<TmPoint>, Vec<TmHalf>) = if summary || eff.is_none() { (vec![], vec![]) } else {
        let tz = tz.unwrap_or_else(|| "UTC".into());
        let tz_ok: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = $1)").bind(&tz).fetch_one(&s.db).await?;
        let tz = if tz_ok { tz } else { "UTC".to_string() };
        let base = format!("WITH {aux}, {last},
            l AS (SELECT timezone($2, timezone('UTC', cp.end_date)) AS t, p.odometer, last.cap
                  FROM last JOIN charging_processes cp ON cp.id = last.cp_id JOIN positions p ON p.id = cp.position_id
                  WHERE last.cap IS NOT NULL)");
        let pts = sqlx::query_as::<_, TmPoint>(&format!("{base}
            SELECT to_char(t, 'YYYY-MM-DD') AS date, ROUND(AVG(odometer)::numeric, 1)::float8 AS odometer_km, ROUND(AVG(cap)::numeric, 2)::float8 AS capacity_kwh
            FROM l GROUP BY 1 ORDER BY 1")).bind(id as i32).bind(&tz).fetch_all(&s.db).await?;
        let hs = sqlx::query_as::<_, TmHalf>(&format!("{base}
            SELECT to_char(t, 'YYYYMM') || CASE WHEN to_char(t, 'DD')::int <= 15 THEN '1' ELSE '2' END AS period,
                   ROUND(MIN(odometer)::numeric, 0)::float8 AS odometer_km,
                   ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cap))::numeric, 1)::float8 AS capacity_kwh, COUNT(*) AS n
            FROM l GROUP BY 1 ORDER BY 1")).bind(id as i32).bind(&tz).fetch_all(&s.db).await?;
        (pts, hs)
    };
    Ok(serde_json::json!({
        "method": "teslamate-battery-health",
        "efficiency_kwh_100km": eff.map(r2), "efficiency_source": derived.map(|d| if d { "derived" } else { "car" }),
        "capacity_now_kwh": cur.map(r2), "now_samples": cur_n,
        "capacity_max_kwh": max.map(r2), "capacity_new_kwh": new.map(r2), "new_source": if custom.is_some() { "custom" } else { "max" },
        "health_pct": ratio.map(|r| r1(r.min(100.0))), "degradation_pct": ratio.map(|r| r1((100.0 - r).max(0.0))),
        "cycles": match (kwh, new) { (Some(k), Some(n)) if n > 0.0 => Some((k / n).floor() as i64), _ => None },
        "energy_added_kwh": kwh.map(r1), "charges": n_charges,
        "points": points, "half_months": halves,
    }))
}
