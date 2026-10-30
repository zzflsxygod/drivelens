# app-i18n — UI language, string tables and formatting

> Reverse-engineered from `main` @ 9b1c39c (app v1.2.2, drivelens-api 0.14.0, API level 15); updated for changes through `main` @ 9bd5dd2 (app v1.3.1, drivelens-api 0.15.0, API level 16).
> `src:` line numbers refer to 9b1c39c. Code added or rewritten after 9b1c39c is cited as `path` plus a symbol name. "At this commit" means 9bd5dd2.
> Sources: `app/src/i18n.ts`, `app/src/locales/zh.ts`, `app/src/locales/en.ts`, `app/src/locales/ja.ts`, `app/scripts/check-i18n.mjs`; call sites in `app/src/main.ts`, `app/src/setup.ts`, `app/src/api.ts`, `app/src/map.ts`, `app/src/report.ts`.
> In this document, "the system" means the app's localization layer: language resolution and `t()` in `app/src/i18n.ts`, the three locale dictionaries, the formatting helpers, and the `check-i18n` build gate.
> Reviewed against `main` @ 9b1c39c on 2026-10-26: every former `TO CONFIRM` mark is resolved as *Confirmed from code*, *Confirmed (owner decision)*, *Confirmed (current scope / design)* or **[OWNER DECISION NEEDED]**, and every CB row in section 7 ends with a **Review** verdict (see OVERVIEW §1).

## 1. Goal

DriveLens shows its UI in Chinese (中文), English and Japanese (日本語). This module chooses the UI language for each page load, turns string keys into text in that language, formats dates, durations, numbers and relative times for it, and stops a build when the three string tables disagree. Chinese is the source language. The English and Japanese tables must stay in step with it (doc: README.md "Features"; doc: CHANGELOG.md v0.11.0; doc: docs/DEVELOPMENT.md "Checks before you commit").

## 2. Responsibility boundaries

### 2.1 In scope
- Resolving the UI language at page load from the saved setting, the system languages, and the pre-v0.11.0 migration rule.
- The `t()` lookup with `{name}` placeholders and the `{n|one|other}` plural form.
- The three dictionaries `zh`, `en` and `ja`, their key format and the rule that all three have the same key set.
- The formatting helpers `fmtDateTime`, `fmtTime`, `fmtDay`, `fmtMonthDay`, `monthLabel`, `fmtDur`, `ago`, `fmtNum`, `weekdays` and `locale()`.
- The build gate `app/scripts/check-i18n.mjs` and its wiring into `npm run build` / `npm run build:web`.

### 2.2 Out of scope
- The language `<select>` in Settings and the reload after a change → `app-shell` (`app/src/main.ts:411-412`, `:448-451`).
- The language `<select>` in the first-run wizard and its draft restore → `app-connection` (`app/src/setup.ts:160`, `:180-190`).
- Storage of the settings object `drivelens-settings` (`loadSettings` / `saveSettings`) → `app-connection`.
- Map label language (`labelLang`) and how labels are drawn → `app-ui-kit` (`app/src/map.ts:31-45`); its default comes from this module (see I18N-060).
- Currency defaults (`localeCurrency`, `fmtMoney`) → `app-connection` (`app/src/api.ts:103-126`).
- The language sent with a push subscription (`locale: currentLang()`) and the server-side message texts → `app-notifications`, `api-push`.
- Language-specific fonts on the share card → `app-journeys` (`app/src/journey2.ts:143`).
- Text that arrives as data from the server or the demo dataset (place names, journey names, speed-band labels such as `市区`) → `api-*` modules and `app-demo`. This module does not translate data.

### 2.3 Interfaces and dependencies
- **Depends on:**
  - `app-connection`: the `localStorage` key `drivelens-settings`. This module reads `uiLang` and `apiUrl`, and the one-time migration writes `uiLang`, `currency` and `labelLang` (`app/src/i18n.ts:11`, `:21-35`).
  - Browser APIs: `navigator.languages`, `navigator.language`, `Intl.DateTimeFormat`, `Number.prototype.toLocaleString`, `document.documentElement.lang`, `localStorage`.
  - Node.js at build time for `check-i18n.mjs` (`node:fs`, `node:path`, `node:url`).
  - `ops-delivery`: CI runs `npm run build` and `npm run build:web`, and both start with the check (`.github/workflows/ci.yml:35-36`, `.github/workflows/web.yml:50`).
