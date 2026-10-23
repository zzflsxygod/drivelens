// SPDX-License-Identifier: AGPL-3.0-or-later
//! Device auth (api_level 15): per-device tokens, pairing codes, read-only devices and the owner-key mode.
//!
//! - Owner key: API_TOKEN from the environment (recovery + device management). Never stored by the app.
//! - Device token: "dlt_" + base64url(32 random bytes). The server keeps only its SHA-256 (drivelens.devices).
//! - Pairing code: 8 Crockford Base32 characters (40 bits, shown as XXXX-XXXX), 10 minutes, single use.
//!   Only its SHA-256 is stored (drivelens.pairing_codes).
//!
//! Tokens and codes are never logged; log lines name devices by id and name only.
//! Without the tables (old setups where the API role cannot create them) `available` is false and the
//! owner key keeps working everywhere exactly as before.
use super::*;
use axum::extract::{ConnectInfo, Extension, OriginalUri};
use axum::http::{HeaderMap, Method};
use base64ct::{Base64UrlUnpadded, Encoding as _};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant};

pub const TOKEN_PREFIX: &str = "dlt_";
/// Crockford Base32 alphabet (no I, L, O, U).
const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_DEVICES: i64 = 50;
const MAX_OPEN_CODES: i64 = 5;
const CODE_TTL_MIN: i32 = 10;
const NAME_MAX: usize = 60;
const UA_MAX: usize = 200;
/// last_used_at / last_ip are written to the database at most this often per device.
const TOUCH_EVERY_SECS: i64 = 300;
/// Full reload of the device index (follows manual DB edits; expired devices are deleted).
const RELOAD_EVERY: Duration = Duration::from_secs(300);
/// pair-only mode: owner-key failures of all clients together per FAIL_WINDOW before the owner key is not evaluated.
const OWNER_GLOBAL_LIMIT: u32 = 50;
/// POST /api/auth/pair: failures per client / of all clients per FAIL_WINDOW.
const PAIR_CLIENT_LIMIT: u32 = 5;
const PAIR_GLOBAL_LIMIT: u32 = 20;

/// Fix for installs whose drivelens schema / tables belong to the TeslaMate admin (older SQL files).
const DEVICE_FIX: &str = "as the TeslaMate DB admin, re-run deploy/setup.sql once, or run: GRANT USAGE, CREATE ON SCHEMA drivelens TO drivelens_ro; plus ALTER TABLE drivelens.<table> OWNER TO drivelens_ro for every drivelens table; then restart the API (see docs/install.md, Upgrading to 0.14.0)";
const UNAVAILABLE: &str = "device auth is not available: the API cannot create drivelens.devices / drivelens.pairing_codes (the drivelens schema needs CREATE for drivelens_ro); as the TeslaMate DB admin, re-run deploy/setup.sql once and restart the API (see docs/install.md)";

// ---------------- tables ----------------
const DEVICES_DDL: &str = "CREATE TABLE IF NOT EXISTS drivelens.devices (
    id bigserial PRIMARY KEY,
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
    token_hash bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
    scope text NOT NULL CHECK (scope IN ('full', 'read')),
    created_via text NOT NULL CHECK (created_via IN ('owner_key', 'pairing')),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,
    last_used_at timestamptz,
    last_ip text,
    user_agent text)";
const PAIRING_DDL: &str = "CREATE TABLE IF NOT EXISTS drivelens.pairing_codes (
    id bigserial PRIMARY KEY,
    code_hash bytea NOT NULL UNIQUE CHECK (length(code_hash) = 32),
    scope text NOT NULL CHECK (scope IN ('full', 'read')),
    device_ttl_days integer CHECK (device_ttl_days BETWEEN 1 AND 365),
    created_by bigint REFERENCES drivelens.devices(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL)";
const PUSH_LINK_DDL: &str = "ALTER TABLE drivelens.push_subscriptions
    ADD COLUMN IF NOT EXISTS device_id bigint REFERENCES drivelens.devices(id) ON DELETE CASCADE";

async fn regclass(db: &PgPool, name: &str) -> bool {
    sqlx::query_scalar::<_, bool>("SELECT to_regclass($1) IS NOT NULL").bind(name).fetch_one(db).await.unwrap_or(false)
}
async fn push_link_exists(db: &PgPool) -> bool {
    sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'drivelens' AND table_name = 'push_subscriptions' AND column_name = 'device_id')")
        .fetch_one(db).await.unwrap_or(false)
}

/// Idempotent and never fatal (runs after push::try_migrate). Existing objects are detected first, so a role
/// without CREATE on the schema does not even try (CREATE … IF NOT EXISTS still needs the privilege).
pub async fn try_migrate(db: &PgPool) {
    for (name, ddl) in [("drivelens.devices", DEVICES_DDL), ("drivelens.pairing_codes", PAIRING_DDL)] {
        if regclass(db, name).await { continue; }
        if let Err(e) = sqlx::query(ddl).execute(db).await {
            tracing::warn!("device auth disabled: cannot create {name} ({e}); {DEVICE_FIX}. Everything else keeps working with the owner key (API_TOKEN).");
            return;
        }
    }
    // links push subscriptions to the device that registered them (revoking a device removes its subscriptions)
    if regclass(db, "drivelens.push_subscriptions").await && !push_link_exists(db).await {
        if let Err(e) = sqlx::query(PUSH_LINK_DDL).execute(db).await {
            tracing::warn!("cannot add drivelens.push_subscriptions.device_id ({e}); notifications keep working but are not removed with a revoked device; {DEVICE_FIX}");
        }
    } else if !regclass(db, "drivelens.push_subscriptions").await {
        tracing::warn!("drivelens.push_subscriptions is missing; push subscriptions will not be linked to devices");
    }
}

async fn tables_ok(db: &PgPool) -> bool {
    sqlx::query_scalar::<_, bool>(
        "SELECT to_regclass('drivelens.devices') IS NOT NULL AND to_regclass('drivelens.pairing_codes') IS NOT NULL
           AND has_table_privilege('drivelens.devices', 'SELECT,INSERT,UPDATE,DELETE')
           AND has_table_privilege('drivelens.pairing_codes', 'SELECT,INSERT,UPDATE,DELETE')
           AND has_sequence_privilege('drivelens.devices_id_seq', 'USAGE')
           AND has_sequence_privilege('drivelens.pairing_codes_id_seq', 'USAGE')").fetch_one(db).await.unwrap_or(false)
}

// ---------------- tokens, codes, names ----------------
fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::getrandom(&mut b).expect("OS random number generator");
    b
}
pub fn sha256(s: &str) -> [u8; 32] { Sha256::digest(s.as_bytes()).into() }

/// Only fixed-size digests are compared, so the comparison time does not depend on the candidate's length.
pub fn constant_time_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn new_token() -> String { format!("{TOKEN_PREFIX}{}", Base64UrlUnpadded::encode_string(&random::<32>())) }

