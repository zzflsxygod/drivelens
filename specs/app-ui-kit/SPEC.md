# app-ui-kit — Shared UI components, design tokens and map

> Reverse-engineered from `main` @ 9b1c39c (app v1.2.2, drivelens-api 0.14.0, API level 15).
> Sources: `app/src/ui.ts`, `app/src/sheets.ts`, `app/src/toolbar.ts`, `app/src/totop.ts`, `app/src/scrollbar.ts`,
> `app/src/icons.ts`, `app/src/palette.ts`, `app/src/map.ts`, `app/src/style.css`, `CHANGELOG.md`.
> In this document, "the system" means the DriveLens app's shared UI layer: the CSS design system, the components that
> upgrade plain screen markup (popovers, menus, select pills, segmented controls, back buttons), bottom sheets, motion,
> the back-to-top button, the overlay scrollbar, the icon set, and the `DriveMap` MapLibre wrapper.
> Reviewed against `main` @ 9b1c39c on 2026-10-26: every former `TO CONFIRM` mark is resolved as *Confirmed from code*, *Confirmed (owner decision)*, *Confirmed (current scope / design)* or **[OWNER DECISION NEEDED]**, and every CB row in section 7 ends with a **Review** verdict (see OVERVIEW §1).

## 1. Goal

Screens in DriveLens write plain HTML strings into the page. This module gives them one consistent look and behaviour
without a component framework: it defines the light and dark design tokens, upgrades standard markup into the app's
own controls, keeps menus and sheets usable on small screens and with on-screen keyboards, plays transitions, and
provides the map used by every screen that shows a location or a route.

## 2. Responsibility boundaries

### 2.1 In scope
- Design tokens, themes (light / dark), typography, layout chrome styling, breakpoints (`style.css`).
- Popover placement and tracking (`placePopover`, `trackPopover`) and popover menus (`popMenu`, `closeMenus`,
  `hasOpenMenu`).
- Automatic upgrade of screen markup (`enhance`): back buttons, pencil chips, icon buttons, `<select>` → pill,
  segmented controls.
- View transitions and staggered entry animations; reduced-motion handling.
- Bottom sheets (`.modal > .sheet`): accessibility attributes, keyboard-safe positioning, Esc, `focusField`.
- Back-to-top button and the month-jump reset hook.
- Overlay scrollbar for non-touch devices.
- Line icon set (`ic`) and toolbar icons (`ICON`).
- `cssVar` token reader.
- `DriveMap`: basemap, theme, label language, fallback, overlays (route, point, journey lines, stops), speed colouring,
  snapshot support; `effectiveTheme`.

### 2.2 Out of scope
- Which screen is shown, tabs, back stack, theme setting UI → `app-shell`.
- Content of sheets and menus (rename, cost, confirm, share, device menus) → the module that opens them
  (`app-records`, `app-journeys`, `app-connection`, `app-shell`).
- Map snapshot / cover image creation → `app-journeys` (relies on `preserveDrawingBuffer`, see UI-125).
- Platform detection (`html.touch`, `html.android`, `html.ime`, Android insets `--a-sa*`) → `app-platforms`.
- Stored settings (`theme`, `labelLang`) → `app-connection`; translations → `app-i18n`.
- Infinite-list month jump logic → `app-records` (`infinite.ts`), which registers hooks here.

### 2.3 Interfaces and dependencies
- **Depends on:**
  - `app-connection` — `loadSettings` (`theme`, `labelLang`), `defaultLabelLang` (map labels, theme).
  - `app-i18n` — `t` for map pin titles, fallback note and back-to-top labels.
  - `app-platforms` — the root classes `touch`, `ime` and the Android inset variables `--a-sat/--a-sar/--a-sab/--a-sal`.
  - External: `maplibre-gl` 6 (bundled), OpenFreeMap styles `https://tiles.openfreemap.org/styles/positron` and
    `/styles/dark`, OSM raster tiles `https://tile.openstreetmap.org/{z}/{x}/{y}.png`; browser `visualViewport`,
    `ResizeObserver`, `MutationObserver`, `matchMedia`.