- **Used by:** every `app-*` module that renders text (`t()` and the formatters), in particular:
  - `app-shell`: Settings language select (`langSetting`), tab labels, and `installGuideUrl()` in `links.ts`, which uses `currentLang()`.
  - `app-connection`: the setup wizard language select; `defaultLabelLang()` returns `currentLang()` (`app/src/api.ts:113-114`).
  - `app-ui-kit`: map labels default to the UI language through `defaultLabelLang()` (`app/src/map.ts:39`).
  - `app-insights`: `monthLabel`, `fmtMonthDay`, `weekdays`, plus an English-only month name in `app/src/report.ts:100`.
  - `app-notifications`: sends `currentLang()` as the subscription `locale` (`app/src/notify.ts:37`, `:62`).
  - `app-journeys`: share-card font choice (`app/src/journey2.ts:143`).
- **Provided interface:**

| Export (`app/src/i18n.ts`) | Purpose |
|---|---|
| `type Lang = "zh" \| "en" \| "ja"`, `type LangSetting = "auto" \| Lang`, `type Key` | Language and key types (`Key` = keys of the zh table) |
| `systemLang(langs?)` | First supported system language, else `"en"` |
| `langSetting()` | Saved `uiLang`, or `"auto"` |
| `currentLang()` | Language of this page load |
| `setLang(l)` | Sets the language variable and `<html lang>` (no callers; see CB-2) |
| `locale()` | BCP-47 tag for `Intl`: `zh-CN`, `en-US`, `ja-JP` |
| `t(key, params?)` | Translated string |
| `fmtDateTime`, `fmtTime`, `fmtDay`, `fmtMonthDay`, `monthLabel`, `fmtDur`, `ago`, `fmtNum`, `weekdays` | Formatting helpers |

| Other interface | Purpose |
|---|---|
| `app/src/locales/{zh,en,ja}.ts` default exports | String tables, one `"key": "value",` per line |
| `npm run check:i18n` (`app/package.json:10`) | Runs the gate on its own |
| `localStorage["drivelens-settings"].uiLang` | `"auto"`, `"zh"`, `"en"` or `"ja"`; absent means a pre-v0.11.0 install (`app/src/main.ts:450`) |

## 3. External behavior

### 3.1 Language resolution
- **I18N-001** When the app module loads and `drivelens-settings.uiLang` is `"zh"`, `"en"` or `"ja"`, the system SHALL use that language for the whole page load. (src: app/src/i18n.ts:21-24, 36)
- **I18N-002** When `uiLang` is `"auto"`, missing or any other value, or the settings JSON cannot be read, the system SHALL use the first entry of `navigator.languages` whose first two letters, lower-cased, are `zh`, `ja` or `en`. If `navigator.languages` is empty it SHALL use `[navigator.language || "en"]`, and if no entry matches it SHALL use English. (src: app/src/i18n.ts:13-24, 36; doc: CHANGELOG.md v0.11.0)
- **I18N-003** When the system language is any Chinese variant, such as `zh-TW` or `zh-HK`, the system SHALL use the single Chinese table and format with `zh-CN`. (src: app/src/i18n.ts:16-17, 40)
- **I18N-004** When the module loads, `drivelens-settings` has an `apiUrl`, and it has no `uiLang` key (an install from before v0.11.0), the system SHALL first write `uiLang: "zh"` to the settings. It SHALL also write `currency` (keeping a saved value, else `"JPY"`) and `labelLang` (keeping a saved value, else `"ja"`). (src: app/src/i18n.ts:26-31; comment: app/src/i18n.ts:25, 29)
- **I18N-005** When the module loads and `drivelens-settings` has neither `apiUrl` nor `uiLang`, the system SHALL write `uiLang: "auto"`, so a fresh install is not later taken for a pre-v0.11.0 install. (src: app/src/i18n.ts:32-33; comment: app/src/i18n.ts:32)
- **I18N-006** When reading or writing `localStorage` throws during that migration, the system SHALL ignore the error and continue loading. (src: app/src/i18n.ts:27, 34)
- **I18N-007** When the language is resolved, the system SHALL set `document.documentElement.lang` to `zh-CN`, `en-US` or `ja-JP`. (src: app/src/i18n.ts:40, 43)
- **I18N-008** When the user picks a UI language in Settings, the app SHALL save it as `uiLang` (`"auto"` is saved too) and reload the page. The new language SHALL take effect on that reload, because the system resolves the language once per page load. (src: app/src/main.ts:448-451; app/src/i18n.ts:36; comment: app/src/main.ts:451)
- **I18N-009** When the user picks a language in the setup wizard, the app SHALL save `uiLang` and store the typed server address and credential in `sessionStorage["drivelens-setup-draft"]`. It SHALL then reload, put the two values back into the fields, and remove the draft. (src: app/src/setup.ts:180-190; comment: app/src/setup.ts:182)