/// 8 Crockford Base32 characters from 40 random bits (normalized form, without the dash).
pub fn new_code() -> String {
    let v = random::<5>().iter().fold(0u64, |acc, b| (acc << 8) | *b as u64);
    (0..8).map(|i| CROCKFORD[((v >> (35 - 5 * i)) & 31) as usize] as char).collect()
}
/// Upper-case, drop dashes / whitespace, I/L → 1, O → 0; `None` unless 8 Crockford characters remain.
pub fn normalize_code(s: &str) -> Option<String> {
    let c: String = s.chars().filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| match c.to_ascii_uppercase() { 'I' | 'L' => '1', 'O' => '0', x => x }).collect();
    (c.len() == 8 && c.bytes().all(|b| CROCKFORD.contains(&b))).then_some(c)
}
pub fn display_code(c: &str) -> String { format!("{}-{}", &c[..4], &c[4..]) }

/// Control characters removed, trimmed, 1–60 characters.
pub fn clean_name(s: &str) -> Option<String> {
    let n: String = s.chars().filter(|c| !c.is_control()).collect();
    let n = n.trim();
    (1..=NAME_MAX).contains(&n.chars().count()).then(|| n.to_string())
}

fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}
/// Unix seconds → "YYYY-MM-DDTHH:MM:SSZ" (same format as the rest of the API).
pub fn iso(t: i64) -> String {
    let (days, secs) = (t.div_euclid(86_400), t.rem_euclid(86_400));
    // civil_from_days (H. Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", secs / 3600, secs % 3600 / 60, secs % 60)
}

// ---------------- client address ----------------
/// DRIVELENS_TRUST_PROXY_HEADERS=true: take the client address from CF-Connecting-IP / X-Forwarded-For /
/// X-Real-IP, but only when the request comes from a loopback or private address (i.e. from your own reverse
/// proxy / cloudflared). Default (unset): the TCP peer address only; headers are ignored because any client can
/// set them. Behind a proxy that means all clients share one bucket: device tokens are always evaluated, and in
/// the default owner-key mode (`full`) a correct owner key is too, so the limit never locks the owner out.
pub fn trust_proxy_headers() -> bool {
    static V: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *V.get_or_init(|| matches!(std::env::var("DRIVELENS_TRUST_PROXY_HEADERS").unwrap_or_default().trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
}

pub fn client_ip(headers: &HeaderMap, peer: Option<IpAddr>, trust_headers: bool) -> Option<IpAddr> {
    let local = |ip: &IpAddr| match ip { IpAddr::V4(a) => a.is_loopback() || a.is_private() || a.is_link_local(),
        IpAddr::V6(a) => a.is_loopback() || (a.segments()[0] & 0xfe00) == 0xfc00 || a.to_ipv4_mapped().is_some_and(|v| v.is_loopback() || v.is_private()) };
    let header_ip = || -> Option<IpAddr> {
        let h = |n: &str| headers.get(n).and_then(|v| v.to_str().ok());
        let parse = |v: &str| v.trim().parse::<IpAddr>().ok();
        // X-Forwarded-For: the right-most entry is the one added by our own proxy (left ones are client-supplied)
        h("cf-connecting-ip").and_then(parse).or_else(|| h("x-forwarded-for").and_then(|v| v.rsplit(',').next()).and_then(parse))
            .or_else(|| h("x-real-ip").and_then(parse))
    };
    match peer {
        Some(p) if trust_headers && local(&p) => Some(header_ip().unwrap_or(p)),
        p => p,
    }
}
/// Rate-limit key: an IP address (IPv6 grouped by /64, so rotating within one prefix does not help).
pub fn key_of(ip: Option<IpAddr>) -> String {
    match ip {
        None => "unknown".into(),
        Some(IpAddr::V6(a)) if a.to_ipv4_mapped().is_none() => { let s = a.segments(); format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3]) }
        Some(IpAddr::V6(a)) => a.to_ipv4_mapped().unwrap().to_string(),
        Some(v4) => v4.to_string(),
    }
}
fn peer_of(req: &Request) -> Option<IpAddr> { req.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0.ip()) }
#[cfg(test)]
pub fn client_key(req: &Request, trust_headers: bool) -> String { key_of(client_ip(req.headers(), peer_of(req), trust_headers)) }

// ---------------- failure limits ----------------
/// At most this many client buckets are tracked; beyond that, new clients share one overflow bucket.
pub const FAIL_MAX_KEYS: usize = 4096;
pub const FAIL_LIMIT: u32 = 10;
pub const FAIL_WINDOW: Duration = Duration::from_secs(600);
pub type FailMap = Mutex<HashMap<String, (u32, Instant)>>;

/// Count one failed attempt for `key` (window FAIL_WINDOW from the first failure); returns the count.
pub fn record_failure(fails: &FailMap, key: String, now: Instant) -> u32 {
    let mut m = fails.lock().unwrap();
    m.retain(|_, (_, t)| now.duration_since(*t) < FAIL_WINDOW);
    let key = if m.len() >= FAIL_MAX_KEYS && !m.contains_key(&key) { "overflow".to_string() } else { key };
    let e = m.entry(key).or_insert((0, now));
    e.0 = e.0.saturating_add(1);
    e.0
}
fn failures(fails: &FailMap, key: &str, now: Instant) -> u32 {
    let m = fails.lock().unwrap();
    let k = if m.contains_key(key) || m.len() < FAIL_MAX_KEYS { key } else { "overflow" };
    m.get(k).filter(|(_, t)| now.duration_since(*t) < FAIL_WINDOW).map_or(0, |e| e.0)
}

/// One counter for all clients (window from the first failure).
#[derive(Default)]
struct Global { n: u32, since: Option<Instant>, warned: bool }
impl Global {
    fn roll(&mut self, now: Instant) {
        if self.since.is_some_and(|t| now.duration_since(t) >= FAIL_WINDOW) { *self = Global::default(); }
    }
    fn count(&mut self, now: Instant) -> u32 { self.roll(now); self.n }
    fn add(&mut self, now: Instant) -> u32 {
        self.roll(now);
        self.since.get_or_insert(now);
        self.n = self.n.saturating_add(1);
        self.n
    }
}

// ---------------- state ----------------
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope { Full, Read }
impl Scope {
    pub fn as_str(self) -> &'static str { match self { Scope::Full => "full", Scope::Read => "read" } }
    fn parse(s: &str) -> Option<Scope> { match s { "full" => Some(Scope::Full), "read" => Some(Scope::Read), _ => None } }
}

/// Who made the request (request extension set by the middleware).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Principal { Owner, Device { id: i64, scope: Scope } }