- **Used by:**
  - `app-shell` — `initUI`, `initSheets`, `focusField`, `popMenu`, `closeMenus`, `initBackToTop`, `backToTop`,
    `isJumped`, `initOverlayScrollbar`, `ICON`, `ic`, `DriveMap`, `effectiveTheme`; `nav.ts` and `platform.ts` use
    `hasOpenMenu` / `closeMenus`.
  - `app-records` — `popMenu`, `closeMenus`, `ICON`, `ic`, `setJumpedPeek`, `setJumpedReset`, `DriveMap`.
  - `app-journeys` — `DriveMap`, `SPEED_STOPS`, `effectiveTheme`, `trackPopover`, `focusField`, `ICON`, `ic`.
  - `app-insights` — `DriveMap`, `ic`.
  - `app-connection` — `popMenu`, `focusField`, `ic` (devices, setup wizard).
  - `app-notifications` — `ic`.
- **Provided interface:**

  | Export | File | Purpose |
  |--------|------|---------|
  | `placePopover(el, anchor)`, `trackPopover(el, anchor, onGone?)` → `stop()` | `ui.ts` | Place / follow a fixed popover |
  | `popMenu(anchor, items, onPick, title?)`, `MenuItem`, `closeMenus()`, `hasOpenMenu()` | `ui.ts` | Popover menu |
  | `enhance(root)`, `initUI(view)` | `ui.ts` | Markup upgrade and motion |
  | `initSheets()`, `focusField(el, select?)` | `sheets.ts` | Bottom sheets |
  | `ICON` (`sort`, `select`, `check`, `car`, `chev`, `close`) | `toolbar.ts` | Toolbar SVGs |
  | `initBackToTop()`, `backToTop()`, `isJumped()`, `setJumpedPeek(fn)`, `setJumpedReset(fn)` | `totop.ts` | Back to top |
  | `initOverlayScrollbar()` | `scrollbar.ts` | Overlay scrollbar |
  | `ic(name, cls?)`, `IconName`, `noEmoji(s)` | `icons.ts` | Line icons |
  | `cssVar(name, fallback?)`, `isDarkUI()` | `palette.ts` | Token reader |
  | `DriveMap`, `Overlay`, `Stop`, `SPEED_STOPS`, `effectiveTheme()` | `map.ts` | Map |
  | CSS classes / variables: `.modal`, `.sheet`, `.card`, `.primary`, `.ghost`, `.tb-btn`, `.icon-btn`, `.pen`, `.seg`, `.seg-tabs`, `.page-head`, `.sk`, `--bg`, `--accent`, `--sat` … | `style.css` | Design system |
  | Root / body classes read: `touch`, `ime`, `kb-open` (set here), `sheet-open` (set here), `setup-mode`, `demo` | `style.css`, `sheets.ts` | State-dependent styling |

## 3. External behavior

### 3.1 Design tokens and themes
- **UI-001** When `<html data-theme="dark">` is set, the system SHALL use the dark token set (for example `--bg: #07080a`, `--accent: #00e5ff`) and `color-scheme: dark`; otherwise it SHALL use the light set (`--bg: #f3f4f7`, `--accent: #006a9e`, `color-scheme: light`). (src: app/src/style.css:7-49; doc: CHANGELOG.md v0.17.0)
- **UI-002** When the document language is Japanese, the system SHALL use a Japanese-first font stack. (src: app/src/style.css:50)
- **UI-003** When values are rendered with the value classes (`.num`, `.grid b`, `.kv b`, `.stats` and others listed in the stylesheet), the system SHALL render them in the monospace stack with tabular numerals. (src: app/src/style.css:69-73; doc: CHANGELOG.md v0.17.0)
- **UI-004** When an element receives keyboard focus, the system SHALL draw a 2 px accent outline; pointer focus SHALL NOT show an outline. (src: app/src/style.css:75-78)