### 3.2 String lookup (`t`)
- **I18N-010** When `t(key)` is called, the system SHALL return the entry for the current language. If that entry is `null` or `undefined`, it SHALL return the Chinese entry, and if that is missing too, the key itself. An empty string is returned as is. (src: app/src/i18n.ts:46-47; comment: app/src/i18n.ts:45)
- **I18N-011** When `t()` is called without parameters, the system SHALL return the string unchanged, with any `{…}` tokens still in it. (src: app/src/i18n.ts:48)
- **I18N-012** When parameters are given and the string contains `{name|one|other}`, the system SHALL use `one` if `Number(params[name]) === 1` and `other` otherwise. If `name` is not among the parameters, it SHALL leave the token unchanged. (src: app/src/i18n.ts:49-50)
- **I18N-013** When parameters are given, the system SHALL replace each `{name}` that has a matching parameter with `String(value)` and leave tokens without a matching parameter unchanged. Plural tokens are processed before plain tokens. (src: app/src/i18n.ts:50-51)
- **I18N-014** When `t()` inserts parameters, the system SHALL insert them verbatim, without HTML escaping. Dictionary strings may contain markup, for example `"sel.picked": "<b>{n}</b> selected"`. (src: app/src/i18n.ts:46-52; app/src/locales/en.ts:373)

### 3.3 Dictionaries
- **I18N-020** When the app is type-checked (`tsc`), the system SHALL reject an `en` or `ja` table that lacks a key of the `zh` table or has a key the `zh` table does not have. Both are typed as `Record<keyof typeof zh, string>`, and `zh` is declared `as const`. (src: app/src/locales/zh.ts:3, 562; app/src/locales/en.ts:2-4; app/src/locales/ja.ts:2-4; comment: app/src/locales/zh.ts:2)
- **I18N-021** When a new user-facing string is added, contributors SHALL add it to all three tables, with Chinese as the source. (doc: CONTRIBUTING.md:15; doc: docs/DEVELOPMENT.md "Checks before you commit")
- **I18N-022** When a key is looked up, the system SHALL use the dotted form `<area>.<name>`, for example `common.save`, `su.welcome` or `rp.unitTimes`. (src: app/src/locales/zh.ts:4-561)