/// DRIVELENS_OWNER_KEY_MODE: `full` (default; the owner key works everywhere) or `pair-only` (only /api/auth/*).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OwnerKeyMode { Full, PairOnly }
impl OwnerKeyMode {
    pub fn parse(v: Option<&str>) -> anyhow::Result<OwnerKeyMode> {
        match v.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
            None | Some("") | Some("full") => Ok(OwnerKeyMode::Full),
            Some("pair-only") | Some("pair_only") => Ok(OwnerKeyMode::PairOnly),
            Some(other) => anyhow::bail!("DRIVELENS_OWNER_KEY_MODE must be `full` or `pair-only` (got {other:?})"),
        }
    }
    pub fn from_env() -> anyhow::Result<OwnerKeyMode> { Self::parse(std::env::var("DRIVELENS_OWNER_KEY_MODE").ok().as_deref()) }
    pub fn as_str(self) -> &'static str { match self { OwnerKeyMode::Full => "full", OwnerKeyMode::PairOnly => "pair-only" } }
}

#[derive(Clone, Debug)]
pub struct Device {
    pub id: i64, pub name: String, pub scope: Scope, pub created_via: String, pub created_at: i64,
    pub expires_at: Option<i64>, pub last_used_at: Option<i64>, pub last_ip: Option<String>, pub user_agent: Option<String>,
    /// last time last_used_at / last_ip were written to the database (unix seconds)
    flushed_at: i64,
}
impl Device {
    fn live(&self, now: i64) -> bool { self.expires_at.is_none_or(|e| e > now) }
    fn view(&self, current: Option<i64>) -> serde_json::Value {
        serde_json::json!({"id": self.id, "name": self.name, "scope": self.scope.as_str(), "created_via": self.created_via,
            "created_at": iso(self.created_at), "expires_at": self.expires_at.map(iso), "last_used_at": self.last_used_at.map(iso),
            "last_ip": self.last_ip, "user_agent": self.user_agent, "current": current == Some(self.id)})
    }
}

pub struct AuthState {
    owner_hash: [u8; 32],
    pair_only: AtomicBool,
    available: AtomicBool,
    /// drivelens.push_subscriptions.device_id exists
    push_link: AtomicBool,
    devices: RwLock<HashMap<[u8; 32], Device>>,
    /// failed attempts per client (owner key / device tokens / missing header)
    fails: FailMap,
    owner_global: Mutex<Global>,
    pair_fails: FailMap,
    pair_global: Mutex<Global>,
    db: Option<PgPool>,
    /// wait 300 ms / 1 s on failures (off in unit tests)
    slow: bool,
}

#[derive(FromRow)]
struct Row { id: i64, name: String, token_hash: Vec<u8>, scope: String, created_via: String, created_at: i64,
    expires_at: Option<i64>, last_used_at: Option<i64>, last_ip: Option<String>, user_agent: Option<String> }
const COLS: &str = "id, name, token_hash, scope, created_via, floor(extract(epoch FROM created_at))::int8 AS created_at,
    floor(extract(epoch FROM expires_at))::int8 AS expires_at, floor(extract(epoch FROM last_used_at))::int8 AS last_used_at, last_ip, user_agent";
impl Row {
    fn split(self) -> Option<([u8; 32], Device)> {
        let hash: [u8; 32] = self.token_hash.as_slice().try_into().ok()?;
        let flushed_at = self.last_used_at.unwrap_or(0);
        Some((hash, Device { id: self.id, name: self.name, scope: Scope::parse(&self.scope)?, created_via: self.created_via,
            created_at: self.created_at, expires_at: self.expires_at, last_used_at: self.last_used_at, last_ip: self.last_ip,
            user_agent: self.user_agent, flushed_at }))
    }
}

impl AuthState {
    fn new(owner_key: &str, mode: OwnerKeyMode, db: Option<PgPool>, slow: bool) -> AuthState {
        AuthState { owner_hash: sha256(owner_key), pair_only: AtomicBool::new(mode == OwnerKeyMode::PairOnly),
            available: AtomicBool::new(false), push_link: AtomicBool::new(false), devices: Default::default(),
            fails: Default::default(), owner_global: Default::default(), pair_fails: Default::default(),
            pair_global: Default::default(), db, slow }
    }

    /// Startup: detect the tables, load the index, apply the owner-key mode (pair-only falls back to full
    /// when device auth is unavailable, so nobody is locked out).
    pub async fn init(db: PgPool, owner_key: &str, mode: OwnerKeyMode) -> AuthState {
        let a = AuthState::new(owner_key, mode, Some(db.clone()), true);
        a.refresh(&db).await;
        // (missing tables were already reported by try_migrate)
        if !a.available() && regclass(&db, "drivelens.devices").await && regclass(&db, "drivelens.pairing_codes").await {
            tracing::warn!("device auth disabled: drivelens.devices / drivelens.pairing_codes are not usable by the API role; {DEVICE_FIX}");
        }
        if mode == OwnerKeyMode::PairOnly && !a.available() {
            tracing::error!("DRIVELENS_OWNER_KEY_MODE=pair-only needs device auth, which is not available; using `full` so the owner key keeps working. {UNAVAILABLE}");
            a.pair_only.store(false, Ordering::Relaxed);
        }
        tracing::info!("owner key mode: {}", a.mode().as_str());
        a
    }

    pub fn available(&self) -> bool { self.available.load(Ordering::Relaxed) }
    pub fn push_link(&self) -> bool { self.push_link.load(Ordering::Relaxed) }
    pub fn mode(&self) -> OwnerKeyMode { if self.pair_only.load(Ordering::Relaxed) { OwnerKeyMode::PairOnly } else { OwnerKeyMode::Full } }
    pub fn owner_matches(&self, candidate: &str) -> bool { constant_time_eq(&sha256(candidate), &self.owner_hash) }

    /// Re-detect the tables and reload all devices (deleting expired ones and stale pairing codes first).
    /// On a database error the current index is kept.
    pub async fn refresh(&self, db: &PgPool) {
        let ok = tables_ok(db).await;
        self.push_link.store(ok && push_link_exists(db).await, Ordering::Relaxed);
        if !ok {
            if self.available.swap(false, Ordering::Relaxed) { tracing::warn!("device auth: tables are no longer usable; {UNAVAILABLE}"); }
            self.devices.write().unwrap().clear();
            return;
        }
        let _ = sqlx::query("DELETE FROM drivelens.devices WHERE expires_at <= now()").execute(db).await;
        let _ = sqlx::query("DELETE FROM drivelens.pairing_codes WHERE expires_at <= now()").execute(db).await;
        let rows = match sqlx::query_as::<_, Row>(&format!("SELECT {COLS} FROM drivelens.devices")).fetch_all(db).await {
            Ok(r) => r,
            Err(e) => { tracing::warn!("device auth: reload failed ({e}); keeping the current device list"); return; }
        };
        let mut fresh: HashMap<[u8; 32], Device> = rows.into_iter().filter_map(Row::split).collect();
        {
            let mut m = self.devices.write().unwrap();
            // keep usage noted in memory but not yet written
            for (h, d) in fresh.iter_mut() {
                if let Some(old) = m.get(h) {
                    if old.last_used_at > d.last_used_at { d.last_used_at = old.last_used_at; d.last_ip = old.last_ip.clone(); }
                    d.flushed_at = d.flushed_at.max(old.flushed_at);
                }
            }
            *m = fresh;
        }
        if !self.available.swap(true, Ordering::Relaxed) {
            tracing::info!("device auth enabled: {} device(s)", self.devices.read().unwrap().len());
        }
    }