### 3.2 Safe areas and layout chrome
- **UI-010** When the page is laid out, the system SHALL derive the insets `--sat`, `--sar`, `--sab`, `--sal` as the larger of the browser's `env(safe-area-inset-*)` and the Android bridge values `--a-sat`, `--a-sar`, `--a-sab`, `--a-sal`. (src: app/src/style.css:8-10; comment: app/src/style.css:8)
- **UI-011** When the page is shown, the status-bar zone (height `--sat`) SHALL be covered by a solid surface in the page background colour, also when the header is hidden. (src: app/src/style.css:95-97; doc: CHANGELOG.md v1.0.2)
- **UI-012** When the page is laid out, the header SHALL stick to the top with the top inset as extra padding; the bottom navigation SHALL float above the bottom inset (at most 560 px wide); the main content SHALL be at most 820 px wide with room for the navigation below it. (src: app/src/style.css:93-94, 123, 126-128)
- **UI-013** When `<html>` has class `ime` (Android keyboard open), the system SHALL hide the bottom navigation and the back-to-top button. (src: app/src/style.css:136)
- **UI-014** When `<html>` has class `touch`, the system SHALL enlarge touch targets: navigation buttons at least 50 px high, icon buttons at least 44 px, a 44 px hit area around pencil chips, and form fields at 16 px font size so iOS does not zoom on focus. (src: app/src/style.css:135, 212, 277-281; doc: CHANGELOG.md v1.0.1)
- **UI-015** When the viewport is at least 720 px wide, sheets SHALL be shown as centred dialogs with all corners rounded and maps SHALL be 420 px high (360 px otherwise; 200 px for `#map.small`). (src: app/src/style.css:354-355, 770-777)
- **UI-016** When a page header (`.page-head`) is present, it SHALL stick at `--hdr-h + 6px` from the top. (src: app/src/style.css:139)

### 3.3 Popover placement
- **UI-020** When a popover is placed next to an anchor, the system SHALL use fixed positioning and keep it inside the visual viewport minus the safe-area insets and an 8 px margin. (src: app/src/ui.ts:18, 39-46; comment: app/src/ui.ts:13-17)
- **UI-021** When the sticky header is above the anchor (or the bottom navigation is below it) and the anchor is not inside it, the system SHALL keep the popover clear of that bar by 4 px. (src: app/src/ui.ts:47-51)
- **UI-022** When the popover's natural height fits below the anchor, or there is at least as much space below as above, the system SHALL open it 8 px below the anchor; otherwise 8 px above. (src: app/src/ui.ts:63-65, 72)
- **UI-023** When the popover is taller than the available space, the system SHALL cap its height at the larger of the available space and 80 px (and at its CSS `max-height`) and let it scroll internally. (src: app/src/ui.ts:61-67, 74)
- **UI-024** When the anchor's centre is in the right half of the viewport, the system SHALL align the popover's right edge with the anchor's right edge; otherwise left edges; then clamp it horizontally, with a maximum width of the usable width (at least 120 px). (src: app/src/ui.ts:53, 69-71)
- **UI-025** When a popover is placed, the system SHALL set `data-side` to `below` or `above` and the transform origin to the anchor side. (src: app/src/ui.ts:74-76)
- **UI-026** When the popover's parent is transformed or backdrop-filtered, the system SHALL still place it at the computed viewport position. (src: app/src/ui.ts:54-59; comment: app/src/ui.ts:54-55)
- **UI-027** When a tracked popover's anchor moves (resize, orientation change, page scroll, visual-viewport change, size change), the system SHALL re-place it; scrolling inside the popover SHALL NOT re-place it. (src: app/src/ui.ts:80-96; doc: CHANGELOG.md v0.14.1)
- **UI-028** When a tracked popover or its anchor is removed or hidden, the system SHALL stop tracking; when the anchor scrolls out of the viewport, it SHALL stop tracking and call `onGone`. (src: app/src/ui.ts:86-88)