### 3.4 Formatting helpers
- **I18N-030** When `fmtDateTime(iso)` gets a timestamp, the system SHALL format it as two-digit month and day plus hour:minute on a 24-hour clock, using `locale()` and the device time zone. For `null`, `undefined` or an empty string it SHALL return `—`. (src: app/src/i18n.ts:55-57)
- **I18N-031** When `fmtTime(v)` is called, the system SHALL return a two-digit hour:minute on a 24-hour clock in the device time zone. (src: app/src/i18n.ts:58)
- **I18N-032** When `fmtDay(date)` is called, the system SHALL return year, month and day in the numeric style of `locale()`. (src: app/src/i18n.ts:59-60)
- **I18N-033** When `fmtMonthDay(iso)` is called and the language is zh or ja, the system SHALL return `M/D` without leading zeros (for example `10/19`). When the language is en, it SHALL return the short month name and day (for example `Oct 19`). (src: app/src/i18n.ts:61-64; see CB-1 for the date basis)
- **I18N-034** When `monthLabel("YYYY-MM…")` is called and the language is en, the system SHALL return `Oct 2026` style text built with `Intl` (`en-US`, UTC) from the first seven characters. For zh and ja it SHALL fill the `fmt.month` template (`{y}年{m}月`) with the year and the month number without a leading zero. (src: app/src/i18n.ts:65-68; app/src/locales/zh.ts:440; app/src/locales/ja.ts:441)
- **I18N-035** When `fmtDur(m)` gets `null` or `undefined`, the system SHALL return `—`. For `m ≥ 60` it SHALL fill `fmt.hm` with `h = floor(m/60)` and `m = round(m mod 60)` (`1h 5m`, `1小时5分`, `1時間5分`). Otherwise it SHALL fill `fmt.m` with `round(m)` (`5 min`, `5分钟`, `5分`). (src: app/src/i18n.ts:69-71; app/src/locales/zh.ts:441-442; app/src/locales/en.ts:442-443; app/src/locales/ja.ts:442-443)
- **I18N-036** When `ago(iso)` is called, the system SHALL compute whole minutes since `iso`, treating a time in the future as 0. Below 1 minute it SHALL return `ago.now`. Below 60 minutes it SHALL return `ago.min` with `n` minutes. Below 1440 minutes it SHALL return `ago.hour` with `floor(n/60)`. Otherwise it SHALL return `ago.day` with `floor(n/1440)`, and English uses the plural form for days. (src: app/src/i18n.ts:72-79; app/src/locales/en.ts:444-447)
- **I18N-037** When `fmtNum(v, d = 0)` gets `null`, `undefined` or a non-finite number, the system SHALL return `—`. Otherwise it SHALL return `v.toLocaleString(locale())` with exactly `d` decimals. (src: app/src/i18n.ts:80-81)
- **I18N-038** When `weekdays()` is called, the system SHALL return seven short weekday names starting with Monday, from `fmt.weekdays`. (src: app/src/i18n.ts:82-83; app/src/locales/zh.ts:340; app/src/locales/en.ts:341; app/src/locales/ja.ts:341)
- **I18N-039** When `locale()` is called, the system SHALL return `zh-CN`, `en-US` or `ja-JP` for the current language. (src: app/src/i18n.ts:40-42)

