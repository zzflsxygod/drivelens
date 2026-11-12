// SPDX-License-Identifier: AGPL-3.0-or-later
//! Monthly report: GET /api/cars/:id/report?month=YYYY-MM&tz=Asia/Tokyo
//! Read-only. Reads only drives / charging_processes (+ an indexed per-process probe of `charges`), never positions.
//!
//! Charge type rule (3 buckets):
//! - 超充 (supercharger): a DC session (any `charges` row with `fast_charger_present`) that is a Tesla
//!   Supercharger — any row with `fast_charger_brand` = "Tesla" (case-insensitive) or `fast_charger_type`
//!   starting with "Tesla" (same signals TeslaMate uses for free-SuC cost / Grafana SuC panels), OR the
//!   place alias / geofence / address name matches `(supercharger|超充|スーパーチャージャー|tesla)` as a
//!   fallback when the car reports `<invalid>` / null for brand and type.
//! - 家充 (home): an AC session (not DC) at a home-named place (alias/geofence containing home/自宅/家/うち),
//!   or at the car's most frequent AC charging location over the last 12 months.
//! - 其他 (other): everything else (other AC, and non-Tesla DC fast chargers such as CHAdeMO / CCS).
use super::*;
use std::collections::BTreeMap;

#[derive(Deserialize)]
pub struct ReportParams { month: Option<String>, tz: Option<String>, currency: Option<String> }

#[derive(Serialize, Default, Clone)]
pub struct Money { currency: String, amount: f64 }

fn add_money(v: &mut Vec<Money>, cur: &str, amount: f64) {
    match v.iter_mut().find(|m| m.currency == cur) {
        Some(m) => m.amount += amount,
        None => { v.push(Money { currency: cur.to_string(), amount }); v.sort_by(|a, b| a.currency.cmp(&b.currency)); }
    }
}
fn round_money(v: &mut [Money]) { for m in v { m.amount = (m.amount * 100.0).round() / 100.0; } }

#[derive(Serialize, Default)]
pub struct Overview {
    distance_km: f64,
    drive_duration_min: i64,
    drive_count: i64,
    energy_used_kwh: f64,
    energy_added_kwh: f64,
    charge_count: i64,
    costs: Vec<Money>,
    efficiency_wh_km: Option<f64>,
}

#[derive(Serialize)]
pub struct Bucket { kind: &'static str, count: i64, energy_kwh: f64, costs: Vec<Money> }

#[derive(Serialize)]
pub struct Day { date: String, distance_km: f64, energy_added_kwh: f64 }

#[derive(Serialize)]
pub struct DriveRecord { id: i64, start_date: Option<String>, start_address: Option<String>, end_address: Option<String>,
    distance_km: Option<f64>, duration_min: Option<i32>, speed_max: Option<i32> }
#[derive(Serialize)]
pub struct ChargeRecord { id: i64, start_date: Option<String>, address: Option<String>, energy_kwh: Option<f64>,
    cost: Option<f64>, currency: Option<String>, peak_kw: Option<f64>, start_battery_level: Option<i32>,
    end_battery_level: Option<i32>, duration_min: Option<i32> }

#[derive(Serialize)]
pub struct Records { longest_drive: Option<DriveRecord>, top_speed_drive: Option<DriveRecord>,
    most_expensive_charge: Option<ChargeRecord>, fastest_charge: Option<ChargeRecord> }

#[derive(Serialize)]
pub struct Report {
    month: String, timezone: String, is_current: bool, first_month: Option<String>,
    /// local date range covered so far (for the current month: up to today)
    days_in_month: i32, days_elapsed: i32,
    overview: Overview, previous: Overview,
    split: Vec<Bucket>, daily: Vec<Day>, records: Records,
}

#[derive(FromRow)]
pub(crate) struct DriveRow { pub(crate) id: i64, start_date: Option<String>, pub(crate) day: Option<String>, start_address: Option<String>, end_address: Option<String>,
    pub(crate) distance_km: Option<f64>, duration_min: Option<i32>, speed_max: Option<i32>, energy_kwh: Option<f64>, cur: bool }

#[derive(FromRow)]
pub(crate) struct ChargeRow { id: i64, start_date: Option<String>, pub(crate) day: Option<String>, address: Option<String>, pub(crate) energy_kwh: Option<f64>,
    pub(crate) cost: Option<f64>, pub(crate) currency: Option<String>, pub(crate) kind: String, peak_kw: Option<f64>, start_battery_level: Option<i32>,
    end_battery_level: Option<i32>, duration_min: Option<i32>, cur: bool }

#[derive(FromRow)]
struct Bounds { month: String, p0: String, m0: String, m1: String, is_current: bool, days_in_month: i32, days_elapsed: i32 }

const PLACE: &str = "COALESCE(al.name, g.name, CONCAT_WS(', ', COALESCE(a.name, NULLIF(CONCAT_WS(' ', a.road, a.house_number), '')), a.city))";

fn valid_month(m: &str) -> bool {
    let b = m.as_bytes();
    b.len() == 7 && b[4] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || c.is_ascii_digit())
        && matches!(m[5..].parse::<u32>(), Ok(1..=12))
}