    fn put(&self, hash: [u8; 32], d: Device) { self.devices.write().unwrap().insert(hash, d); }
    fn forget(&self, hashes: &[[u8; 32]]) { let mut m = self.devices.write().unwrap(); for h in hashes { m.remove(h); } }
    fn by_id(&self, id: i64) -> Option<Device> { self.devices.read().unwrap().values().find(|d| d.id == id).cloned() }
    fn update(&self, id: i64, f: impl FnOnce(&mut Device)) {
        if let Some(d) = self.devices.write().unwrap().values_mut().find(|d| d.id == id) { f(d); }
    }

    /// A live device for this token, noting the use (written to the DB at most every TOUCH_EVERY_SECS).
    fn device_for(&self, token: &str, ip: Option<IpAddr>) -> Option<Principal> {
        if !self.available() { return None; }
        let now = now_secs();
        let mut m = self.devices.write().unwrap();
        let d = m.get_mut(&sha256(token)).filter(|d| d.live(now))?;
        d.last_used_at = Some(now);
        if let Some(ip) = ip { d.last_ip = Some(ip.to_string()); }
        if now - d.flushed_at >= TOUCH_EVERY_SECS {
            d.flushed_at = now;
            if let Some(db) = self.db.clone() {
                let (id, ip) = (d.id, d.last_ip.clone());
                tokio::spawn(async move {
                    if let Err(e) = sqlx::query("UPDATE drivelens.devices SET last_used_at = now(), last_ip = COALESCE($2, last_ip) WHERE id = $1")
                        .bind(id).bind(ip).execute(&db).await { tracing::debug!("device auth: cannot note use of device {id}: {e}"); }
                });
            }
        }
        Some(Principal::Device { id: d.id, scope: d.scope })
    }

    fn owner_blocked(&self, key: &str, now: Instant) -> bool {
        failures(&self.fails, key, now) >= FAIL_LIMIT || self.owner_global.lock().unwrap().count(now) >= OWNER_GLOBAL_LIMIT
    }
    fn owner_failed(&self, now: Instant) {
        let mut g = self.owner_global.lock().unwrap();
        let n = g.add(now);
        if n >= OWNER_GLOBAL_LIMIT && !g.warned && self.mode() == OwnerKeyMode::PairOnly {
            g.warned = true;
            tracing::warn!("auth: {n} failed owner-key attempts from all clients within 10 minutes; the owner key is not evaluated until the window ends (device tokens keep working)");
        }
    }

    async fn delay(&self, ms: u64) { if self.slow { tokio::time::sleep(Duration::from_millis(ms)).await; } }

    async fn too_many(&self) -> Response {
        self.delay(1000).await;
        (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, "600")],
            Json(serde_json::json!({"error": "too many failed authentication attempts; try again in 10 minutes", "code": "rate_limited"}))).into_response()
    }

    /// Failure response (unchanged from before): 300 ms / 1 s wait; more than FAIL_LIMIT failures → 429.
    async fn fail(&self, key: String, now: Instant) -> Response {
        let n = record_failure(&self.fails, key.clone(), now);
        if n > FAIL_LIMIT { return self.too_many().await; }
        self.delay(300).await;
        if n == FAIL_LIMIT { tracing::warn!("auth: {n} failed attempts from {key}; further failures get 429 for 10 minutes"); }
        (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response()
    }

    fn pair_blocked(&self, key: &str, now: Instant) -> bool {
        failures(&self.pair_fails, key, now) >= PAIR_CLIENT_LIMIT || self.pair_global.lock().unwrap().count(now) >= PAIR_GLOBAL_LIMIT
    }
    fn pair_failed(&self, key: String, now: Instant) {
        record_failure(&self.pair_fails, key, now);
        self.pair_global.lock().unwrap().add(now);
    }
}

/// Background reload every RELOAD_EVERY.
pub fn spawn(s: AppState) {
    tokio::spawn(async move {
        let mut iv = tokio::time::interval(RELOAD_EVERY);
        iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        iv.tick().await;
        loop { iv.tick().await; s.auth.refresh(&s.db).await; }
    });
}

// ---------------- middleware ----------------
fn coded(status: StatusCode, code: &str, msg: &str) -> Response {
    (status, Json(serde_json::json!({"error": msg, "code": code}))).into_response()
}

/// Scope check on the full path (/api/...; inside `nest` the request URI has the prefix stripped).
fn permission(p: Principal, mode: OwnerKeyMode, method: &Method, path: &str) -> Option<Response> {
    match p {
        Principal::Owner if mode == OwnerKeyMode::PairOnly && !path.starts_with("/api/auth/") =>
            Some(coded(StatusCode::FORBIDDEN, "owner_key_pair_only", "the owner key (API_TOKEN) can only be used to add devices on this server (DRIVELENS_OWNER_KEY_MODE=pair-only)")),
        Principal::Device { scope: Scope::Read, .. } if !matches!(*method, Method::GET | Method::HEAD) => {
            let allowed = path.starts_with("/api/push/")
                || (path == "/api/auth/devices/current" && matches!(*method, Method::PATCH | Method::DELETE));
            (!allowed).then(|| coded(StatusCode::FORBIDDEN, "read_only", "this device is read-only"))
        }
        _ => None,
    }
}

pub async fn middleware(State(s): State<AppState>, req: Request, next: Next) -> Response { check(&s.auth, req, next).await }

pub async fn check(a: &AuthState, mut req: Request, next: Next) -> Response {
    let now = Instant::now();
    let ip = client_ip(req.headers(), peer_of(&req), trust_proxy_headers());
    let bearer = req.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
    let principal = match bearer {
        // device tokens are always evaluated, even while this client is blocked: the owner's devices keep working
        Some(t) if t.starts_with(TOKEN_PREFIX) => a.device_for(t, ip),
        Some(t) => {
            // pair-only: a blocked client (or too many failures overall) cannot keep guessing the owner key.
            // full (default): a correct owner key is accepted even while blocked, as before.
            if a.mode() == OwnerKeyMode::PairOnly && a.owner_blocked(&key_of(ip), now) { return a.too_many().await; }
            if a.owner_matches(t) { Some(Principal::Owner) } else { a.owner_failed(now); None }
        }
        None => None,
    };
    let Some(p) = principal else { return a.fail(key_of(ip), now).await };
    let path = req.extensions().get::<OriginalUri>().map(|u| u.0.path().to_owned()).unwrap_or_else(|| req.uri().path().to_owned());
    if let Some(r) = permission(p, a.mode(), req.method(), &path) { return r; }
    req.extensions_mut().insert(p);
    next.run(req).await
}