### 3.5 Build gate (`check-i18n.mjs`)
- **I18N-040** When `npm run build` or `npm run build:web` runs, the system SHALL run `node scripts/check-i18n.mjs` before `tsc` and `vite build`. A non-zero exit SHALL stop the build. `npm run check:i18n` runs only the check. (src: app/package.json:9-10, 13; doc: CONTRIBUTING.md:77; doc: docs/DEVELOPMENT.md "Checks before you commit")
- **I18N-041** When `en` or `ja` lacks a `zh` key, or has a key that `zh` does not have, the check SHALL report an error. (src: app/scripts/check-i18n.mjs:30-39; comment: app/scripts/check-i18n.mjs:4)
- **I18N-042** When a locale file defines the same key twice, the check SHALL report an error. (src: app/scripts/check-i18n.mjs:18)
- **I18N-043** When the set of placeholder names in an `en` or `ja` string differs from the `zh` string, the check SHALL report an error. Names come from both `{name}` and `{name|…}`. (src: app/scripts/check-i18n.mjs:29, 34; comment: app/scripts/check-i18n.mjs:5)
- **I18N-044** When an `en` or `ja` string is empty or whitespace while the `zh` string is not, and the key is not listed in `EMPTY_OK` (only `rp.unitTimes`), the check SHALL print a warning but not fail. (src: app/scripts/check-i18n.mjs:24, 35)
- **I18N-045** When a `.ts` file directly in `app/src` (except `vite-env.d.ts`) calls `t("key")` with a key that is not in `zh`, the check SHALL report an error naming the file. Comment lines and trailing ` // …` comments are ignored. (src: app/scripts/check-i18n.mjs:41, 44-48; comment: app/scripts/check-i18n.mjs:6)
- **I18N-046** When such a file calls `t(\`prefix.${…}\`)` and no `zh` key starts with that prefix, the check SHALL report an error. (src: app/scripts/check-i18n.mjs:49)
- **I18N-047** When a non-comment line of such a file still contains CJK characters (U+3000–U+30FF, U+4E00–U+9FFF, U+FF01–U+FF5E) after the allowed strings `中文`, `日本語` and `（往返）` are removed, the check SHALL report an error with `file:line`. (src: app/scripts/check-i18n.mjs:43, 50-55; comment: app/scripts/check-i18n.mjs:7)
- **I18N-048** When `zh` keys are neither used directly nor covered by a dynamic prefix, the check SHALL print a warning listing them but not fail. (src: app/scripts/check-i18n.mjs:57-58; comment: app/scripts/check-i18n.mjs:8)
- **I18N-049** When fewer than 10 keys are parsed from `zh.ts`, the check SHALL report an error (a guard against the parser falling out of date). (src: app/scripts/check-i18n.mjs:28)
- **I18N-050** When the check finds errors, it SHALL print the error count and exit with code 1. Otherwise it SHALL print `✓ i18n: <keys> keys × 3 languages, <used> used directly` and exit with code 0. (src: app/scripts/check-i18n.mjs:59-60)
- **I18N-051** When the check scans source files, it SHALL read only the `.ts` files directly in `app/src`. Files in subdirectories (`app/src/demo/`, `app/src/locales/`) are not scanned for keys or CJK text. (src: app/scripts/check-i18n.mjs:13, 41)

### 3.6 Language-dependent defaults for other modules
- **I18N-060** When no map label language is saved (`labelLang` is absent), the map label language SHALL default to the current UI language. (src: app/src/api.ts:113-114; app/src/map.ts:39; app/src/locales/en.ts:69)

## 4. Key design decisions
- **D-1 Chinese is the source language.** `zh.ts` defines the key set and the `Key` type, and `en` and `ja` are typed against it. `t()` falls back to Chinese. (comment: app/src/i18n.ts:2; comment: app/src/locales/zh.ts:2; doc: docs/DEVELOPMENT.md "Checks before you commit") The rationale is that the app was Chinese-only before v0.11.0: the migration keeps Chinese for those installs (comment: app/src/i18n.ts:25; doc: CHANGELOG.md v0.11.0).
- **D-2 Two layers of key checking.** TypeScript rejects missing and extra keys. The Node script adds checks the type system cannot do: placeholder sets, unknown keys in `t("…")` calls, dynamic prefixes and leftover CJK text. (comment: app/src/locales/zh.ts:2; src: app/scripts/check-i18n.mjs:3-8)
- **D-3 One language per page load; switching reloads.** `lang` is computed once at module load, and the Settings and wizard selects save and reload. (src: app/src/i18n.ts:36; app/src/main.ts:451; app/src/setup.ts:185; comment: app/src/main.ts:451 "every view re-renders in the new language") Confirmed: the reason is that screens are rendered imperatively as HTML strings, so a reload is the simplest way to re-render everything.
- **D-4 Old installs keep their implicit defaults.** Installs from before v0.11.0 keep Chinese, `JPY` and Japanese map labels. New installs follow the system. (comment: app/src/i18n.ts:25, 29, 32; doc: CHANGELOG.md v0.11.0)
- **D-5 A small custom plural syntax instead of `Intl.PluralRules`.** `{n|one|other}` picks by `n === 1`, and only English strings use it (16 strings at this commit). (comment: app/src/i18n.ts:49 "used by English") Confirmed rationale: Chinese and Japanese do not inflect for number, so a two-form English rule is enough.
- **D-6 Formatting through `Intl` with the language's BCP-47 tag.** Dates and times use the device time zone. English month labels use `Intl`, and Chinese and Japanese month labels use a template. (src: app/src/i18n.ts:40-42, 55-68; comment: app/src/i18n.ts:80 "locale grouping is the same \",\" for all three languages")
- **D-7 `t()` does no HTML escaping.** Dictionary strings are trusted markup. Callers escape dynamic values themselves, for example `t("demo.backTo", { u: esc(real) })` in `app/src/main.ts:320`. (src: app/src/i18n.ts:46-52) Confirmed from code: escaping is the caller's responsibility by convention, not by enforcement.