pub async fn car_report(State(s): State<AppState>, Path(id): Path<i64>, Query(p): Query<ReportParams>) -> Result<Response, ApiError> {
    let bad = |m: &str| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": m}))).into_response();
    if let Some(m) = &p.month { if !valid_month(m) { return Ok(bad("month must be YYYY-MM")); } }
    let tz = p.tz.unwrap_or_else(|| "UTC".into());
    let def_cur = p.currency.map(|c| c.trim().to_ascii_uppercase())
        .filter(|c| c.len() == 3 && c.bytes().all(|b| b.is_ascii_uppercase())).unwrap_or_else(|| "JPY".into());
    let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM cars WHERE id = $1").bind(id).fetch_optional(&s.db).await?;
    if exists.is_none() { return Ok((StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "car not found"}))).into_response()); }

    // Month boundaries in the user's tz, expressed as TeslaMate's naive-UTC timestamps.
    let bounds = sqlx::query_as::<_, Bounds>(
        "WITH x AS (SELECT COALESCE($1::text, to_char(now() AT TIME ZONE $2, 'YYYY-MM')) AS month),
              l AS (SELECT month, (month || '-01')::timestamp AS lm0 FROM x)
         SELECT month,
           to_char(((lm0 - interval '1 month') AT TIME ZONE $2) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS p0,
           to_char((lm0 AT TIME ZONE $2) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS m0,
           to_char(((lm0 + interval '1 month') AT TIME ZONE $2) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS m1,
           month = to_char(now() AT TIME ZONE $2, 'YYYY-MM') AS is_current,
           extract(day from lm0 + interval '1 month' - interval '1 day')::int4 AS days_in_month,
           LEAST(GREATEST(extract(day from (now() AT TIME ZONE $2) - lm0)::int4 + 1, 0),
                 extract(day from lm0 + interval '1 month' - interval '1 day')::int4) AS days_elapsed
         FROM l",
    ).bind(&p.month).bind(&tz).fetch_one(&s.db).await;
    let b = match bounds {
        Ok(b) => b,
        Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("22023") => return Ok(bad("unknown tz")),
        Err(e) => return Err(e.into()),
    };
    if b.month.as_str() > sqlx::query_scalar::<_, String>("SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM')").bind(&tz).fetch_one(&s.db).await?.as_str() {
        return Ok(bad("month is in the future"));
    }
    let costs = costs_ok(&s).await?;
    let (cc_amount, cc_cur, cc_join) = if costs {
        ("COALESCE(cc.amount, cp.cost)", format!("COALESCE(cc.currency::text, {LOC_CURRENCY})"), "LEFT JOIN drivelens.charge_costs cc ON cc.charging_process_id = cp.id")
    } else { ("cp.cost", LOC_CURRENCY.to_string(), "") };

    let al = alias_table(&s).await?;
    let drives_sql = drives_sql(al);
    let charges_sql = charges_sql(cc_amount, &cc_cur, cc_join, al);
    let (drives, charges, first) = tokio::try_join!(
        sqlx::query_as::<_, DriveRow>(&drives_sql).bind(id).bind(&b.p0).bind(&b.m0).bind(&b.m1).bind(&tz).fetch_all(&s.db),
        sqlx::query_as::<_, ChargeRow>(&charges_sql).bind(id).bind(&b.p0).bind(&b.m0).bind(&b.m1).bind(&tz).fetch_all(&s.db),
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT to_char((min(start_date) AT TIME ZONE 'UTC') AT TIME ZONE $2, 'YYYY-MM') FROM drives WHERE car_id = $1").bind(id).bind(&tz).fetch_one(&s.db),
    )?;

    let (mut ov, mut prev) = (Overview::default(), Overview::default());
    let mut days: BTreeMap<String, (f64, f64)> = BTreeMap::new();
    for i in 0..b.days_in_month { days.insert(format!("{}-{:02}", b.month, i + 1), (0.0, 0.0)); }
    for d in &drives {
        let o = if d.cur { &mut ov } else { &mut prev };
        o.distance_km += d.distance_km.unwrap_or(0.0);
        o.drive_duration_min += d.duration_min.unwrap_or(0) as i64;
        o.drive_count += 1;
        o.energy_used_kwh += d.energy_kwh.unwrap_or(0.0).max(0.0);
        if d.cur { if let Some(e) = d.day.as_ref().and_then(|k| days.get_mut(k)) { e.0 += d.distance_km.unwrap_or(0.0); } }
    }
    let mut split: Vec<Bucket> = ["home", "supercharger", "other"].iter()
        .map(|k| Bucket { kind: k, count: 0, energy_kwh: 0.0, costs: vec![] }).collect();
    for c in &charges {
        let cur = c.currency.clone().unwrap_or_else(|| def_cur.clone());
        let o = if c.cur { &mut ov } else { &mut prev };
        o.energy_added_kwh += c.energy_kwh.unwrap_or(0.0);
        o.charge_count += 1;
        if let Some(a) = c.cost { add_money(&mut o.costs, &cur, a); }
        if c.cur {
            if let Some(e) = c.day.as_ref().and_then(|k| days.get_mut(k)) { e.1 += c.energy_kwh.unwrap_or(0.0); }
            let bk = split.iter_mut().find(|x| x.kind == c.kind).unwrap();
            bk.count += 1; bk.energy_kwh += c.energy_kwh.unwrap_or(0.0);
            if let Some(a) = c.cost { add_money(&mut bk.costs, &cur, a); }
        }
    }
    let r1 = |v: f64| (v * 10.0).round() / 10.0;
    for o in [&mut ov, &mut prev] {
        o.efficiency_wh_km = (o.distance_km > 0.0).then(|| r1(o.energy_used_kwh * 1000.0 / o.distance_km));
        o.distance_km = r1(o.distance_km); o.energy_used_kwh = r1(o.energy_used_kwh); o.energy_added_kwh = r1(o.energy_added_kwh);
        round_money(&mut o.costs);
    }
    for bk in &mut split { bk.energy_kwh = r1(bk.energy_kwh); round_money(&mut bk.costs); }

    let cur_d: Vec<&DriveRow> = drives.iter().filter(|d| d.cur).collect();
    let cur_c: Vec<&ChargeRow> = charges.iter().filter(|c| c.cur).collect();
    let dr = |d: &DriveRow| DriveRecord { id: d.id, start_date: d.start_date.clone(), start_address: d.start_address.clone(),
        end_address: d.end_address.clone(), distance_km: d.distance_km, duration_min: d.duration_min, speed_max: d.speed_max };
    let cr = |c: &ChargeRow| ChargeRecord { id: c.id, start_date: c.start_date.clone(), address: c.address.clone(), energy_kwh: c.energy_kwh,
        cost: c.cost, currency: c.cost.map(|_| c.currency.clone().unwrap_or_else(|| def_cur.clone())), peak_kw: c.peak_kw,
        start_battery_level: c.start_battery_level, end_battery_level: c.end_battery_level, duration_min: c.duration_min };
    let fmax = |a: Option<f64>, b: Option<f64>| a.unwrap_or(f64::MIN).total_cmp(&b.unwrap_or(f64::MIN));
    // Most expensive: compare within the main currency (default currency first), other currencies only if none.
    let exp = cur_c.iter().filter(|c| c.cost.is_some() && c.currency.as_deref().unwrap_or(&def_cur) == def_cur)
        .max_by(|a, b| fmax(a.cost, b.cost))
        .or_else(|| cur_c.iter().filter(|c| c.cost.is_some()).max_by(|a, b| fmax(a.cost, b.cost)));
    let records = Records {
        longest_drive: cur_d.iter().filter(|d| d.distance_km.is_some()).max_by(|a, b| fmax(a.distance_km, b.distance_km)).map(|d| dr(d)),
        top_speed_drive: cur_d.iter().filter(|d| d.speed_max.is_some()).max_by_key(|d| d.speed_max).map(|d| dr(d)),
        most_expensive_charge: exp.map(|c| cr(c)),
        fastest_charge: cur_c.iter().filter(|c| c.peak_kw.unwrap_or(0.0) > 0.0).max_by(|a, b| fmax(a.peak_kw, b.peak_kw)).map(|c| cr(c)),
    };
    let daily = days.into_iter().map(|(date, (km, kwh))| Day { date, distance_km: r1(km), energy_added_kwh: r1(kwh) }).collect();
    Ok(Json(Report { month: b.month, timezone: tz, is_current: b.is_current, first_month: first, days_in_month: b.days_in_month,
        days_elapsed: b.days_elapsed, overview: ov, previous: prev, split, daily, records }).into_response())
}

/// `al`: alias relation from `alias_table` (also for `charges_sql`).
pub(crate) fn drives_sql(al: &str) -> String { format!(
        r#"SELECT d.id::int8 AS id, to_char(d.start_date, '{TS}') AS start_date,
             to_char((d.start_date AT TIME ZONE 'UTC') AT TIME ZONE $5, 'YYYY-MM-DD') AS day,
             COALESCE(sal.name, gs.name, CONCAT_WS(', ', COALESCE(sa.name, NULLIF(CONCAT_WS(' ', sa.road, sa.house_number), '')), sa.city)) AS start_address,
             COALESCE(eal.name, ge.name, CONCAT_WS(', ', COALESCE(ea.name, NULLIF(CONCAT_WS(' ', ea.road, ea.house_number), '')), ea.city)) AS end_address,
             d.distance::float8 AS distance_km, d.duration_min::int4 AS duration_min, d.speed_max::int4 AS speed_max,
             ((d.start_rated_range_km - d.end_rated_range_km) * c.efficiency)::float8 AS energy_kwh,
             d.start_date >= $3::timestamp AS cur
           FROM drives d JOIN cars c ON c.id = d.car_id
           LEFT JOIN addresses sa ON sa.id = d.start_address_id
           LEFT JOIN addresses ea ON ea.id = d.end_address_id
           LEFT JOIN {al} sal ON sal.address_id = d.start_address_id
           LEFT JOIN {al} eal ON eal.address_id = d.end_address_id
           LEFT JOIN geofences gs ON gs.id = d.start_geofence_id
           LEFT JOIN geofences ge ON ge.id = d.end_geofence_id
           WHERE d.car_id = $1 AND d.start_date >= $2::timestamp AND d.start_date < $4::timestamp AND d.end_date IS NOT NULL"#
    ) }
// home_addr: most frequent AC-rate (< 22 kW average) charging location in the last 12 months — no charges scan needed.
pub(crate) fn charges_sql(cc_amount: &str, cc_cur: &str, cc_join: &str, al: &str) -> String { format!(
        r#"WITH home_addr AS (
             SELECT address_id FROM charging_processes
             WHERE car_id = $1 AND address_id IS NOT NULL AND start_date >= $4::timestamp - interval '12 months'
               AND duration_min > 0 AND charge_energy_added * 60 / duration_min < 22
             GROUP BY address_id ORDER BY count(*) DESC LIMIT 1)
           SELECT cp.id::int8 AS id, to_char(cp.start_date, '{TS}') AS start_date,
             to_char((cp.start_date AT TIME ZONE 'UTC') AT TIME ZONE $5, 'YYYY-MM-DD') AS day,
             {PLACE} AS address, cp.charge_energy_added::float8 AS energy_kwh,
             {cc_amount}::float8 AS cost, {cc_cur} AS currency,
             CASE WHEN fx.fast AND (fx.tesla_fc
                       OR CONCAT_WS(' ', al.name, g.name, a.name, a.display_name) ~* '(supercharger|超充|スーパーチャージャー|tesla)') THEN 'supercharger'
                  WHEN NOT fx.fast AND (CONCAT_WS(' ', al.name, g.name) ~* '(home|自宅|家|うち|house)'
                       OR cp.address_id = (SELECT address_id FROM home_addr)) THEN 'home'
                  ELSE 'other' END AS kind,
             fx.peak_kw, cp.start_battery_level::int4 AS start_battery_level, cp.end_battery_level::int4 AS end_battery_level,
             cp.duration_min::int4 AS duration_min, cp.start_date >= $3::timestamp AS cur
           FROM charging_processes cp
           LEFT JOIN addresses a ON a.id = cp.address_id
           LEFT JOIN {al} al ON al.address_id = cp.address_id
           LEFT JOIN geofences g ON g.id = cp.geofence_id
           LEFT JOIN positions p ON p.id = cp.position_id
           {cc_join}
           -- per-process probe via TeslaMate's charges(charging_process_id) index
           CROSS JOIN LATERAL (SELECT COALESCE(bool_or(ch.fast_charger_present), false) AS fast,
                                      COALESCE(bool_or(
                                        ch.fast_charger_brand ~* '^tesla$'
                                        OR ch.fast_charger_type ~* '^tesla'
                                      ), false) AS tesla_fc,
                                      max(ch.charger_power)::float8 AS peak_kw
                               FROM charges ch WHERE ch.charging_process_id = cp.id) fx
           WHERE cp.car_id = $1 AND cp.start_date >= $2::timestamp AND cp.start_date < $4::timestamp AND cp.end_date IS NOT NULL"#
    ) }

// ---------------- 12-month trends (api_level 12) ----------------
#[derive(Serialize, Default)]
pub struct TrendMonth { month: String, distance_km: f64, energy_used_kwh: f64, energy_added_kwh: f64, efficiency_wh_km: Option<f64>,
    drive_count: i64, charge_count: i64, costs: Vec<Money>, home_kwh: f64, supercharger_kwh: f64, other_kwh: f64 }

/// GET /api/cars/:id/trends?month=YYYY-MM&tz=&currency= → the 12 months ending with `month` (same rules as the report).
pub async fn car_trends(State(s): State<AppState>, Path(id): Path<i64>, Query(p): Query<ReportParams>) -> Result<Response, ApiError> {
    let bad = |m: &str| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": m}))).into_response();
    if let Some(m) = &p.month { if !valid_month(m) { return Ok(bad("month must be YYYY-MM")); } }
    let tz = p.tz.unwrap_or_else(|| "UTC".into());
    let def_cur = p.currency.map(|c| c.trim().to_ascii_uppercase())
        .filter(|c| c.len() == 3 && c.bytes().all(|b| b.is_ascii_uppercase())).unwrap_or_else(|| "JPY".into());
    let r: Result<(String, String, Vec<String>), _> = sqlx::query_as(
        "WITH x AS (SELECT (COALESCE($1::text, to_char(now() AT TIME ZONE $2, 'YYYY-MM')) || '-01')::timestamp AS lm0)
         SELECT to_char(((lm0 - interval '11 months') AT TIME ZONE $2) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
                to_char(((lm0 + interval '1 month') AT TIME ZONE $2) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
                ARRAY(SELECT to_char(lm0 - make_interval(months => g), 'YYYY-MM') FROM generate_series(11, 0, -1) g)
         FROM x").bind(&p.month).bind(&tz).fetch_one(&s.db).await;
    let (t0, t1, months) = match r {
        Ok(v) => v,
        Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("22023") => return Ok(bad("unknown tz")),
        Err(e) => return Err(e.into()),
    };
    let costs = costs_ok(&s).await?;
    let (cc_amount, cc_cur, cc_join) = if costs {
        ("COALESCE(cc.amount, cp.cost)", format!("COALESCE(cc.currency::text, {LOC_CURRENCY})"), "LEFT JOIN drivelens.charge_costs cc ON cc.charging_process_id = cp.id")
    } else { ("cp.cost", LOC_CURRENCY.to_string(), "") };
    let al = alias_table(&s).await?;
    let (dsql, csql) = (drives_sql(al), charges_sql(cc_amount, &cc_cur, cc_join, al));
    let (drives, charges) = tokio::try_join!(
        sqlx::query_as::<_, DriveRow>(&dsql).bind(id).bind(&t0).bind(&t0).bind(&t1).bind(&tz).fetch_all(&s.db),
        sqlx::query_as::<_, ChargeRow>(&csql).bind(id).bind(&t0).bind(&t0).bind(&t1).bind(&tz).fetch_all(&s.db),
    )?;
    let mut by: BTreeMap<String, TrendMonth> = months.iter().map(|m| (m.clone(), TrendMonth { month: m.clone(), ..Default::default() })).collect();
    for d in &drives {
        let Some(m) = d.day.as_ref().and_then(|x| by.get_mut(&x[..7])) else { continue };
        m.distance_km += d.distance_km.unwrap_or(0.0); m.energy_used_kwh += d.energy_kwh.unwrap_or(0.0).max(0.0); m.drive_count += 1;
    }
    for c in &charges {
        let Some(m) = c.day.as_ref().and_then(|x| by.get_mut(&x[..7])) else { continue };
        let e = c.energy_kwh.unwrap_or(0.0);
        m.energy_added_kwh += e; m.charge_count += 1;
        match c.kind.as_str() { "home" => m.home_kwh += e, "supercharger" => m.supercharger_kwh += e, _ => m.other_kwh += e }
        if let Some(a) = c.cost { add_money(&mut m.costs, &c.currency.clone().unwrap_or_else(|| def_cur.clone()), a); }
    }
    let r1 = |v: f64| (v * 10.0).round() / 10.0;
    let out: Vec<TrendMonth> = by.into_values().map(|mut m| {
        m.efficiency_wh_km = (m.distance_km > 1.0).then(|| r1(m.energy_used_kwh * 1000.0 / m.distance_km));
        m.distance_km = r1(m.distance_km); m.energy_used_kwh = r1(m.energy_used_kwh); m.energy_added_kwh = r1(m.energy_added_kwh);
        m.home_kwh = r1(m.home_kwh); m.supercharger_kwh = r1(m.supercharger_kwh); m.other_kwh = r1(m.other_kwh);
        round_money(&mut m.costs); m }).collect();
    Ok(Json(serde_json::json!({"months": out, "timezone": tz})).into_response())
}

// ---------------- api_level 18: charging cost stats (cross-month unit economics) ----------------

#[derive(Deserialize)]
pub struct ChargingCostParams {
    /// Look-back window in calendar months ending with the current local month (default 12, clamped 1..=24).
    months: Option<i32>,
    tz: Option<String>,
    currency: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CostSession {
    pub month: String,
    pub kind: String,
    pub energy_kwh: f64,
    pub cost: Option<f64>,
    pub currency: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DriveMonthDist {
    pub month: String,
    pub distance_km: f64,
}

fn r1(v: f64) -> f64 { (v * 10.0).round() / 10.0 }
fn r2(v: f64) -> f64 { (v * 100.0).round() / 100.0 }

/// Amount ÷ divisor, rounded to 0.01. None when the divisor is not positive.
pub fn unit_rate(amount: f64, divisor: f64) -> Option<f64> {
    if divisor > 0.0 { Some(r2(amount / divisor)) } else { None }
}

/// Cost per 100 km = amount ÷ distance × 100. None when distance is not positive.
pub fn cost_per_100km(amount: f64, distance_km: f64) -> Option<f64> {
    if distance_km > 0.0 { Some(r2(amount / distance_km * 100.0)) } else { None }
}

/// Share of charged energy that has a recorded cost, 0–100. None when no energy.
pub fn coverage_pct(priced_kwh: f64, energy_kwh: f64) -> Option<f64> {
    if energy_kwh > 0.0 { Some(r1(priced_kwh.max(0.0) / energy_kwh * 100.0)) } else { None }
}

fn money_list(map: &std::collections::BTreeMap<String, f64>) -> Vec<serde_json::Value> {
    map.iter().map(|(c, a)| serde_json::json!({"currency": c, "amount": r2(*a)})).collect()
}

fn rate_list(costs: &std::collections::BTreeMap<String, f64>, divisor: f64) -> Vec<serde_json::Value> {
    costs.iter().filter_map(|(c, a)| unit_rate(*a, divisor).map(|r| serde_json::json!({"currency": c, "amount": r}))).collect()
}

fn per100_list(costs: &std::collections::BTreeMap<String, f64>, distance_km: f64) -> Vec<serde_json::Value> {
    costs.iter().filter_map(|(c, a)| cost_per_100km(*a, distance_km).map(|r| serde_json::json!({"currency": c, "amount": r}))).collect()
}

/// Aggregate sessions + drive distances into the charging-costs payload (pure; unit-tested).
pub fn build_charging_costs(
    month_keys: &[String],
    sessions: &[CostSession],
    drives: &[DriveMonthDist],
) -> serde_json::Value {
    let mut distance = 0.0f64;
    let mut by_month_dist: std::collections::BTreeMap<String, f64> =
        month_keys.iter().map(|m| (m.clone(), 0.0)).collect();
    for d in drives {
        if let Some(v) = by_month_dist.get_mut(&d.month) { *v += d.distance_km; distance += d.distance_km; }
    }

    let mut energy = 0.0f64;
    let mut charge_count = 0i64;
    let mut priced_count = 0i64;
    let mut priced_kwh = 0.0f64;
    let mut totals: std::collections::BTreeMap<String, f64> = std::collections::BTreeMap::new();
    let mut split: std::collections::BTreeMap<&'static str, (i64, f64, std::collections::BTreeMap<String, f64>, f64)> =
        ["home", "supercharger", "other"].into_iter().map(|k| (k, (0, 0.0, std::collections::BTreeMap::new(), 0.0))).collect();

    struct MonthAgg {
        energy: f64,
        charge_count: i64,
        priced_count: i64,
        priced_kwh: f64,
        costs: std::collections::BTreeMap<String, f64>,
    }
    let mut months: std::collections::BTreeMap<String, MonthAgg> = month_keys.iter().map(|m| (m.clone(), MonthAgg {
        energy: 0.0, charge_count: 0, priced_count: 0, priced_kwh: 0.0, costs: std::collections::BTreeMap::new(),
    })).collect();

    for s in sessions {
        let Some(m) = months.get_mut(&s.month) else { continue };
        let e = s.energy_kwh.max(0.0);
        energy += e; charge_count += 1;
        m.energy += e; m.charge_count += 1;
        let kind = match s.kind.as_str() { "home" => "home", "supercharger" => "supercharger", _ => "other" };
        let bk = split.get_mut(kind).unwrap();
        bk.0 += 1; bk.1 += e;
        if let Some(a) = s.cost {
            priced_count += 1; priced_kwh += e;
            m.priced_count += 1; m.priced_kwh += e;
            *totals.entry(s.currency.clone()).or_default() += a;
            *m.costs.entry(s.currency.clone()).or_default() += a;
            *bk.2.entry(s.currency.clone()).or_default() += a;
            bk.3 += e; // priced energy in this bucket
        }
    }

    let monthly: Vec<_> = month_keys.iter().map(|k| {
        let m = months.get(k).unwrap();
        let dist = *by_month_dist.get(k).unwrap_or(&0.0);
        serde_json::json!({
            "month": k,
            "distance_km": r1(dist),
            "energy_added_kwh": r1(m.energy),
            "charge_count": m.charge_count,
            "priced_count": m.priced_count,
            "costs": money_list(&m.costs),
            "cost_per_kwh": rate_list(&m.costs, m.priced_kwh),
            "cost_per_100km": per100_list(&m.costs, dist),
        })
    }).collect();

    let split_json: Vec<_> = ["home", "supercharger", "other"].iter().map(|k| {
        let (count, e, costs, priced_e) = split.get(k).unwrap();
        serde_json::json!({
            "kind": k,
            "count": count,
            "energy_kwh": r1(*e),
            "costs": money_list(costs),
            "cost_per_kwh": rate_list(costs, *priced_e),
        })
    }).collect();

    serde_json::json!({
        "summary": {
            "distance_km": r1(distance),
            "energy_added_kwh": r1(energy),
            "charge_count": charge_count,
            "priced_count": priced_count,
            "priced_kwh": r1(priced_kwh),
            "costs": money_list(&totals),
            "cost_per_kwh": rate_list(&totals, priced_kwh),
            "cost_per_100km": per100_list(&totals, distance),
            "coverage_pct": coverage_pct(priced_kwh, energy),
        },
        "split": split_json,
        "monthly": monthly,
    })
}

/// GET /api/cars/:id/charging-costs?months=12&tz=&currency=
/// Cross-month charging spend with ¥/kWh, ¥/100 km and home / Supercharger / other unit prices.
pub async fn charging_costs(State(s): State<AppState>, Path(id): Path<i64>, Query(p): Query<ChargingCostParams>) -> Result<Response, ApiError> {
    let bad = |m: &str| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": m}))).into_response();
    let n_months = p.months.unwrap_or(12).clamp(1, 24);
    let tz = p.tz.unwrap_or_else(|| "UTC".into());
    let def_cur = p.currency.map(|c| c.trim().to_ascii_uppercase())
        .filter(|c| c.len() == 3 && c.bytes().all(|b| b.is_ascii_uppercase())).unwrap_or_else(|| "JPY".into());
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM cars WHERE id = $1)").bind(id as i16).fetch_one(&s.db).await?;
    if !exists { return Ok((StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "car not found"}))).into_response()); }

    // Window: n_months local months ending with the current month (same shape as trends).
    let r: Result<(String, String, Vec<String>, String, String), _> = sqlx::query_as(
        "WITH x AS (SELECT (to_char(now() AT TIME ZONE $1, 'YYYY-MM') || '-01')::timestamp AS lm0)
         SELECT to_char(((lm0 - make_interval(months => $2::int - 1)) AT TIME ZONE $1) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
                to_char(((lm0 + interval '1 month') AT TIME ZONE $1) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
                ARRAY(SELECT to_char(lm0 - make_interval(months => g), 'YYYY-MM') FROM generate_series($2::int - 1, 0, -1) g),
                to_char(lm0 - make_interval(months => $2::int - 1), 'YYYY-MM'),
                to_char(lm0, 'YYYY-MM')
         FROM x").bind(&tz).bind(n_months).fetch_one(&s.db).await;
    let (t0, t1, months, from_month, to_month) = match r {
        Ok(v) => v,
        Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("22023") => return Ok(bad("unknown tz")),
        Err(e) => return Err(e.into()),
    };

    let costs = costs_ok(&s).await?;
    let (cc_amount, cc_cur, cc_join) = if costs {
        ("COALESCE(cc.amount, cp.cost)", format!("COALESCE(cc.currency::text, {LOC_CURRENCY})"), "LEFT JOIN drivelens.charge_costs cc ON cc.charging_process_id = cp.id")
    } else { ("cp.cost", LOC_CURRENCY.to_string(), "") };
    let al = alias_table(&s).await?;
    let (dsql, csql) = (report::drives_sql(al), report::charges_sql(cc_amount, &cc_cur, cc_join, al));
    // drives_sql / charges_sql bind: $1 car, $2 from (prev for report), $3 cur0, $4 to, $5 tz
    // For a single window we set prev = cur0 = t0 so every row is "current".
    let (drives, charges) = tokio::try_join!(
        sqlx::query_as::<_, report::DriveRow>(&dsql).bind(id).bind(&t0).bind(&t0).bind(&t1).bind(&tz).fetch_all(&s.db),
        sqlx::query_as::<_, report::ChargeRow>(&csql).bind(id).bind(&t0).bind(&t0).bind(&t1).bind(&tz).fetch_all(&s.db),
    )?;

    let sessions: Vec<CostSession> = charges.iter().filter_map(|c| {
        let month = c.day.as_ref()?.get(..7)?.to_string();
        Some(CostSession {
            month,
            kind: c.kind.clone(),
            energy_kwh: c.energy_kwh.unwrap_or(0.0),
            cost: c.cost,
            currency: c.currency.clone().unwrap_or_else(|| def_cur.clone()),
        })
    }).collect();
    let drive_months: Vec<DriveMonthDist> = drives.iter().filter_map(|d| {
        let month = d.day.as_ref()?.get(..7)?.to_string();
        Some(DriveMonthDist { month, distance_km: d.distance_km.unwrap_or(0.0) })
    }).collect();

    let mut body = build_charging_costs(&months, &sessions, &drive_months);
    if let Some(obj) = body.as_object_mut() {
        obj.insert("months".into(), serde_json::json!(n_months));
        obj.insert("timezone".into(), serde_json::json!(tz));
        obj.insert("from_month".into(), serde_json::json!(from_month));
        obj.insert("to_month".into(), serde_json::json!(to_month));
    }
    Ok(Json(body).into_response())
}


// ---------------- api_level 20: year in review ----------------

#[derive(Deserialize)]
pub struct YearParams { year: Option<i32>, tz: Option<String>, currency: Option<String> }

#[derive(Clone, Debug)]
pub struct YrDrive {
    pub month: String,
    pub id: i64,
    pub start_date: Option<String>,
    pub start_address: Option<String>,
    pub end_address: Option<String>,
    pub distance_km: f64,
    pub duration_min: i32,
    pub energy_used_kwh: f64,
    pub end_place: String,
}

#[derive(Clone, Debug)]
pub struct YrCharge {
    pub month: String,
    pub kind: String,
    pub energy_kwh: f64,
    pub cost: Option<f64>,
    pub currency: String,
    pub place: String,
}

#[derive(Clone, Debug)]
pub struct YrJourney {
    pub id: i64,
    pub name: String,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub start_address: Option<String>,
    pub end_address: Option<String>,
    pub distance_km: f64,
    pub duration_min: i64,
}

#[derive(Clone, Debug, Default)]
pub struct YearTotals {
    pub distance_km: f64,
    pub drive_count: i64,
    pub drive_duration_min: i64,
    pub energy_used_kwh: f64,
    pub energy_added_kwh: f64,
    pub charge_count: i64,
    pub priced_kwh: f64,
    pub costs: BTreeMap<String, f64>,
    pub home_kwh: f64,
    pub supercharger_kwh: f64,
    pub other_kwh: f64,
}

fn year_money(map: &BTreeMap<String, f64>) -> Vec<serde_json::Value> {
    map.iter().map(|(c, a)| serde_json::json!({"currency": c, "amount": r2(*a)})).collect()
}

fn year_per100(map: &BTreeMap<String, f64>, distance_km: f64) -> Vec<serde_json::Value> {
    map.iter().filter_map(|(c, a)| {
        cost_per_100km(*a, distance_km).map(|v| serde_json::json!({"currency": c, "amount": v}))
    }).collect()
}

fn year_per_kwh(map: &BTreeMap<String, f64>, priced_kwh: f64) -> Vec<serde_json::Value> {
    map.iter().filter_map(|(c, a)| {
        unit_rate(*a, priced_kwh).map(|v| serde_json::json!({"currency": c, "amount": v}))
    }).collect()
}

fn totals_json(t: &YearTotals) -> serde_json::Value {
    let eff = (t.distance_km > 1.0).then(|| r1(t.energy_used_kwh * 1000.0 / t.distance_km));
    serde_json::json!({
        "distance_km": r1(t.distance_km),
        "drive_count": t.drive_count,
        "drive_duration_min": t.drive_duration_min,
        "energy_used_kwh": r1(t.energy_used_kwh),
        "efficiency_wh_km": eff,
        "charge_count": t.charge_count,
        "energy_added_kwh": r1(t.energy_added_kwh),
        "priced_kwh": r1(t.priced_kwh),
        "costs": year_money(&t.costs),
        "cost_per_kwh": year_per_kwh(&t.costs, t.priced_kwh),
        "cost_per_100km": year_per100(&t.costs, t.distance_km),
        "home_kwh": r1(t.home_kwh),
        "supercharger_kwh": r1(t.supercharger_kwh),
        "other_kwh": r1(t.other_kwh),
    })
}

fn pct_change(cur: f64, prev: f64) -> Option<f64> {
    if prev.abs() < 1e-9 { return None; }
    Some(r1((cur - prev) / prev * 100.0))
}

/// Aggregate one calendar year's drives/charges into the year-review payload.
/// Invariant: `totals.distance_km` (rounded) equals the sum of monthly `distance_km`.
pub fn build_year_review(
    year: i32,
    month_keys: &[String],
    data_from: Option<&str>,
    data_to: &str,
    is_current: bool,
    drives: &[YrDrive],
    charges: &[YrCharge],
    journeys: &[YrJourney],
    previous: Option<&YearTotals>,
) -> serde_json::Value {
    let mut by: BTreeMap<String, YearTotals> =
        month_keys.iter().map(|m| (m.clone(), YearTotals::default())).collect();
    let mut totals = YearTotals::default();
    let mut longest: Option<&YrDrive> = None;
    let mut places: BTreeMap<String, i64> = BTreeMap::new();
    let mut sc_places: BTreeMap<String, ()> = BTreeMap::new();

    for d in drives {
        let Some(m) = by.get_mut(&d.month) else { continue };
        m.distance_km += d.distance_km;
        m.drive_count += 1;
        m.drive_duration_min += i64::from(d.duration_min);
        m.energy_used_kwh += d.energy_used_kwh.max(0.0);
        totals.distance_km += d.distance_km;
        totals.drive_count += 1;
        totals.drive_duration_min += i64::from(d.duration_min);
        totals.energy_used_kwh += d.energy_used_kwh.max(0.0);
        if d.distance_km > longest.map(|x| x.distance_km).unwrap_or(0.0) {
            longest = Some(d);
        }
        let place = d.end_place.trim();
        if !place.is_empty() && place != "—" {
            *places.entry(place.to_string()).or_default() += 1;
        }
    }

    for c in charges {
        let Some(m) = by.get_mut(&c.month) else { continue };
        let e = c.energy_kwh.max(0.0);
        m.energy_added_kwh += e;
        m.charge_count += 1;
        totals.energy_added_kwh += e;
        totals.charge_count += 1;
        match c.kind.as_str() {
            "home" => { m.home_kwh += e; totals.home_kwh += e; }
            "supercharger" => {
                m.supercharger_kwh += e;
                totals.supercharger_kwh += e;
                let p = c.place.trim();
                if !p.is_empty() && p != "—" { sc_places.insert(p.to_string(), ()); }
            }
            _ => { m.other_kwh += e; totals.other_kwh += e; }
        }
        if let Some(a) = c.cost {
            m.priced_kwh += e;
            totals.priced_kwh += e;
            *m.costs.entry(c.currency.clone()).or_default() += a;
            *totals.costs.entry(c.currency.clone()).or_default() += a;
        }
    }

    let month_rows: Vec<_> = month_keys.iter().map(|k| {
        let m = by.get(k).unwrap();
        serde_json::json!({
            "month": k,
            "distance_km": r1(m.distance_km),
            "drive_count": m.drive_count,
            "drive_duration_min": m.drive_duration_min,
            "energy_used_kwh": r1(m.energy_used_kwh),
            "energy_added_kwh": r1(m.energy_added_kwh),
            "charge_count": m.charge_count,
            "costs": year_money(&m.costs),
        })
    }).collect();

    let busiest = month_rows.iter()
        .filter(|m| m["distance_km"].as_f64().unwrap_or(0.0) > 0.0)
        .max_by(|a, b| a["distance_km"].as_f64().partial_cmp(&b["distance_km"].as_f64()).unwrap())
        .map(|m| serde_json::json!({"month": m["month"], "distance_km": m["distance_km"]}));

    let mut top: Vec<_> = places.into_iter().collect();
    top.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    top.truncate(5);
    let top_destinations: Vec<_> = top.into_iter()
        .map(|(name, visits)| serde_json::json!({"name": name, "visits": visits})).collect();

    let longest_journey = journeys.iter()
        .filter(|j| j.distance_km > 0.0)
        .max_by(|a, b| a.distance_km.partial_cmp(&b.distance_km).unwrap())
        .map(|j| serde_json::json!({
            "id": j.id, "name": j.name,
            "start_date": j.start_date, "end_date": j.end_date,
            "start_address": j.start_address, "end_address": j.end_address,
            "distance_km": r1(j.distance_km), "duration_min": j.duration_min,
        }));

    let longest_drive = longest.map(|d| serde_json::json!({
        "id": d.id, "start_date": d.start_date,
        "start_address": d.start_address, "end_address": d.end_address,
        "distance_km": r1(d.distance_km), "duration_min": d.duration_min,
    }));

    let yoy = previous.map(|p| serde_json::json!({
        "distance_pct": pct_change(totals.distance_km, p.distance_km),
        "drive_count_pct": pct_change(totals.drive_count as f64, p.drive_count as f64),
        "energy_used_pct": pct_change(totals.energy_used_kwh, p.energy_used_kwh),
        "energy_added_pct": pct_change(totals.energy_added_kwh, p.energy_added_kwh),
        "previous": totals_json(p),
    }));

    let jan = format!("{year}-01");
    let data_from_out = data_from.filter(|f| *f > jan.as_str());
    let dec = format!("{year}-12");
    let partial = data_from_out.is_some() || (is_current && data_to < dec.as_str());

    serde_json::json!({
        "year": year,
        "is_current": is_current,
        "data_from": data_from_out,
        "data_to": data_to,
        "partial": partial,
        "totals": totals_json(&totals),
        "months": month_rows,
        "highlights": {
            "longest_drive": longest_drive,
            "longest_journey": longest_journey,
            "busiest_month": busiest,
            "top_destinations": top_destinations,
            "superchargers_visited": sc_places.len() as i64,
            "charge_split": {
                "home_kwh": r1(totals.home_kwh),
                "supercharger_kwh": r1(totals.supercharger_kwh),
                "other_kwh": r1(totals.other_kwh),
            },
        },
        "yoy": yoy,
    })
}

fn valid_year(y: i32) -> bool { (2000..=2100).contains(&y) }

/// GET /api/cars/:id/year-review?year=YYYY&tz=&currency=
pub async fn year_review(State(s): State<AppState>, Path(id): Path<i64>, Query(p): Query<YearParams>) -> Result<Response, ApiError> {
    let bad = |m: &str| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": m}))).into_response();
    let tz = p.tz.unwrap_or_else(|| "UTC".into());
    let def_cur = p.currency.map(|c| c.trim().to_ascii_uppercase())
        .filter(|c| c.len() == 3 && c.bytes().all(|b| b.is_ascii_uppercase())).unwrap_or_else(|| "JPY".into());

    let cur_year: Result<i32, _> = sqlx::query_scalar("SELECT extract(year from now() AT TIME ZONE $1)::int4")
        .bind(&tz).fetch_one(&s.db).await;
    let cur_year = match cur_year {
        Ok(y) => y,
        Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("22023") => return Ok(bad("unknown tz")),
        Err(e) => return Err(e.into()),
    };
    let year = p.year.unwrap_or(cur_year);
    if !valid_year(year) { return Ok(bad("year must be 2000–2100")); }
    if year > cur_year { return Ok(bad("year is in the future")); }
    // cars.id is smallint — do not SELECT id into i64 (sqlx type mismatch → HTTP 500, #62).
    let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM cars WHERE id = $1").bind(id).fetch_optional(&s.db).await?;
    if exists.is_none() {
        return Ok((StatusCode::NOT_FOUND, Json(serde_json::json!({"error":"car not found"}))).into_response());
    }

    let is_current = year == cur_year;
    let month_keys: Vec<String> = (1..=12).map(|m| format!("{year}-{m:02}")).collect();
    let data_to = if is_current {
        sqlx::query_scalar::<_, String>("SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM')").bind(&tz).fetch_one(&s.db).await?
    } else {
        format!("{year}-12")
    };

    // Window: local Jan 1 of year → local Jan 1 of year+1 (or now's next month end for current — use full year bound)
    let bounds: Result<(String, String), _> = sqlx::query_as(
        "SELECT to_char((($1 || '-01-01')::timestamp AT TIME ZONE $2) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
                to_char(((($1::int + 1)::text || '-01-01')::timestamp AT TIME ZONE $2) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')")
        .bind(year.to_string()).bind(&tz).fetch_one(&s.db).await;
    let (t0, t1) = match bounds {
        Ok(v) => v,
        Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("22023") => return Ok(bad("unknown tz")),
        Err(e) => return Err(e.into()),
    };

    let costs = costs_ok(&s).await?;
    let (cc_amount, cc_cur, cc_join) = if costs {
        ("COALESCE(cc.amount, cp.cost)", format!("COALESCE(cc.currency::text, {LOC_CURRENCY})"), "LEFT JOIN drivelens.charge_costs cc ON cc.charging_process_id = cp.id")
    } else { ("cp.cost", LOC_CURRENCY.to_string(), "") };
    let al = alias_table(&s).await?;
    let (dsql, csql) = (drives_sql(al), charges_sql(cc_amount, &cc_cur, cc_join, al));
    // drives_sql binds: car, p0(=t0 for "previous" unused), m0, m1, tz — use t0 for both p0 and m0 so only year rows have cur=true; we ignore cur.
    let (drive_rows, charge_rows) = tokio::try_join!(
        sqlx::query_as::<_, DriveRow>(&dsql).bind(id).bind(&t0).bind(&t0).bind(&t1).bind(&tz).fetch_all(&s.db),
        sqlx::query_as::<_, ChargeRow>(&csql).bind(id).bind(&t0).bind(&t0).bind(&t1).bind(&tz).fetch_all(&s.db),
    )?;

    let place = |s: &Option<String>| s.clone().unwrap_or_default();
    let drives: Vec<YrDrive> = drive_rows.iter().filter_map(|d| {
        let day = d.day.as_ref()?;
        if day.len() < 7 { return None; }
        let month = day[..7].to_string();
        if !month_keys.iter().any(|k| k == &month) { return None; }
        Some(YrDrive {
            month, id: d.id, start_date: d.start_date.clone(),
            start_address: d.start_address.clone(), end_address: d.end_address.clone(),
            distance_km: d.distance_km.unwrap_or(0.0),
            duration_min: d.duration_min.unwrap_or(0),
            energy_used_kwh: d.energy_kwh.unwrap_or(0.0).max(0.0),
            end_place: place(&d.end_address),
        })
    }).collect();

    let charges: Vec<YrCharge> = charge_rows.iter().filter_map(|c| {
        let day = c.day.as_ref()?;
        if day.len() < 7 { return None; }
        let month = day[..7].to_string();
        if !month_keys.iter().any(|k| k == &month) { return None; }
        Some(YrCharge {
            month, kind: c.kind.clone(), energy_kwh: c.energy_kwh.unwrap_or(0.0),
            cost: c.cost, currency: c.currency.clone().unwrap_or_else(|| def_cur.clone()),
            place: place(&c.address),
        })
    }).collect();

    // Optional journeys that overlap the year (tables may be off).
    let mut journeys: Vec<YrJourney> = vec![];
    if s.journeys_ok.load(std::sync::atomic::Ordering::Relaxed) {
        let jsql = format!(
            "SELECT j.id, j.name,
                    to_char(s.s0, '{TS}') AS start_date, to_char(s.s1, '{TS}') AS end_date,
                    COALESCE(s.distance_km, 0)::float8 AS distance_km, COALESCE(s.duration_min, 0)::int8 AS duration_min,
                    COALESCE(fa.end_address, '') AS start_address, COALESCE(la.end_address, '') AS end_address
             FROM drivelens.journeys j
             JOIN LATERAL (
               SELECT min(d.start_date) AS s0, max(d.end_date) AS s1,
                      round(sum(d.distance)::numeric, 1)::float8 AS distance_km,
                      sum(d.duration_min)::int8 AS duration_min,
                      (array_agg(d.id ORDER BY d.start_date))[1] AS first_id,
                      (array_agg(d.id ORDER BY d.start_date DESC))[1] AS last_id
               FROM drivelens.journey_drives jd
               JOIN drives d ON d.id = jd.drive_id
               WHERE jd.journey_id = j.id AND d.car_id = $1 AND d.end_date IS NOT NULL
             ) s ON s.s0 IS NOT NULL
             LEFT JOIN LATERAL (
               SELECT COALESCE(al.name, g.name, CONCAT_WS(', ', COALESCE(a.name, NULLIF(CONCAT_WS(' ', a.road, a.house_number), '')), a.city)) AS end_address
               FROM drives d
               LEFT JOIN addresses a ON a.id = d.start_address_id
               LEFT JOIN {al} al ON al.address_id = d.start_address_id
               LEFT JOIN geofences g ON g.id = d.start_geofence_id
               WHERE d.id = s.first_id
             ) fa ON true
             LEFT JOIN LATERAL (
               SELECT COALESCE(al.name, g.name, CONCAT_WS(', ', COALESCE(a.name, NULLIF(CONCAT_WS(' ', a.road, a.house_number), '')), a.city)) AS end_address
               FROM drives d
               LEFT JOIN addresses a ON a.id = d.end_address_id
               LEFT JOIN {al} al ON al.address_id = d.end_address_id
               LEFT JOIN geofences g ON g.id = d.end_geofence_id
               WHERE d.id = s.last_id
             ) la ON true
             WHERE s.s0 >= $2::timestamp AND s.s0 < $3::timestamp"
        );
        #[derive(sqlx::FromRow)]
        struct JRow {
            id: i64, name: String, start_date: Option<String>, end_date: Option<String>,
            distance_km: f64, duration_min: i64, start_address: String, end_address: String,
        }
        if let Ok(rows) = sqlx::query_as::<_, JRow>(&jsql).bind(id).bind(&t0).bind(&t1).fetch_all(&s.db).await {
            journeys = rows.into_iter().map(|r| YrJourney {
                id: r.id, name: r.name, start_date: r.start_date, end_date: r.end_date,
                start_address: Some(r.start_address).filter(|s| !s.is_empty()),
                end_address: Some(r.end_address).filter(|s| !s.is_empty()),
                distance_km: r.distance_km, duration_min: r.duration_min,
            }).collect();
        }
    }

    let data_from = drives.iter().map(|d| d.month.as_str())
        .chain(charges.iter().map(|c| c.month.as_str()))
        .min().map(|s| s.to_string());

    // Previous calendar year totals (for YoY), only when that year has activity.
    let previous = if year > 2000 {
        let py = year - 1;
        let pb: Result<(String, String), _> = sqlx::query_as(
            "SELECT to_char((($1 || '-01-01')::timestamp AT TIME ZONE $2) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
                    to_char(((($1::int + 1)::text || '-01-01')::timestamp AT TIME ZONE $2) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')")
            .bind(py.to_string()).bind(&tz).fetch_one(&s.db).await;
        if let Ok((p0, p1)) = pb {
            let (pd, pc) = tokio::try_join!(
                sqlx::query_as::<_, DriveRow>(&dsql).bind(id).bind(&p0).bind(&p0).bind(&p1).bind(&tz).fetch_all(&s.db),
                sqlx::query_as::<_, ChargeRow>(&csql).bind(id).bind(&p0).bind(&p0).bind(&p1).bind(&tz).fetch_all(&s.db),
            )?;
            let mut t = YearTotals::default();
            for d in &pd {
                t.distance_km += d.distance_km.unwrap_or(0.0);
                t.drive_count += 1;
                t.drive_duration_min += i64::from(d.duration_min.unwrap_or(0));
                t.energy_used_kwh += d.energy_kwh.unwrap_or(0.0).max(0.0);
            }
            for c in &pc {
                let e = c.energy_kwh.unwrap_or(0.0).max(0.0);
                t.energy_added_kwh += e; t.charge_count += 1;
                match c.kind.as_str() {
                    "home" => t.home_kwh += e,
                    "supercharger" => t.supercharger_kwh += e,
                    _ => t.other_kwh += e,
                }
                if let Some(a) = c.cost {
                    t.priced_kwh += e;
                    *t.costs.entry(c.currency.clone().unwrap_or_else(|| def_cur.clone())).or_default() += a;
                }
            }
            if t.drive_count > 0 || t.charge_count > 0 { Some(t) } else { None }
        } else { None }
    } else { None };

    let mut body = build_year_review(
        year, &month_keys, data_from.as_deref(), &data_to, is_current,
        &drives, &charges, &journeys, previous.as_ref(),
    );
    if let Some(obj) = body.as_object_mut() {
        obj.insert("timezone".into(), serde_json::json!(tz));
    }
    Ok(Json(body).into_response())
}


#[cfg(test)]
mod year_review_tests {
    use super::*;

    /// TeslaMate `cars.id` is `smallint` (INT2). Decoding it as `i64` makes sqlx return
    /// HTTP 500 before any year aggregation runs (#62). Keep the same `SELECT 1` existence
    /// check as `car_report` / `car_exists`.
    #[test]
    fn year_review_car_exists_avoids_smallint_id_decode() {
        let src = include_str!("report.rs");
        let yr = src.split("pub async fn year_review").nth(1).expect("year_review fn");
        let head = yr.split("let is_current").next().expect("before is_current");
        assert!(
            head.contains("SELECT 1 FROM cars WHERE id = $1"),
            "year_review must use SELECT 1 for car existence (cars.id is smallint)"
        );
        assert!(
            !head.contains("SELECT id FROM cars WHERE id = $1"),
            "decoding cars.id as i64 fails: sqlx INT2 vs i64"
        );
    }


    fn drive(month: &str, id: i64, km: f64, place: &str) -> YrDrive {
        YrDrive {
            month: month.into(), id, start_date: Some(format!("{month}-15T00:00:00Z")),
            start_address: Some("Home".into()), end_address: Some(place.into()),
            distance_km: km, duration_min: 60, energy_used_kwh: km * 0.15,
            end_place: place.into(),
        }
    }
    fn charge(month: &str, kind: &str, kwh: f64, cost: Option<f64>, place: &str) -> YrCharge {
        YrCharge { month: month.into(), kind: kind.into(), energy_kwh: kwh, cost, currency: "JPY".into(), place: place.into() }
    }

    #[test]
    fn year_distance_equals_sum_of_months() {
        let months: Vec<String> = (1..=12).map(|m| format!("2026-{m:02}")).collect();
        let drives = vec![
            drive("2026-05", 1, 100.0, "Office"),
            drive("2026-05", 2, 50.4, "Office"),
            drive("2026-06", 3, 200.0, "Park"),
            drive("2026-11", 4, 12.3, "Home"),
        ];
        let charges = vec![
            charge("2026-05", "home", 40.0, Some(800.0), "Home"),
            charge("2026-06", "supercharger", 30.0, Some(1980.0), "SuC A"),
            charge("2026-06", "supercharger", 20.0, Some(1200.0), "SuC B"),
            charge("2026-11", "other", 10.0, None, "Mall"),
        ];
        let v = build_year_review(2026, &months, Some("2026-05"), "2026-11", true, &drives, &charges, &[], None);
        assert_eq!(v["partial"], true);
        assert_eq!(v["data_from"], "2026-05");
        let tot = v["totals"]["distance_km"].as_f64().unwrap();
        let sum: f64 = v["months"].as_array().unwrap().iter().map(|m| m["distance_km"].as_f64().unwrap()).sum();
        assert!((tot - sum).abs() < 0.05, "tot={tot} sum={sum}");
        assert_eq!(tot, 362.7);
        assert_eq!(v["totals"]["drive_count"], 4);
        assert_eq!(v["totals"]["charge_count"], 4);
        assert_eq!(v["totals"]["cost_per_100km"][0]["amount"], 1097.33); // 3980/362.7*100
        assert_eq!(v["totals"]["priced_kwh"], 90.0); // unpriced mall session excluded
        assert_eq!(v["totals"]["cost_per_kwh"][0]["amount"], 44.22); // 3980/90
        assert_eq!(v["highlights"]["superchargers_visited"], 2);
        assert_eq!(v["highlights"]["busiest_month"]["month"], "2026-06");
        assert_eq!(v["highlights"]["longest_drive"]["distance_km"], 200.0);
        assert_eq!(v["highlights"]["top_destinations"][0]["name"], "Office");
        assert_eq!(v["highlights"]["top_destinations"][0]["visits"], 2);
        assert!(v["yoy"].is_null());
    }

    #[test]
    fn yoy_pct_when_previous_exists() {
        let months = vec!["2025-01".into()];
        let prev = YearTotals { distance_km: 1000.0, drive_count: 10, energy_used_kwh: 150.0, energy_added_kwh: 160.0, ..Default::default() };
        let drives = vec![drive("2025-01", 1, 1200.0, "A")];
        let v = build_year_review(2025, &months, None, "2025-12", false, &drives, &[], &[], Some(&prev));
        assert_eq!(v["yoy"]["distance_pct"], 20.0);
        assert_eq!(v["partial"], false);
        assert!(v["data_from"].is_null());
    }
}

#[cfg(test)]
mod charging_cost_tests {
    use super::*;

    fn sess(month: &str, kind: &str, kwh: f64, cost: Option<f64>, cur: &str) -> CostSession {
        CostSession { month: month.into(), kind: kind.into(), energy_kwh: kwh, cost, currency: cur.into() }
    }

    #[test]
    fn unit_rates_and_coverage() {
        assert_eq!(unit_rate(2140.0, 100.0), Some(21.4));
        assert_eq!(unit_rate(100.0, 0.0), None);
        assert_eq!(cost_per_100km(3645.0, 1000.0), Some(364.5));
        assert_eq!(cost_per_100km(100.0, 0.0), None);
        assert_eq!(coverage_pct(90.0, 100.0), Some(90.0));
        assert_eq!(coverage_pct(0.0, 0.0), None);
    }

    #[test]
    fn aggregates_split_and_monthly_without_misleading_sums() {
        let months = vec!["2026-09".into(), "2026-10".into()];
        let sessions = vec![
            sess("2026-09", "home", 40.0, Some(800.0), "JPY"),
            sess("2026-09", "supercharger", 30.0, Some(1980.0), "JPY"),
            sess("2026-10", "home", 50.0, Some(1000.0), "JPY"),
            sess("2026-10", "other", 20.0, None, "JPY"), // unpriced — counted in energy, not in unit rates
        ];
        let drives = vec![
            DriveMonthDist { month: "2026-09".into(), distance_km: 500.0 },
            DriveMonthDist { month: "2026-10".into(), distance_km: 600.0 },
        ];
        let v = build_charging_costs(&months, &sessions, &drives);
        let s = &v["summary"];
        assert_eq!(s["charge_count"], 4);
        assert_eq!(s["priced_count"], 3);
        assert_eq!(s["energy_added_kwh"], 140.0);
        assert_eq!(s["priced_kwh"], 120.0);
        assert_eq!(s["coverage_pct"], 85.7); // 120/140
        assert_eq!(s["costs"][0]["amount"], 3780.0);
        // ¥/kWh uses priced kWh only (3780 / 120 = 31.5), not total energy
        assert_eq!(s["cost_per_kwh"][0]["amount"], 31.5);
        // ¥/100km uses all distance in the window (3780 / 1100 * 100)
        assert_eq!(s["cost_per_100km"][0]["amount"], 343.64);
        let home = v["split"].as_array().unwrap().iter().find(|b| b["kind"] == "home").unwrap();
        assert_eq!(home["count"], 2);
        assert_eq!(home["cost_per_kwh"][0]["amount"], 20.0); // 1800 / 90
        let other = v["split"].as_array().unwrap().iter().find(|b| b["kind"] == "other").unwrap();
        assert_eq!(other["count"], 1);
        assert!(other["cost_per_kwh"].as_array().unwrap().is_empty()); // no priced energy
        assert_eq!(v["monthly"].as_array().unwrap().len(), 2);
        assert_eq!(v["monthly"][1]["priced_count"], 1);
    }
}


#[cfg(test)]
mod tests {
    use super::charges_sql;

    #[test]
    fn charges_sql_classifies_tesla_fc_before_name_fallback() {
        let s = charges_sql("NULL", "NULL", "", "drivelens.address_aliases");
        assert!(s.contains("fx.tesla_fc"), "session probe must expose tesla_fc");
        assert!(
            s.contains("fast_charger_brand ~* '^tesla$'")
                && s.contains("fast_charger_type ~* '^tesla'"),
            "must match TeslaMate brand=Tesla / type starting with Tesla"
        );
        assert!(
            s.contains("(supercharger|超充|スーパーチャージャー|tesla)"),
            "name-based match remains as fallback"
        );
        assert!(
            s.contains("fx.fast AND (fx.tesla_fc"),
            "supercharger requires DC (fast) plus tesla_fc or name"
        );
    }
}