### 3.4 Popover menus
- **UI-030** When `popMenu` opens, the system SHALL append a `.tb-menu` element with `role="menu"`, an optional title line, and one button per item with the label, an optional second line (`sub`), and a check mark plus `aria-checked="true"` on the active item. (src: app/src/ui.ts:110-116)
- **UI-031** When a menu is open, its anchor SHALL have class `open` and `aria-expanded="true"`; when it closes, `open` SHALL be removed and `aria-expanded` set to `false`. (src: app/src/ui.ts:117-118)
- **UI-032** When the user picks an item, the system SHALL close the menu and then call `onPick` with the item's value. (src: app/src/ui.ts:123)
- **UI-033** When the user presses outside both the menu and the anchor, presses Escape, scrolls the anchor out of view, or `closeMenus()` is called, the system SHALL close the menu without calling `onPick`. (src: app/src/ui.ts:118-122, 128; comment: app/src/ui.ts:109)
- **UI-034** When a menu is opened while another is open, the system SHALL close the open one first; when the anchor of the open menu is tapped again, it SHALL only close it. (src: app/src/ui.ts:111)
- **UI-035** When a menu opens with an active item, the system SHALL scroll the menu so that item is centred, without scrolling the page. (src: app/src/ui.ts:124-125; comment: app/src/ui.ts:125)
- **UI-036** When asked, `hasOpenMenu()` SHALL report whether a menu is open. (src: app/src/ui.ts:129)