// ---------------- /api/auth/* ----------------
fn unavailable() -> Response { coded(StatusCode::SERVICE_UNAVAILABLE, "device_auth_unavailable", UNAVAILABLE) }
fn invalid_name() -> Response { coded(StatusCode::BAD_REQUEST, "invalid_name", "name must be 1-60 characters") }
fn not_found() -> Response { coded(StatusCode::NOT_FOUND, "not_found", "device not found") }
fn not_a_device() -> Response { coded(StatusCode::BAD_REQUEST, "not_a_device", "this request needs a device token, not the owner key") }

/// Owner or a full-scope device.
fn manager(p: Principal) -> Option<Response> {
    matches!(p, Principal::Device { scope: Scope::Read, .. }).then(|| coded(StatusCode::FORBIDDEN, "read_only", "this device is read-only"))
}
fn current_id(p: Principal) -> Option<i64> { match p { Principal::Device { id, .. } => Some(id), Principal::Owner => None } }
fn user_agent(h: &HeaderMap) -> Option<String> {
    h.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).map(|u| u.chars().filter(|c| !c.is_control()).take(UA_MAX).collect::<String>()).filter(|u| !u.is_empty())
}

pub async fn me(State(s): State<AppState>, Extension(p): Extension<Principal>) -> Response {
    let a = &s.auth;
    let device = current_id(p).and_then(|id| a.by_id(id)).map(|d| d.view(Some(d.id)));
    Json(serde_json::json!({"kind": if device.is_some() { "device" } else { "owner" }, "device": device,
        "device_auth": a.available(), "owner_key_mode": a.mode().as_str()})).into_response()
}

#[derive(Deserialize)]
pub struct NameBody { name: String }

enum Created { Device(String, Device), TooMany, InvalidCode }