## 5. Constraints
- Exactly three UI languages. Adding one touches `Lang`, `DICTS`, `BCP`, `systemLang`, the script's `LANGS` and the `<select>` options in `app/src/main.ts:411-412` and `app/src/setup.ts:160`. (src: app/src/i18n.ts:7-10, 13-20, 40; app/scripts/check-i18n.mjs:14)
- Size at this commit: 558 keys in each table under 44 key prefixes. 115 Chinese strings contain placeholders, and 16 English strings use the plural form. (src: app/src/locales/zh.ts, en.ts, ja.ts, counted with grep)
- The check's parser expects each entry on its own line in the form `"key": "value",`, with the value a JSON string literal. (src: app/scripts/check-i18n.mjs:17)
- Hard-coded CJK text is not allowed in top-level `app/src/*.ts` code, apart from `中文`, `日本語` and `（往返）`. (src: app/scripts/check-i18n.mjs:43, 50-55)
- `monthLabel` and `fmtMonthDay` expect strings that start with `YYYY-MM` / `YYYY-MM-DD`. (src: app/src/i18n.ts:62-68)
- The Settings and wizard selects show the language names `中文`, `English` and `日本語` untranslated, and the Settings label is bilingual (`"Language / 语言"`), so users can find the switch in any language. (src: app/src/main.ts:411-412; app/src/setup.ts:160; app/src/locales/en.ts:62) (reason confirmed).

## 6. Non-goals
- Switching language without a page reload. (src: app/src/i18n.ts:36; comment: app/src/main.ts:451)
- Locales beyond zh / en / ja, regional variants (for example Traditional Chinese) and right-to-left scripts. (src: app/src/i18n.ts:7, 16-17) Confirmed (current scope): not planned now; adding a language is a normal contribution following §5.
- Translating data from TeslaMate, the API or the demo dataset, such as addresses, journey names or speed-band labels. Confirmed (current scope): data is shown as stored; only the server's built-in suggestion suffix and speed-band labels are localized by the app (`api-journeys` D-11).
- Locale-specific time zones: dates are shown in the device time zone, not chosen by language. (src: app/src/i18n.ts:55-58)

## 7. Current behavior vs. intended behavior
| ID | Current behavior (evidence) | Why it looks unintended | Presumed intended behavior |
|----|-----------------------------|-------------------------|----------------------------|
| CB-1 | `fmtMonthDay` reads the date differently per language. For zh and ja it slices `M/D` from the string's characters with no conversion. For en it formats `new Date(iso)` in the device time zone (src: app/src/i18n.ts:61-64). Callers pass UTC timestamps such as `start_date` and date-only strings such as the report's `daily[].date` (src: app/src/report.ts:28, 154-159). A drive at 07:00 JST on 20 Oct (`2026-10-19T22:00:00Z`) shows `10/19` in zh/ja but `Oct 20` in en. A date-only `2026-10-19` shows `Oct 18` in en on devices west of UTC. | The same record shows different days depending on the UI language. Likely unintended. | Show the local calendar day in every language: convert timestamps to device time, and use date-only strings as given. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor: the same record can show different days in en and zh/ja. |
| CB-2 | `setLang()` is exported, and its comment says "For tests / the language switch". Nothing calls it: the language switch saves and reloads, and the app has no frontend tests. (src: app/src/i18n.ts:38-39; app/src/main.ts:448-451; app/src/setup.ts:182-185) | Dead code with a misleading comment. Certain, no user impact. | Remove it, or keep it for future tests and fix the comment. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Cosmetic (dead code). |