### 3.5 Markup upgrades
- **UI-040** When nodes are added to `#view`, or an element other than a menu is added directly to `<body>` (dialogs, setup wizard), the system SHALL upgrade the markup inside it once (`data-up`). (src: app/src/ui.ts:167-177, 261-262, 281-283)
- **UI-041** When a `button.back` is upgraded, the system SHALL turn it into a round chevron button with `aria-label` and `title` set to its text without a leading arrow, wrap it in a sticky `.page-head`, and, when the button has `data-title`, add a centred title. (src: app/src/ui.ts:131-147; doc: CHANGELOG.md v0.12.0)
- **UI-042** When a `.pen` element is upgraded, the system SHALL replace its content with a pencil icon and give it `role="button"`. (src: app/src/ui.ts:169)
- **UI-043** When an `.icon-btn` is upgraded, the system SHALL style it as a round toolbar button and replace the glyphs `⋯`, `📤` and `⟳` with the more, share and refresh icons. (src: app/src/ui.ts:170-174)
- **UI-044** When a `<select>` other than `#car` is upgraded, the system SHALL insert a pill button (`.sel-pill`, `aria-haspopup="menu"`, `aria-label` from the select's `aria-label` or its label text) showing the selected option's text, and SHALL hide the native select visually, remove it from the tab order and set `aria-hidden="true"`. (src: app/src/ui.ts:149-158, 175; src: app/src/style.css:191-200)
- **UI-045** When the user taps a select pill, the system SHALL open a popover menu of the select's options titled with the label; when a different option is picked, it SHALL set the select's value and dispatch bubbling `change` and `input` events. (src: app/src/ui.ts:159-162)
- **UI-046** When a select's value or disabled state changes (by `change` event, or programmatically right after rendering), the system SHALL update the pill on the next frame and again after 300 ms. (src: app/src/ui.ts:155-156, 163-164; comment: app/src/ui.ts:163)

### 3.6 Segmented controls
- **UI-050** When a `.seg-tabs` or `.seg` control is upgraded, the system SHALL add a thumb that sits under the `.on` item and follows class and size changes. (src: app/src/ui.ts:179-211; doc: CHANGELOG.md v0.12.0)
- **UI-051** When a `.seg-tabs` control is re-rendered with a different active item than before, the system SHALL start the thumb at the previous item and glide to the new one, unless reduced motion is requested. (src: app/src/ui.ts:198-207; comment: app/src/ui.ts:202)
- **UI-052** When the user switches a `.seg-tabs` item, the system SHALL scroll the page to the top, fade out the toolbar's right-side buttons, slide the new content in from the side of the chosen segment, and pop the new toolbar buttons in. (src: app/src/ui.ts:213-237, 266-271; comment: app/src/ui.ts:221, 227; doc: CHANGELOG.md v0.12.0)
- **UI-053** When the user switches the report's `#rp-seg` control, the system SHALL slide `#rp-daily` in from the chosen side. (src: app/src/ui.ts:212, 222-224)

### 3.7 Motion
- **UI-060** When `#view` content is replaced within 1.5 s after a click, the system SHALL play: "pop" (slide in from the left) after a page back button; "tab" (fade) after a navigation tab; "push" (slide in from the right) after a card or record row inside `#view`, except in select mode. (src: app/src/ui.ts:245-259, 272-276; src: app/src/style.css:744-749)
- **UI-061** When a push first renders only a loading placeholder, the system SHALL fade it in, so the push and the later real page count as one transition. (src: app/src/ui.ts:273-274; comment: app/src/ui.ts:273)
- **UI-062** When `#view` content is replaced within 1.6 s of the previous animation without a new click (skeleton → content), the system SHALL fade it in. (src: app/src/ui.ts:277; comment: app/src/ui.ts:277)
- **UI-063** When a view animation plays, the system SHALL fade up the top-level cards, panes and grid cells with a 35 ms step, for at most 11 elements, each element once. (src: app/src/ui.ts:295-302; src: app/src/style.css:750-751)
- **UI-064** When the click is on the report's month switcher (`.msw [data-m]`), the system SHALL NOT play a view animation. (src: app/src/ui.ts:253; comment: app/src/ui.ts:253)
- **UI-065** When a button or card is pressed, the system SHALL scale it to 0.95 (buttons) or 0.98 (cards). (src: app/src/style.css:737-743)
- **UI-066** When the user prefers reduced motion, the system SHALL skip all view, segment and stagger animations and disable all CSS animations and transitions. (src: app/src/ui.ts:239, 247, 287, 296; src: app/src/style.css:820-822; comment: app/src/ui.ts:4)

### 3.8 Bottom sheets
- **UI-070** When a `.modal` element is added to `<body>`, the system SHALL set `role="dialog"`, `aria-modal="true"` and `aria-labelledby` pointing to the sheet's `h3` (generating an id when missing). (src: app/src/sheets.ts:26-34, 42-43)
- **UI-071** When at least one sheet is open, `<body>` SHALL have class `sheet-open` and the page SHALL NOT scroll. (src: app/src/sheets.ts:44; src: app/src/style.css:276)
- **UI-072** When the visual viewport resizes or scrolls (for example when the on-screen keyboard opens), the system SHALL pin open sheets to the visual viewport (`--vv-top`, `--vv-h`) so they sit above the keyboard, and limit the sheet height to the visual viewport height minus 24 px and the top inset. (src: app/src/sheets.ts:12-17, 37-41; src: app/src/style.css:270-274; comment: app/src/sheets.ts:4-7; doc: CHANGELOG.md v1.0.1)
- **UI-073** When the window height exceeds the visual viewport height by more than 120 px, the system SHALL set class `kb-open` on `<html>` and drop the bottom safe-area padding of sheets. (src: app/src/sheets.ts:18-19; src: app/src/style.css:275)
- **UI-074** When the viewport changes while a field inside a sheet has focus, the system SHALL scroll that field into view. (src: app/src/sheets.ts:20-21)
- **UI-075** When the user presses Escape with a sheet open, the system SHALL activate the topmost sheet's `#cancel`, `#sh-close` or `[data-cancel]` control, or remove the sheet when it has none. (src: app/src/sheets.ts:46-54; doc: CHANGELOG.md v1.0.1)
- **UI-076** When `focusField` is called, the system SHALL focus the field without scrolling (plain focus when that option is unsupported) and optionally select its text. (src: app/src/sheets.ts:57-62; comment: app/src/sheets.ts:57-58)
- **UI-077** When a sheet opens, the system SHALL fade in the backdrop and slide the sheet up; below 720 px the sheet SHALL be anchored to the bottom with a grab handle. (src: app/src/style.css:263-266, 752-754, 773-775)

### 3.9 Back to top
- **UI-080** When the page is scrolled more than 1.5 viewport heights, or more than 0.5 when the current list is month-jumped, the system SHALL show the back-to-top button; otherwise it SHALL hide it, set `aria-hidden="true"` and remove it from the tab order. (src: app/src/totop.ts:16-26)
- **UI-081** When the current list is month-jumped, the button's title SHALL read "Back to latest", otherwise "Back to top". (src: app/src/totop.ts:18, 23; src: app/src/locales/en.ts:143-144)
- **UI-082** When back-to-top runs and the current list is month-jumped and its reset hook reports success, the system SHALL stop there (the list shows the newest records); otherwise it SHALL smooth-scroll to the top. (src: app/src/totop.ts:11-14; comment: app/src/totop.ts:5)
- **UI-083** When an `.actionbar` is on screen, the button SHALL move up above it. (src: app/src/style.css:452-457)

### 3.10 Overlay scrollbar
- **UI-090** When `<html>` does not have class `touch`, the system SHALL hide all native scrollbars and show a fixed overlay thumb for the page scroll instead. (src: app/src/scrollbar.ts:4-11; src: app/src/style.css:80-89; comment: app/src/scrollbar.ts:2-3; doc: CHANGELOG.md v0.12.0)
- **UI-091** When `<html>` has class `touch`, the system SHALL keep the native scrollbars and SHALL NOT create the overlay. (src: app/src/scrollbar.ts:5-6; src: app/src/style.css:89)
- **UI-092** When the overlay is painted, its thumb height SHALL be viewport height² / page height with a minimum of 36 px, and it SHALL be hidden when the page cannot scroll. (src: app/src/scrollbar.ts:13-24)
- **UI-093** When the page scrolls, the system SHALL show the thumb and hide it 1 s after the last scroll, unless the mouse is at the right edge or the thumb is being dragged. (src: app/src/scrollbar.ts:26-31)
- **UI-094** When a mouse pointer is within 18 px of the right edge, the system SHALL show the thumb wider and in the accent colour. (src: app/src/scrollbar.ts:35-39; src: app/src/style.css:87)
- **UI-095** When the user drags the thumb with the primary button, the system SHALL scroll the page in proportion to the drag. (src: app/src/scrollbar.ts:41-53)

### 3.11 Icons and tokens
- **UI-100** When `ic(name, cls)` is called, the system SHALL return an inline 24×24 SVG with class `ic`, `aria-hidden="true"` and `currentColor` strokes; an unknown name SHALL return the `info` icon. (src: app/src/icons.ts:48-51)
- **UI-101** When an icon is shown without an explicit size, it SHALL scale with the font size (1.15 em). (src: app/src/style.css:68; comment: app/src/icons.ts:3)
- **UI-102** When `cssVar(name, fallback)` is called, the system SHALL return the trimmed computed value of that custom property on `<html>`, or `fallback` when it is empty. (src: app/src/palette.ts:3-6)

### 3.12 Map (`DriveMap`)
- **UI-120** When a `DriveMap` is created, the system SHALL load the OpenFreeMap `positron` style for the light theme or `dark` for the dark theme. (src: app/src/map.ts:15, 73-77)
- **UI-121** When the style has loaded and no fallback is active, the system SHALL set every symbol layer whose `text-field` refers to `name` to the label language from settings (`labelLang`, else the app language): `ja` → `name:ja`, `name`; `zh` → `name:zh-Hans`, `name:zh`, `name:ja`, `name`; `en` → `name:en`, `name:latin`, `name`; `local` → `name`, `name:latin`. Line-placed labels SHALL stay horizontal and upright with a maximum angle of 30°. (src: app/src/map.ts:31-53, 85)
- **UI-122** When the style has not loaded after 12 s, or a map error occurs before the style has loaded, the system SHALL switch once to OSM raster tiles and show the note "Vector map failed to load; switched to the standard OSM map". (src: app/src/map.ts:17-23, 86-89, 94-102; src: app/src/locales/en.ts:145)
- **UI-123** When the overlay has a `point`, the map SHALL start centred on it at zoom 15; otherwise at [139.76, 35.68] zoom 10, then fit the bounds of the journey lines (or the route) with 40 px padding, maximum zoom 16 and no animation. (src: app/src/map.ts:81, 90, 119-126)
- **UI-124** When a map is created, the system SHALL add zoom buttons without a compass at the top right and a compact attribution. (src: app/src/map.ts:78, 84)
- **UI-125** When a map is created, the system SHALL keep the WebGL drawing buffer (`preserveDrawingBuffer: true`) so the map can be captured as an image. (src: app/src/map.ts:82; comment: app/src/journey2.ts:19)
- **UI-126** When the overlay has a `route` of at least two points, the system SHALL draw it as a line in the accent colour (`#006a9e` after a fallback) over a casing (white in light, `#07080a` in dark), with zoom-dependent widths. (src: app/src/map.ts:116-117, 128-138)
- **UI-127** When the overlay has journey `lines`, the system SHALL quantise each segment's speed to 5 km/h steps, merge consecutive segments with the same step, draw a continuous casing per drive underneath, and colour the line by `speedStops(speedColorMax())` when `speedColor` is set, otherwise in the plain accent colour. The stops are five colours (`#e5383b`, `#f48c3a`, `#f2c94c`, `#7bc96f`, `#12a150`) at 0 / 25% / 50% / 75% / 100% of the configured upper limit (80, 100, 120 or 140 km/h; default 120 → 0/30/60/90/120). (src: app/src/map.ts `speedStops` / `speedColorMax` / `speedExpr`, drawOverlay lines branch; comment: app/src/map.ts speed-colour merge)
- **UI-134** When `speedColorToolsHtml(on)` is used, the system SHALL render the shared "Color by speed" / "Single color" segment control and a legend whose gradient and "Fast (km/h 0–{max})" label use the current `speedColorMax`. `bindSpeedColorToggle` SHALL store `speedColor` and call `setSpeedColor` on the map. (src: app/src/map.ts `speedColorToolsHtml`, `bindSpeedColorToggle`)
- **UI-128** When the overlay sets `noPins`, the system SHALL draw thinner journey lines and no start / end pins. (src: app/src/map.ts:160-164, 169)
- **UI-129** When an overlay is drawn, the system SHALL place a green start pin and a red end pin at the first and last coordinate (unless `noPins`), a pin titled "Charging location" at `point`, and one marker per stop (charging stops red with a bolt icon), each with a title. (src: app/src/map.ts:166-181; src: app/src/style.css:362-366)
- **UI-130** When `setTheme()` is called or the operating-system scheme changes, the system SHALL swap to the style of the new effective theme and redraw labels and overlays; when a fallback is active or the theme is unchanged, it SHALL do nothing. (src: app/src/map.ts:69-71, 85, 91, 104-109)
- **UI-131** When `setSpeedColor(on)` is called, the system SHALL switch the journey line between speed colouring and the plain colour. (src: app/src/map.ts:112-115)
- **UI-132** When `destroy()` is called, the system SHALL remove the colour-scheme listener and the map. (src: app/src/map.ts:184)
- **UI-133** When `effectiveTheme()` is called, the system SHALL return the stored `theme` when it is `light` or `dark`, else the operating system's preference. (src: app/src/map.ts:25-29)

## 4. Key design decisions
- **D-1 Upgrade plain markup instead of using components.** Screens write ordinary HTML (`button.back`, `select`, `.pen`); `initUI` upgrades it through `MutationObserver`. (comment: app/src/ui.ts:2-3; src: app/package.json has no UI framework dependency)
- **D-2 One placement routine for all popovers.** Every menu is fixed, clamped to the usable viewport, aligned to the nearer edge, flipped by available space, and follows the anchor. (comment: app/src/ui.ts:13-17; doc: CHANGELOG.md v0.14.1)
- **D-3 Sheets follow the visual viewport.** iOS does not shrink the layout viewport for the keyboard, so sheets are pinned to `visualViewport`. (comment: app/src/sheets.ts:4-7; doc: CHANGELOG.md v1.0.1)
- **D-4 Overlay scrollbar on non-touch devices.** The native scrollbar took layout width on Windows. (comment: app/src/scrollbar.ts:2-3; doc: CHANGELOG.md v0.12.0)
- **D-5 Motion uses transform and opacity only and honours reduced motion.** (comment: app/src/ui.ts:4; src: app/src/style.css:736, 820-822)
- **D-6 Line icons instead of emoji.** (comment: app/src/icons.ts:2; doc: CHANGELOG.md v0.17.0)
- **D-7 Tokens live in CSS; non-CSS renderers read them.** Canvas, MapLibre and inline SVG read custom properties through `cssVar`. (comment: app/src/palette.ts:2; src: app/src/style.css:1-4)
- **D-8 Vector basemap with one raster fallback.** OpenFreeMap styles, falling back once to OSM raster when the style fails (network / CSP). (comment: app/src/map.ts:17, 86)
- **D-9 Speed colour as merged 5 km/h runs with no simplification.** The default simplification made routes look dashed when zoomed out. (comment: app/src/map.ts speed-colour merge)
- **D-13 Configurable speed-colour upper limit.** The five colour stops scale with `speedColorMax` (80/100/120/140 km/h) so ordinary-road speeds stand out when the limit is lowered; the app is km/h-only (no mph setting). (issue #19; src: app/src/map.ts `speedStops`)
- **D-10 Same-origin map worker.** The MapLibre worker is built as a same-origin asset so CSP `worker-src 'self'` is enough. (comment: app/src/map.ts:11-12)
- **D-11 System fonts for CJK map labels.** Crisper, and avoids odd glyphs from the server font. (comment: app/src/map.ts:79)
- **D-12 Native selects stay in the DOM.** The pill drives the hidden native `<select>` and re-dispatches its events, so screens keep using `select.value` and `change` handlers. Confirmed from code. (src: app/src/ui.ts:149-165)

## 5. Constraints
- Popover margins: 8 px gap to the anchor, 8 px to the viewport edge, minimum height 80 px, minimum width 120 px; CSS cap `min(60vh, 420px)`. (src: app/src/ui.ts:18, 53, 66; src: app/src/style.css:245)
- Motion windows: 1.5 s between click and render, 1.6 s for skeleton → content, stagger 35 ms × at most 11 elements. (src: app/src/ui.ts:266, 272, 277, 299)
- Keyboard detection threshold: 120 px. (src: app/src/sheets.ts:19)
- Back-to-top thresholds: 1.5 × / 0.5 × viewport height. (src: app/src/totop.ts:22)
- Overlay scrollbar: thumb ≥ 36 px, 18 px edge zone, 1 s hide delay. (src: app/src/scrollbar.ts:15, 29, 37)
- Map: 12 s style timeout; fit padding 40 px, max zoom 16; network access to `tiles.openfreemap.org` and `tile.openstreetmap.org` (allowed by the Tauri CSP `img-src`). (src: app/src/map.ts:15, 20, 87, 124; src: app/src-tauri/tauri.conf.json `security.csp`)
- Breakpoints: 360 px, 400 px, 720 px, 868 px. (src: app/src/style.css:554, 769-770, 814, 827)

## 6. Non-goals
- A component framework or virtual DOM. (src: app/package.json dependencies; comment: app/src/ui.ts:2-3)
- Replacing native scrollbars on touch devices. (comment: app/src/scrollbar.ts:5)
- Offline map tiles; maps need an internet connection. (src: app/src/locales/en.ts:208)
- Loading data for maps; callers pass coordinates in the overlay. (src: app/src/map.ts:55-58)
- Deciding which screen to show or managing the back stack (`app-shell`).

## 7. Current behavior vs. intended behavior
| ID | Current behavior (evidence) | Why it looks unintended | Presumed intended behavior |
|----|-----------------------------|-------------------------|----------------------------|
| CB-1 | `isDarkUI` (src: app/src/palette.ts:7), `noEmoji` (src: app/src/icons.ts:53) and `IconName` (src: app/src/icons.ts:47) are exported but not used anywhere in `app/src`. | Leftovers from the emoji-to-icon switch (doc: CHANGELOG.md v0.17.0) or earlier theme code. Likely. | Remove the unused exports. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Cosmetic (dead exports). |
| CB-2 | `popMenu` always renders items as `role="menuitemradio"` with `aria-checked` (src: app/src/ui.ts:115), also for action menus such as the device ⋯ menu (rename / disconnect) (src: app/src/devices.ts:187). | Screen readers announce action items as radio options that are all unchecked. Possible. | Action menus use `role="menuitem"` without `aria-checked`. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor accessibility issue. |