/// Inserts a device (at most MAX_DEVICES live ones). With `code_hash`, the pairing code is consumed in the
/// same transaction (scope / lifetime come from it); a code is not used up when the device cannot be created.
async fn create_device(s: &AppState, name: &str, ua: Option<String>, code_hash: Option<[u8; 32]>) -> Result<Created, ApiError> {
    let mut tx = s.db.begin().await?;
    let (scope, ttl, via) = match code_hash {
        None => ("full".to_string(), None, "owner_key"),
        Some(h) => {
            let r: Option<(String, Option<i32>)> = sqlx::query_as(
                "DELETE FROM drivelens.pairing_codes WHERE code_hash = $1 AND expires_at > now() RETURNING scope, device_ttl_days")
                .bind(&h[..]).fetch_optional(&mut *tx).await?;
            let Some((scope, ttl)) = r else { return Ok(Created::InvalidCode) };
            (scope, ttl, "pairing")
        }
    };
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM drivelens.devices WHERE expires_at IS NULL OR expires_at > now()").fetch_one(&mut *tx).await?;
    if n >= MAX_DEVICES { return Ok(Created::TooMany); }
    let token = new_token();
    let hash = sha256(&token);
    let row = sqlx::query_as::<_, Row>(&format!(
        "INSERT INTO drivelens.devices (name, token_hash, scope, created_via, expires_at, user_agent)
         VALUES ($1, $2, $3, $4, CASE WHEN $5::int4 IS NULL THEN NULL ELSE now() + make_interval(days => $5::int4) END, $6)
         RETURNING {COLS}")).bind(name).bind(&hash[..]).bind(&scope).bind(via).bind(ttl).bind(ua).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    let (h, d) = row.split().ok_or_else(|| anyhow::anyhow!("bad device row"))?;
    s.auth.put(h, d.clone());
    tracing::info!("auth: device {} ({}) added via {via}, scope {scope}", d.id, d.name);
    Ok(Created::Device(token, d))
}

fn created(token: String, d: &Device) -> Response {
    (StatusCode::CREATED, Json(serde_json::json!({"token": token, "device": d.view(Some(d.id))}))).into_response()
}
fn too_many_devices() -> Response { coded(StatusCode::CONFLICT, "too_many_devices", "at most 50 devices; revoke one first") }

/// POST /api/auth/devices — exchange the owner key for a device token.
pub async fn exchange(State(s): State<AppState>, Extension(p): Extension<Principal>, headers: HeaderMap, Json(b): Json<NameBody>) -> Result<Response, ApiError> {
    if !s.auth.available() { return Ok(unavailable()); }
    if p != Principal::Owner { return Ok(coded(StatusCode::FORBIDDEN, "owner_key_required", "only the owner key can be exchanged for a device token; use a pairing code")); }
    let Some(name) = clean_name(&b.name) else { return Ok(invalid_name()) };
    Ok(match create_device(&s, &name, user_agent(&headers), None).await? {
        Created::Device(t, d) => created(t, &d),
        _ => too_many_devices(),
    })
}

pub async fn list(State(s): State<AppState>, Extension(p): Extension<Principal>) -> Response {
    if !s.auth.available() { return unavailable(); }
    if let Some(r) = manager(p) { return r; }
    let now = now_secs();
    let mut v: Vec<Device> = s.auth.devices.read().unwrap().values().filter(|d| d.live(now)).cloned().collect();
    v.sort_by_key(|d| std::cmp::Reverse((d.created_at, d.id)));
    let cur = current_id(p);
    Json(v.iter().map(|d| d.view(cur)).collect::<Vec<_>>()).into_response()
}

async fn rename_device(s: &AppState, id: i64, raw: &str, cur: Option<i64>) -> Result<Response, ApiError> {
    let Some(name) = clean_name(raw) else { return Ok(invalid_name()) };
    let r = sqlx::query("UPDATE drivelens.devices SET name = $2 WHERE id = $1").bind(id).bind(&name).execute(&s.db).await?;
    if r.rows_affected() == 0 { return Ok(not_found()); }
    s.auth.update(id, |d| d.name = name.clone());
    tracing::info!("auth: device {id} renamed to {name}");
    Ok(match s.auth.by_id(id) { Some(d) => Json(d.view(cur)).into_response(), None => not_found() })
}

pub async fn rename(State(s): State<AppState>, Extension(p): Extension<Principal>, Path(id): Path<i64>, Json(b): Json<NameBody>) -> Result<Response, ApiError> {
    if !s.auth.available() { return Ok(unavailable()); }
    if let Some(r) = manager(p) { return Ok(r); }
    rename_device(&s, id, &b.name, current_id(p)).await
}
pub async fn rename_current(State(s): State<AppState>, Extension(p): Extension<Principal>, Json(b): Json<NameBody>) -> Result<Response, ApiError> {
    if !s.auth.available() { return Ok(unavailable()); }
    let Some(id) = current_id(p) else { return Ok(not_a_device()) };
    rename_device(&s, id, &b.name, Some(id)).await
}

async fn revoke_device(s: &AppState, id: i64) -> Result<Response, ApiError> {
    let name = s.auth.by_id(id).map(|d| d.name);
    let gone: Vec<Vec<u8>> = sqlx::query_scalar("DELETE FROM drivelens.devices WHERE id = $1 RETURNING token_hash").bind(id).fetch_all(&s.db).await?;
    if gone.is_empty() { return Ok(not_found()); }
    s.auth.forget(&gone.iter().filter_map(|h| h.as_slice().try_into().ok()).collect::<Vec<[u8; 32]>>());
    tracing::info!("auth: device {id} ({}) revoked", name.unwrap_or_default());
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub async fn revoke(State(s): State<AppState>, Extension(p): Extension<Principal>, Path(id): Path<i64>) -> Result<Response, ApiError> {
    if !s.auth.available() { return Ok(unavailable()); }
    if let Some(r) = manager(p) { return Ok(r); }
    revoke_device(&s, id).await
}
pub async fn revoke_current(State(s): State<AppState>, Extension(p): Extension<Principal>) -> Result<Response, ApiError> {
    if !s.auth.available() { return Ok(unavailable()); }
    let Some(id) = current_id(p) else { return Ok(not_a_device()) };
    revoke_device(&s, id).await
}

#[derive(Deserialize)]
pub struct ExceptParams { except: Option<String> }

/// DELETE /api/auth/devices?except=current — every device but the caller (all of them for the owner key).
pub async fn revoke_others(State(s): State<AppState>, Extension(p): Extension<Principal>, Query(q): Query<ExceptParams>) -> Result<Response, ApiError> {
    if !s.auth.available() { return Ok(unavailable()); }
    if let Some(r) = manager(p) { return Ok(r); }
    if q.except.as_deref() != Some("current") { return Ok(coded(StatusCode::BAD_REQUEST, "bad_request", "use ?except=current")); }
    let keep = current_id(p).unwrap_or(0);
    let gone: Vec<Vec<u8>> = sqlx::query_scalar("DELETE FROM drivelens.devices WHERE id <> $1 RETURNING token_hash").bind(keep).fetch_all(&s.db).await?;
    s.auth.forget(&gone.iter().filter_map(|h| h.as_slice().try_into().ok()).collect::<Vec<[u8; 32]>>());
    tracing::info!("auth: {} other device(s) revoked", gone.len());
    Ok(Json(serde_json::json!({"revoked": gone.len()})).into_response())
}

#[derive(Deserialize)]
pub struct PairingBody { scope: String, device_ttl_days: Option<i32> }

pub async fn create_pairing(State(s): State<AppState>, Extension(p): Extension<Principal>, Json(b): Json<PairingBody>) -> Result<Response, ApiError> {
    if !s.auth.available() { return Ok(unavailable()); }
    if let Some(r) = manager(p) { return Ok(r); }
    let Some(scope) = Scope::parse(&b.scope) else { return Ok(coded(StatusCode::BAD_REQUEST, "invalid_scope", "scope must be \"full\" or \"read\"")) };
    if let Some(d) = b.device_ttl_days {
        if scope == Scope::Full { return Ok(coded(StatusCode::BAD_REQUEST, "ttl_requires_read", "device_ttl_days is only allowed with scope \"read\"")); }
        if !(1..=365).contains(&d) { return Ok(coded(StatusCode::BAD_REQUEST, "invalid_ttl", "device_ttl_days must be 1-365")); }
    }
    let _ = sqlx::query("DELETE FROM drivelens.pairing_codes WHERE expires_at <= now()").execute(&s.db).await;
    // 40 random bits: a collision is practically impossible, but retry instead of failing on one
    for _ in 0..3 {
        let code = new_code();
        let r: Result<i64, sqlx::Error> = sqlx::query_scalar(
            "INSERT INTO drivelens.pairing_codes (code_hash, scope, device_ttl_days, created_by, expires_at)
             VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5)) RETURNING floor(extract(epoch FROM expires_at))::int8")
            .bind(&sha256(&code)[..]).bind(scope.as_str()).bind(b.device_ttl_days).bind(current_id(p)).bind(CODE_TTL_MIN)
            .fetch_one(&s.db).await;
        let exp = match r {
            Ok(e) => e,
            Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("23505") => continue,
            Err(e) => return Err(e.into()),
        };
        // at most MAX_OPEN_CODES unused codes: the oldest go first
        sqlx::query("DELETE FROM drivelens.pairing_codes WHERE id NOT IN (SELECT id FROM drivelens.pairing_codes ORDER BY id DESC LIMIT $1)")
            .bind(MAX_OPEN_CODES).execute(&s.db).await?;
        tracing::info!("auth: pairing code issued (scope {}) by {}", scope.as_str(),
            current_id(p).map_or("the owner key".to_string(), |id| format!("device {id}")));
        return Ok((StatusCode::CREATED, Json(serde_json::json!({"code": display_code(&code), "expires_at": iso(exp)}))).into_response());
    }
    Err(anyhow::anyhow!("could not generate a unique pairing code").into())
}

#[derive(Deserialize)]
pub struct PairBody { code: String, name: String }

/// POST /api/auth/pair — unauthenticated: a pairing code becomes a device token. Own failure limit
/// (PAIR_CLIENT_LIMIT per client, PAIR_GLOBAL_LIMIT overall per 10 minutes); beyond it codes are not evaluated.
pub async fn pair(State(s): State<AppState>, ci: Option<ConnectInfo<SocketAddr>>, headers: HeaderMap, Json(b): Json<PairBody>) -> Result<Response, ApiError> {
    let a = &s.auth;
    if !a.available() { return Ok(unavailable()); }
    let now = Instant::now();
    let key = key_of(client_ip(&headers, ci.map(|c| c.0.ip()), trust_proxy_headers()));
    if a.pair_blocked(&key, now) {
        a.delay(1000).await;
        return Ok((StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, "600")],
            Json(serde_json::json!({"error": "too many failed pairing attempts; try again in 10 minutes", "code": "rate_limited"}))).into_response());
    }
    let Some(name) = clean_name(&b.name) else { return Ok(invalid_name()) };
    let invalid = || coded(StatusCode::BAD_REQUEST, "invalid_code", "the pairing code is wrong, used or expired");
    let Some(code) = normalize_code(&b.code) else {
        a.pair_failed(key, now); a.delay(300).await;
        return Ok(invalid());
    };
    Ok(match create_device(&s, &name, user_agent(&headers), Some(sha256(&code))).await? {
        Created::Device(t, d) => created(t, &d),
        Created::TooMany => too_many_devices(),
        Created::InvalidCode => { a.pair_failed(key, now); a.delay(300).await; invalid() }
    })
}

#[cfg(test)]
impl AuthState {
    /// In-memory state for unit tests (no database, no failure delays).
    pub fn for_tests(owner_key: &str, mode: OwnerKeyMode, available: bool) -> AuthState {
        let a = AuthState::new(owner_key, mode, None, false);
        a.available.store(available, Ordering::Relaxed);
        a
    }
    pub fn add_test_device(&self, token: &str, id: i64, scope: Scope, expires_at: Option<i64>) {
        self.put(sha256(token), Device { id, name: format!("test {id}"), scope, created_via: "owner_key".into(), created_at: now_secs(),
            expires_at, last_used_at: None, last_ip: None, user_agent: None, flushed_at: i64::MAX / 2 });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;

    const OWNER: &str = "owner-key-0123456789abcdefghijklmnop";
    const DEV_FULL: &str = "dlt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const DEV_READ: &str = "dlt_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const DEV_OLD: &str = "dlt_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

    fn state(mode: OwnerKeyMode) -> Arc<AuthState> {
        let a = AuthState::for_tests(OWNER, mode, true);
        a.add_test_device(DEV_FULL, 1, Scope::Full, None);
        a.add_test_device(DEV_READ, 2, Scope::Read, Some(now_secs() + 3600));
        a.add_test_device(DEV_OLD, 3, Scope::Full, Some(now_secs() - 1));
        Arc::new(a)
    }

    /// Same shape as the real router: /api nest, auth as route_layer, /api/auth/pair merged afterwards.
    fn app(a: Arc<AuthState>) -> Router {
        let ok = || async { "ok" };
        let inner = Router::new()
            .route("/cars", get(ok))
            .route("/addresses/:id/alias", axum::routing::put(ok))
            .route("/push/subscription", axum::routing::post(ok))
            .route("/auth/devices", get(ok).post(ok))
            .route("/auth/devices/current", axum::routing::patch(ok).delete(ok))
            .route("/auth/devices/:id", axum::routing::delete(ok))
            .route_layer(middleware::from_fn(move |req: Request, next: Next| {
                let a = a.clone();
                async move { check(&a, req, next).await }
            }))
            .merge(Router::new().route("/auth/pair", axum::routing::post(ok)));
        Router::new().nest("/api", inner)
    }

    async fn call(a: &Arc<AuthState>, method: &str, path: &str, token: Option<&str>) -> (StatusCode, String) {
        let mut b = axum::http::Request::builder().method(method).uri(path);
        if let Some(t) = token { b = b.header("authorization", format!("Bearer {t}")); }
        let mut r = b.body(axum::body::Body::empty()).unwrap();
        r.extensions_mut().insert(ConnectInfo::<SocketAddr>("127.0.0.1:1".parse().unwrap()));
        let res = app(a.clone()).oneshot(r).await.unwrap();
        let st = res.status();
        let body = axum::body::to_bytes(res.into_body(), 1 << 16).await.unwrap();
        (st, String::from_utf8_lossy(&body).into_owned())
    }

    #[tokio::test]
    async fn owner_and_device_tokens() {
        let a = state(OwnerKeyMode::Full);
        assert_eq!(call(&a, "GET", "/api/cars", Some(OWNER)).await.0, StatusCode::OK);
        assert_eq!(call(&a, "GET", "/api/cars", Some("dlt_unknownunknownunknownunknownunknownunknown")).await.0, StatusCode::UNAUTHORIZED);
        assert_eq!(call(&a, "GET", "/api/cars", Some(DEV_FULL)).await.0, StatusCode::OK);
        assert_eq!(call(&a, "GET", "/api/cars", Some(DEV_OLD)).await.0, StatusCode::UNAUTHORIZED, "expired device");
        assert_eq!(call(&a, "GET", "/api/cars", None).await.0, StatusCode::UNAUTHORIZED);
        // use is noted in memory
        assert!(a.by_id(1).unwrap().last_used_at.is_some());
    }

    #[tokio::test]
    async fn read_only_devices() {
        let a = state(OwnerKeyMode::Full);
        assert_eq!(call(&a, "GET", "/api/cars", Some(DEV_READ)).await.0, StatusCode::OK);
        let (st, body) = call(&a, "PUT", "/api/addresses/1/alias", Some(DEV_READ)).await;
        assert_eq!(st, StatusCode::FORBIDDEN);
        assert!(body.contains("\"read_only\""), "{body}");
        assert_eq!(call(&a, "POST", "/api/push/subscription", Some(DEV_READ)).await.0, StatusCode::OK);
        assert_eq!(call(&a, "DELETE", "/api/auth/devices/current", Some(DEV_READ)).await.0, StatusCode::OK);
        assert_eq!(call(&a, "PATCH", "/api/auth/devices/current", Some(DEV_READ)).await.0, StatusCode::OK);
        assert_eq!(call(&a, "DELETE", "/api/auth/devices/1", Some(DEV_READ)).await.0, StatusCode::FORBIDDEN);
        assert_eq!(call(&a, "POST", "/api/auth/devices", Some(DEV_READ)).await.0, StatusCode::FORBIDDEN);
        // full devices may write
        assert_eq!(call(&a, "PUT", "/api/addresses/1/alias", Some(DEV_FULL)).await.0, StatusCode::OK);
    }

    #[tokio::test]
    async fn pair_only_mode() {
        let a = state(OwnerKeyMode::PairOnly);
        let (st, body) = call(&a, "GET", "/api/cars", Some(OWNER)).await;
        assert_eq!(st, StatusCode::FORBIDDEN);
        assert!(body.contains("\"owner_key_pair_only\""), "{body}");
        assert_eq!(call(&a, "GET", "/api/auth/devices", Some(OWNER)).await.0, StatusCode::OK);
        assert_eq!(call(&a, "GET", "/api/cars", Some(DEV_FULL)).await.0, StatusCode::OK);
    }

    #[tokio::test]
    async fn pair_only_blocks_the_owner_key_while_blocked() {
        let a = state(OwnerKeyMode::PairOnly);
        for _ in 0..FAIL_LIMIT { assert_eq!(call(&a, "GET", "/api/auth/devices", Some("wrong-owner-key-xxxxxxxx")).await.0, StatusCode::UNAUTHORIZED); }
        assert_eq!(call(&a, "GET", "/api/auth/devices", Some("wrong-owner-key-xxxxxxxx")).await.0, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(call(&a, "GET", "/api/auth/devices", Some(OWNER)).await.0, StatusCode::TOO_MANY_REQUESTS, "not evaluated while blocked");
        // device tokens are still evaluated
        assert_eq!(call(&a, "GET", "/api/cars", Some(DEV_FULL)).await.0, StatusCode::OK);
    }

    #[tokio::test]
    async fn full_mode_never_blocks_the_correct_owner_key() {
        let a = state(OwnerKeyMode::Full);
        for _ in 0..FAIL_LIMIT { assert_eq!(call(&a, "GET", "/api/cars", Some("wrong")).await.0, StatusCode::UNAUTHORIZED); }
        assert_eq!(call(&a, "GET", "/api/cars", Some("wrong")).await.0, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(call(&a, "GET", "/api/cars", Some(OWNER)).await.0, StatusCode::OK);
        assert_eq!(call(&a, "GET", "/api/cars", Some(DEV_FULL)).await.0, StatusCode::OK, "device token while blocked");
        assert_eq!(call(&a, "GET", "/api/cars", Some(DEV_READ)).await.0, StatusCode::OK);
    }

    #[tokio::test]
    async fn pair_only_global_limit() {
        let a = state(OwnerKeyMode::PairOnly);
        let now = Instant::now();
        for _ in 0..OWNER_GLOBAL_LIMIT { a.owner_failed(now); }
        // a client without any failures of its own is not evaluated either
        assert_eq!(call(&a, "GET", "/api/auth/devices", Some(OWNER)).await.0, StatusCode::TOO_MANY_REQUESTS);
        assert!(!a.owner_blocked("10.9.9.9", now + FAIL_WINDOW), "window ends");
    }

    #[tokio::test]
    async fn unavailable_device_auth_keeps_the_owner_key() {
        let a = Arc::new(AuthState::for_tests(OWNER, OwnerKeyMode::Full, false));
        a.add_test_device(DEV_FULL, 1, Scope::Full, None);
        assert_eq!(call(&a, "GET", "/api/cars", Some(OWNER)).await.0, StatusCode::OK);
        assert_eq!(call(&a, "GET", "/api/cars", Some(DEV_FULL)).await.0, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn pair_route_is_public() {
        let a = state(OwnerKeyMode::Full);
        assert_eq!(call(&a, "POST", "/api/auth/pair", None).await.0, StatusCode::OK);
        assert_eq!(call(&a, "POST", "/api/auth/devices", None).await.0, StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn token_format() {
        let t = new_token();
        assert_eq!(t.len(), 47);
        assert!(t.starts_with("dlt_"));
        assert!(t[4..].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'), "{t}");
        assert_eq!(Base64UrlUnpadded::decode_vec(&t[4..]).unwrap().len(), 32);
        assert_ne!(new_token(), t);
    }

    #[test]
    fn pairing_codes() {
        for _ in 0..200 {
            let c = new_code();
            assert_eq!(c.len(), 8);
            assert!(c.bytes().all(|b| CROCKFORD.contains(&b)), "{c}");
            assert!(!c.contains(['I', 'L', 'O', 'U']));
            assert_eq!(normalize_code(&display_code(&c)).as_deref(), Some(c.as_str()));
        }
        assert_eq!(normalize_code("7kq2-m9xd").as_deref(), Some("7KQ2M9XD"));
        assert_eq!(normalize_code(" 7KQ2 M9XD ").as_deref(), Some("7KQ2M9XD"));
        assert_eq!(normalize_code("ilo0-abcd").as_deref(), Some("1100ABCD"));
        assert_eq!(normalize_code("IlOo-0000").as_deref(), Some("11000000"));
        assert_eq!(normalize_code("ABCD-EFG"), None);
        assert_eq!(normalize_code("ABCD-EFGHJ"), None);
        assert_eq!(normalize_code("ABCD-EFGU"), None, "U is not Crockford");
        assert_eq!(normalize_code("ABCD-ÉFGH"), None);
        assert_eq!(display_code("7KQ2M9XD"), "7KQ2-M9XD");
    }

    #[test]
    fn pairing_failure_limits() {
        let a = AuthState::for_tests(OWNER, OwnerKeyMode::Full, true);
        let now = Instant::now();
        for _ in 0..PAIR_CLIENT_LIMIT { assert!(!a.pair_blocked("1.1.1.1", now)); a.pair_failed("1.1.1.1".into(), now); }
        assert!(a.pair_blocked("1.1.1.1", now), "per client");
        assert!(!a.pair_blocked("2.2.2.2", now));
        // all clients together
        for i in 0..(PAIR_GLOBAL_LIMIT - PAIR_CLIENT_LIMIT) { a.pair_failed(format!("10.0.0.{i}"), now); }
        assert!(a.pair_blocked("2.2.2.2", now), "global");
        assert!(!a.pair_blocked("2.2.2.2", now + FAIL_WINDOW), "window ends");
        // separate from the owner-key limit
        assert_eq!(failures(&a.fails, "1.1.1.1", now), 0);
    }

    #[test]
    fn owner_key_compared_as_digest() {
        let a = AuthState::for_tests(OWNER, OwnerKeyMode::Full, true);
        assert!(a.owner_matches(OWNER));
        // different lengths (prefix, longer, empty) all go through the same 32-byte comparison
        for c in ["", "o", &OWNER[..OWNER.len() - 1], &format!("{OWNER}x")] { assert!(!a.owner_matches(c), "{c}"); }
        assert!(constant_time_eq(&sha256("x"), &sha256("x")));
        assert!(!constant_time_eq(&sha256("x"), &sha256("y")));
    }

    #[test]
    fn names_and_modes() {
        assert_eq!(clean_name("  iPhone · Safari \n").as_deref(), Some("iPhone · Safari"));
        assert_eq!(clean_name("a\u{0007}b").as_deref(), Some("ab"));
        assert_eq!(clean_name("   "), None);
        assert_eq!(clean_name(&"あ".repeat(60)).map(|n| n.chars().count()), Some(60));
        assert_eq!(clean_name(&"あ".repeat(61)), None);
        assert_eq!(OwnerKeyMode::parse(None).unwrap(), OwnerKeyMode::Full);
        assert_eq!(OwnerKeyMode::parse(Some(" Pair-Only ")).unwrap(), OwnerKeyMode::PairOnly);
        assert!(OwnerKeyMode::parse(Some("off")).is_err());
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso(1_700_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(iso(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn permissions_use_the_full_path() {
        let r = Principal::Device { id: 2, scope: Scope::Read };
        assert!(permission(r, OwnerKeyMode::Full, &Method::POST, "/api/push/test").is_none());
        assert!(permission(r, OwnerKeyMode::Full, &Method::DELETE, "/api/auth/devices/current").is_none());
        assert!(permission(r, OwnerKeyMode::Full, &Method::DELETE, "/api/auth/devices/7").is_some());
        assert!(permission(r, OwnerKeyMode::Full, &Method::POST, "/api/auth/pairings").is_some());
        assert!(permission(Principal::Owner, OwnerKeyMode::PairOnly, &Method::GET, "/api/auth/me").is_none());
        assert!(permission(Principal::Owner, OwnerKeyMode::PairOnly, &Method::GET, "/api/authx").is_some());
        assert!(permission(Principal::Owner, OwnerKeyMode::Full, &Method::PUT, "/api/addresses/1/alias").is_none());
    }
}
