# meso.utilities

[![CI](https://github.com/long-vo/meso.utilities/actions/workflows/ci.yml/badge.svg)](https://github.com/long-vo/meso.utilities/actions/workflows/ci.yml)

A static hub of small, self-contained team utilities behind a common master page. No backend —
everything here runs entirely in your browser and deploys to GitHub Pages.

- **Sanitize JSON** (`/sanitize/`) — mask sensitive fields inside a JSON payload or log file, ported
  from the Slack `/sanitize-text` command. Runs fully client-side.
- **Decode Anything** (`/decode/`) — auto-detect and unwrap layered encodings (Base64, hex,
  URL-encoding, gzip/zlib, JWTs, PEM, `data:` URLs, escaped JSON) until something readable comes
  out. Runs fully client-side.
- **Leave Request** (`/leave/`) — fill one small form and get the two artifacts the team's leave
  process needs: the pre-formatted HR leave-request email (step 1) and the Outlook calendar event
  (step 2), with one-click hand-offs to your mail app and to Outlook. Runs fully client-side.
- **Team Availability** (`/availability/`) — drop the team's vacation workbook
  (`mesoneer-Vacation-<year>.xlsx`) and see who's out when: a people × days heatmap with month and
  quarter views, an out-today/this-week strip with a copyable standup summary, and per-team capacity
  numbers. CH-based colleagues can be tagged so Zürich public holidays apply. Runs fully
  client-side.
- **Shortlink** (`/shortlink/`) — give a URL a memorable name and open it via `/shortlink/#name`.
  Links can be organized into groups, live in your browser's `localStorage` (personal only) and can
  be exported to / imported from a local `shortlinks.json`. Runs fully client-side.
- **Text Transform** (`/transform/`) — 60+ text actions modelled on the IntelliJ String Manipulation
  plugin: switch case (camelCase ↔ snake_case ↔ kebab-case …), sort, align, grep, trim, dedupe,
  quote juggling and JSON ↔ YAML — applied in place with undo. Runs fully client-side.
- **Slidedown** (`/slidedown/`) — turn Markdown, HTML, AsciiDoc, PDFs and images into navigable
  presentation slides — drop files or paste/write them in a live editor — with speaker view, themes,
  PDF export and shareable content-in-URL links for text decks. A Vite/React app (in `slidedown/`)
  built in CI; runs fully client-side.
- **Scrum Poker** — planning poker for team estimation. Lives in its own repo,
  [meso.poker](https://github.com/long-vo/meso.poker), and is hosted on Render (it needs a server
  for live rooms); the hub links straight to it.

On the hub, the ☆ star at the top-right of each card marks a tool as a favourite, and the
**Favourites only** toggle narrows the grid to just those. The ⠿ grip beside the star drags a card
anywhere in the grid — mouse or touch — or, with the grip focused, the **arrow keys** move it a slot
(↑↓ by a whole row); **Reset order** appears in the toolbar once you've rearranged anything. Your
order and your favourites are remembered in your browser's `localStorage`. Every page also has a
command palette — press **Ctrl/⌘ K** to jump between tools or run the current page's main actions.

**Live:** <https://long-vo.github.io/meso.utilities/>

The masking logic (`static/sanitize.mjs`) is lifted verbatim — semantics-wise — from
`slack-slash-app/src/commands/sanitizeText.js`, so a payload is masked here exactly the way the
Slack modal masked it.

> Masking runs entirely in your browser. Your JSON is never uploaded anywhere.

## How masking works

- Any value whose **key** matches one of the field names is masked — at any depth, inside objects
  and arrays, case-insensitively.
- Masking reveals the last **N** characters and replaces the rest with `*`. Strings no longer than N
  are masked entirely (short secrets never leak).
- Strings and numbers are masked; booleans and `null` are left untouched.
- If a matched key's value is a container, every leaf inside it is masked.
- The **Diff** toggle shows the original next to the masked output, line by line — verify at a
  glance that everything sensitive was caught, and nothing else was changed.
- In JSON mode, **Suggested fields** scans the payload for keys that look sensitive — by name
  (`password`, `…Name`, `phone…`) or by value shape (emails, IBANs, JWTs, card numbers, tokens) —
  and offers anything missing from your mask list as a one-click chip.

## Log files

Switch to **Log file** mode to sanitize a whole log. Attach a `.log`/`.txt` file (or paste it) and
the tool masks the structured payloads it finds, in three forms:

- **JSON blocks** — `… request={"logonId":"L006344"}` → `… request={"logonId":"*******"}`.
- **Java `toString` object dumps** — `class Req { id: a08…; tenantId: f34… }` — each `field: value`
  is masked (structure openers and `null` are left alone).
- **Java maps** — `{application=baloise-id, client=172.31.138.81, …}` — each `key=value` is masked.

Timestamps, logger names and messages are preserved. Two toggles: **Mask all values** (default on;
turn off to mask only the field names you list) and **Redact IDs** (default off), which — when
enabled — additionally masks values by shape (UUIDs, IPv4 addresses, emails and IBANs) anywhere in
the log, even outside a structured block. It's opt-in because it will also mask loose identifiers in
plain log lines (e.g. `dossierId=<uuid>`), which you often want to keep for debugging.

## How decoding works

Decode Anything unwraps one layer at a time: each detector inspects the current value and, when it
matches, produces the next value for the chain (e.g. Base64 → gzip → formatted JSON), up to 12
layers. Detection is deliberately conservative — a Base64/hex decode is only accepted when the
result is readable UTF-8 or a recognised binary format (gzip, zlib, PDF, PNG, ZIP, DER, …), so plain
words, paths and IDs that merely look like an encoding are left alone. JWTs are decoded, their time
claims (`exp` / `nbf` / `iat`) are explained in human terms, and the signature can be verified in
place — paste the HMAC secret or the JWK/JWKS JSON into the token card (HS/RS/PS/ES families, via
WebCrypto). Everything runs in your browser; nothing is uploaded.

**Encode mode** flips the pipeline: type plain text and stack layers — Base64 (standard or
URL-safe), hex, URL percent-encoding, gzip+Base64, JSON escaping — in any order. Each click wraps
the current result in one more layer, mirroring how the decoder unwraps them, so building a test
payload is the same motion as reading one.

## How the leave request works

Leave Request turns one small form into the two artifacts the team's "How to Submit a Leave Request"
page mandates: the **HR leave-request email** (step 1) and the **Outlook calendar event** (step 2).
Nothing is sent — the buttons hand off to your own mail app and to Outlook on the web.

- **Leave types.** Annual, Sick and Core leave produce both artifacts. **Remote** and **WFH** aren't
  leave, so the HR-email step is hidden — along with the two fields that only feed it (**Reason**
  and **Cc**) — and only the calendar event remains. Core leave is full-day only; Annual and Sick
  leave (and Remote/WFH) can be taken as a **Morning** or **Afternoon** half day.
- **Dates.** A full day takes a **From/To** range for a multi-day period; a half day collapses to a
  single date tagged with the time of day. The start date opens on the next working day, and a
  summary line under the fields counts the days and warns about weekend endpoints.
- **HR email.** Addressed to `hr.vn@mesoneer.io`, with an optional **Cc** (one or more addresses,
  comma- or semicolon-separated); the subject and body (`Date off`, `Leave type`, `Reason`) are
  generated for you. The body is editable — tweak it and the hand-offs use your version, or hit
  **Reset** to return to the generated text. **Open in mail** uses a `mailto:` link to your default
  mail app; **Open in Outlook (web)** opens a pre-filled compose tab (a help note covers making
  Outlook your default mail app).
- **Calendar event.** Subject `[OFF] - Name` — the bracket follows the leave type (`OFF`,
  `Sick Leave`, `Core Leave`, `Remote`, `WFH`, prefixed with the half-day time) — sent to
  `mesoneer_vn@mesoneer.io` plus any optional PO/extra recipients (one or more, comma- or
  semicolon-separated). **Add to Outlook (web)** prefills the subject, dates, all-day flag and
  attendees; reminder chips flag what a URL can't set — the one manual step is to **uncheck "Request
  Response"**.
- **Saved recipients.** Addresses used in the Cc and PO/extra fields are remembered (in
  `localStorage`, shared by both) and offered as autocomplete — pick one to complete the address
  you're typing, ✕ a suggestion to forget it, or **Save recipients** to keep the current addresses
  without sending. They're auto-saved when you Open in mail / Add to Outlook.
- **Templates.** Save the reusable fields (everything except the dates) as a named preset — one
  click refills the form for the next request. Templates and your name persist in `localStorage`;
  the dates always start fresh.
- **Copying.** Every read-only value (To, Cc, both subjects, the recipients) is itself a button —
  click it to copy just that value; the toolbar buttons above each card still copy the same things.
- **Optional addresses.** A malformed address only blocks what it would break: a bad **Cc** disables
  the two email hand-offs (which would otherwise drop it silently) but leaves the copy buttons and
  the whole event step working, and a bad **PO/extra recipient** does the mirror image.

> Everything runs in your browser. Your details are never uploaded — the mail and calendar buttons
> just hand off to your own apps.

## How Team Availability works

Drop the team's vacation workbook (or paste one quarter sheet as CSV) and the tool rebuilds it as
one people × days model, entirely in your browser. Parsing is deliberately distrustful of the
sheet's own headers: dates derive from quarter + column position + the workbook year (the file's
date headers carry stale years), the trailing per-week aggregate columns and per-team summary rows
are ignored, and any cell that isn't a known day code
(`w e h v p m a c s sm sa r rm ra ch si cm
ca`) lands in a warnings panel — with its sheet and cell
reference — and counts as working, so dirty data never silently shrinks capacity. Rosters are
reconciled across quarters by name; the latest quarter's team label wins.

The heatmap draws one row per person and one column per day (month or quarter zoom), with weekends
hatched, today outlined and half-day codes as split cells. Above it, the out-today strip groups
who's off, on a half day, or remote/onsite right now — one click copies a plain-text summary for
standup or Slack. Below, the capacity table sums each team's available person-days per week (a half
day counts 0.5; remote and onsite count as working). People or whole teams can be tagged
**VN**/**CH**; CH-tagged people get the built-in canton Zürich holiday set overlaid on their working
days.

Everything (model, tags, filters) persists in this browser's `localStorage` and can be exported to /
imported from `availability.json` — either the full model, or (**Export view**, shown while a
team/name filter is active) just the visible slice with tags pruned to the included people, e.g. one
team's plan for its lead. **Share link** copies a URL that carries the same slice gzip-compressed in
the URL fragment — like Slidedown's and Shortlink's share links, the fragment is never sent to any
server, and opening it asks before merging into that browser's data. One caveat, stated on the
button too: the link _is_ the data, so anyone who obtains it can read those names and absences —
share it only where you'd share the roster itself. The `.xlsx` itself is read by a small values-only
zip/XML reader (`static/availability/xlsx.mjs`) — no third-party library.

> The workbook is parsed entirely in your browser. Names and absences are never uploaded.

## How Shortlink works

Define a name (lowercase letters, digits and hyphens — unique across all groups) for any http(s) URL
and `…/shortlink/#name` redirects to it. An optional **group** organizes the directory into
collapsible sections — a `/` in the group name nests (`Team/Frontend` sits indented under `Team`,
and collapsing a parent hides its sub-groups); a group disappears with its last link. Everything is
stored in this browser's `localStorage` only — a shortlink you share works for someone else only
after they **Import** your exported `shortlinks.json` (imported entries win on a name conflict).
Opening an unknown `#name` shows the directory with the name pre-filled instead of redirecting.
Pasting a target into the empty form auto-suggests a name from the URL (`jira.mesoneer.io/browse` →
`jira-browse`, deduped so it's free to take) until you type your own; if the same URL is already
saved under another name, the form says so rather than quietly creating a twin.

The directory has two views, toggled next to Export/Import and remembered per browser: **List**
(compact rows) and **Grid** — a speed-dial of tiles showing each target's favicon, with a colored
monogram standing in until the icon loads (or when the site has none). In both views, drag a link to
reorder it within its group (the order is stored per link and survives export/import); links you
haven't reordered sort alphabetically after the ordered ones. Dropping a link on another group's
links, empty space or header moves it into that group — at the drop position, or at the end for
headers (which also works on collapsed groups). **Edit** on a row/tile loads the link into the form
to change its name, target or group; a pencil on a group header renames the group inline (sub-groups
follow along). **New group** creates an empty group to organize into — explicitly created groups
persist while empty (unlike link-implied ones, which vanish with their last link) and carry a ✕ to
remove them again; they live in this browser only, since the export file carries links, not empty
groups. Tile and group colors are deterministic (hashed from the target hostname and the group
name), so the same site and group keep their colors on every visit. Favicons are requested from each
target's own origin (`https://<host>/favicon.ico`) — never a third-party icon service — so rendering
the grid only ever contacts sites you already have links to, and nothing else learns what you've
saved.

A **filter box** narrows the directory by name, target or group as you type (Escape clears; collapse
state and empty groups get out of the way while filtering), and every saved link is openable from
the **Ctrl/⌘ K palette** ("Open standup"). Redirects are counted locally and the five most-used
links appear in a **Frequently used** strip above the groups. Shortlinks can also be **dynamic**:
`#name/rest` appends `rest` to the target's URL, and a `{q}` placeholder in a target is replaced by
the (URL-encoded) rest — `q` → `https://google.com/search?q={q}` makes `#q/deno fmt` a search; the
create form previews that substitution live (`#q/foo → …?q=foo`) whenever the target holds a `{q}`.
**Share** copies a link that carries all your shortlinks in the URL fragment; opening it shows a
picker to choose which to import. A **Share group** button (⤴) on each group header shares just that
branch (`Team/Frontend` and its sub-groups) instead of everything.

Every **Import** — a shared link, a `shortlinks.json` or a browser bookmarks export — goes through
the same picker, so a merge never silently replaces links: candidates whose name you already have
are tagged **replaces**, and the import can be undone from the toast. **Import** also accepts a
browser bookmarks export (the `bookmarks.html` every browser's "Export bookmarks" produces — a page
can't read your Bookmarks bar directly): names are slugified from the titles (deduped with a
`-2`/`-3` suffix) and bookmark folders become groups — nested folders keep their full trail as a
sub-group path.

## How Text Transform works

One text area, one searchable action list — pick an action and it transforms the text in place
(select part of the text first to transform only the selection). **Undo/Redo** step through the
action history (also **Ctrl/⌘ Alt Z**), and every action is runnable from the **Ctrl/⌘ K** palette
too. The ☆ star next to each action pins it to the **Favourites** rail on the right (the same third
column Leave uses for templates) for one-click reuse — favourites persist in your browser's
`localStorage`, in the order you starred them. The actions, grouped as in the sidebar:

- **Switch case** — convert to camelCase, kebab-case (lower/UPPER), snake_case,
  SCREAMING_SNAKE_CASE, Capitalized_Snake_Case, dot.case, words lowercase, First word capitalized,
  Words Capitalized or PascalCase — or **cycle** through them: the current format is detected and
  the text moves to the next one. Plus capitalize words, lower/UPPER, invert case, and the Spring
  Boot env-variable form (`spring.main.log-startup-info` → `SPRING_MAIN_LOGSTARTUPINFO`).
  Conversions work per line, so a pasted list of identifiers converts in one go, indentation intact.
- **Case toggles** — two-way switches (snake_case / camelCase, kebab-case / snake_case, PascalCase /
  camelCase, …): already in the first format → converts to the second, anything else → the first.
- **Sort lines** — A-z / z-A (case-sensitive, by code point), A-Z / Z-A (case-insensitive _natural_
  order via `Intl.Collator`, so `a2` < `a10`), by line length, hexadecimally (by the first hex
  number on each line), reverse, shuffle, sort tokens within each line (delimiter from Options),
  hierarchical sort (indented children stay attached to their parent and are sorted recursively),
  shuffle characters, and JSON sort (object keys, recursive).
- **Align** — format delimited lines into padded columns (delimiter from Options; blank =
  whitespace), or align lines left / center / right against the longest line.
- **Filter / remove / trim** — grep, inverted grep and group-by-grep (matched lines first) take a
  pattern from Options — plain text or `/regex/flags`. Trim (both/leading/trailing), collapse
  whitespace runs, remove all spaces, remove duplicate lines / keep only duplicates, remove empty
  lines, collapse consecutive empty lines, remove all newlines.
- **Convert** — minify JSON, JSON → YAML, and YAML → JSON (the common YAML subset: block and flow
  mappings/sequences, quoted and plain scalars, comments; anchors, tags, multi-doc streams and block
  scalars report a clear error).
- **Quotes & other** — shift quotes `"` → `'` → `` ` `` → `"` (re-escaping the contents), swap
  double ↔ single quotes, educate (straight → curly) and straighten (curly → straight) quotes,
  reverse letters, swap word order, and switch path separators Windows ↔ UNIX.

Caret-bound IDE actions from the plugin (align carets, sort by subselection, multi-caret swaps,
"select all occurrences") have no equivalent in a plain text area and are intentionally left out.

> Every transform runs in your browser. Your text is never uploaded anywhere.

## Palette & handoff

Press **Ctrl/⌘ K** on any page (or the `⌘K` button in the top bar) to open the command palette: it
jumps to any tool and runs the current page's main actions — copy result, send request, switch mode,
toggle the theme, show/hide the controls sidebar — from the keyboard.

On every tool page the controls sidebar can be collapsed to give the editor and result the full
width — via the sidebar toggle in the top bar, the palette, or **Ctrl/⌘ B**. The choice is
remembered per tool (as is its drag-to-resize width).

Tools also chain into each other. The **Send to** buttons next to a tool's result hand the output to
another tool: decode a payload, send it to Sanitize to mask it. The handoff travels through
`sessionStorage` in your browser (same tab only, consumed on arrival, expires after 5 minutes) —
nothing is uploaded.

## Run locally

Requires Deno 2.x (used only as a dev toolchain — there is no server code).

```sh
deno task dev        # static file server on http://localhost:8000
```

Other tasks:

```sh
deno task test       # run the parity tests
deno task check      # type-check
deno task fmt        # format
deno task lint       # lint
```

`deno task dev` serves the hub only. Slidedown is a separate Vite/React app in `slidedown/` with its
own toolchain — run it from there (`cd slidedown && deno task dev`); see
[slidedown/README.md](slidedown/README.md).

## Deploy to GitHub Pages

`.github/workflows/pages.yml` publishes the site on every push to `main`: it copies `static/` into
`_site/`, then builds the Slidedown app (`slidedown/`) with Deno and assembles its output into
`_site/slidedown/`. The hub itself stays build-free — only the Slidedown sub-app is compiled.

One-time setup: in the repo, go to **Settings → Pages → Build and deployment → Source** and choose
**GitHub Actions**. The site then publishes to <https://long-vo.github.io/meso.utilities/>.

## Layout

```
src/
  sanitize.test.ts    parity tests (import the module from static/)
  decode.test.ts      decode-pipeline tests (import the module from static/decode/)
  handoff.test.ts     cross-tool handoff tests (import the module from static/)
  palette.test.ts     command-palette filtering tests (import the module from static/)
  diff.test.ts        diff-view line-pairing tests (import the module from static/)
  suggest.test.ts     sensitive-field suggestion tests (import the module from static/)
  encode.test.ts      encode-chain parity tests (roundtrip through decode.mjs)
  jwt.test.ts         JWT verification tests (import the module from static/decode/)
  curl.test.ts        curl-import tests (roundtrip through buildCurlCommand)
  leave.test.ts       leave-request builder tests (import the module from static/leave/)
  shortlink.test.ts   shortlink logic tests (import the module from static/shortlink/)
  transform.test.ts   text-transform tests (import the modules from static/transform/)
  reorder.test.ts     hub card-ordering tests (import the module from static/)
  xlsx.test.ts        minimal xlsx-reader tests (import the module from static/availability/)
  availability.test.ts  vacation-model + aggregation tests (from static/availability/)
  testdata/
    vacation-mini.xlsx  hand-built workbook fixture for the xlsx reader
static/
  index.html          hub / master page (lists all tools)
  styles.css          shared theme + hub + tool styles
  theme.js            shared dark/light toggle
  palette.js          shared command palette (Ctrl/⌘ K) overlay, on every page
  palette.mjs         palette filtering/ranking (imported by the browser and the tests)
  handoff.mjs         cross-tool "Send to" handoff (imported by the browser and the tests)
  hub.js              hub master-page interactions (share to Slack, favourite stars, card drag)
  reorder.mjs         hub card ordering logic (imported by the browser and the tests)
  sanitize.mjs        masking logic (imported by the browser and the tests)
  diff.mjs            line-pair diff for the sanitizer's Diff view (browser and tests)
  suggest.mjs         sensitive-field suggestions (browser and tests)
  app.js              sanitizer UI logic (imports ./sanitize.mjs)
  sanitize/
    index.html        Sanitize JSON UI
  decode/
    index.html        Decode Anything UI
    app.js            decode UI logic (imports ./decode.mjs)
    decode.mjs        detection + unwrap pipeline (imported by browser and tests)
    encode.mjs        encode-mode layer stacking (imported by browser and tests)
    jwt.mjs           JWT verification + time claims (imported by browser and tests)
  leave/
    index.html        Leave Request UI
    app.js            leave UI logic (imports ./leave.mjs)
    leave.mjs         HR-email + Outlook-event builder (imported by browser and tests)
  availability/
    index.html        Team Availability UI
    app.js            availability UI logic (imports ./availability.mjs + ./xlsx.mjs)
    availability.mjs  vacation-workbook model + aggregations (browser and tests)
    xlsx.mjs          minimal values-only .xlsx reader (browser and tests)
  shortlink/
    index.html        Shortlink UI
    app.js            shortlink UI logic (imports ./shortlink.mjs)
    shortlink.mjs     validation, grouping + export/import logic (browser and tests)
  transform/
    index.html        Text Transform UI
    app.js            transform UI logic (imports ./transform.mjs)
    transform.mjs     case/sort/align/filter/quote actions (browser and tests)
    yaml.mjs          minimal JSON ↔ YAML support (browser and tests)
slidedown/            Slidedown viewer (Vite/React/TS) — built into /slidedown/ at deploy time
```

Each no-build tool lives in its own `static/<tool>/` folder and is linked from the hub; shared
assets (`styles.css`, `theme.js`) stay at the static root and are referenced with relative paths. A
tool that needs a build step (like Slidedown) lives in its own top-level folder with its own
toolchain and is compiled into the site during deploy. Tools that need a server live in their own
repos (see [meso.poker](https://github.com/long-vo/meso.poker)) and are linked from the hub with an
↗ card.

## Development

Trunk-based: `main` is always deployable and protected — no direct pushes, all changes go through a
PR with green CI. Branch with `feature/…`, `bugfix/…` or `chore/…`; commit messages use an
imperative title (e.g. `Add minify toggle`). Run `deno task check`, `deno task lint`,
`deno task fmt` and `deno task test` before opening a PR.

A versioned pre-commit hook (`.githooks/pre-commit`) runs the hub's four Deno checks (format, type
check, lint, tests) on every commit. Enable it once per clone:

```sh
git config core.hooksPath .githooks
```

Formatting is verified with `--check` (the hook never rewrites files mid-commit); if it fails, run
`deno task fmt` and re-stage. Bypass a single commit with `git commit --no-verify`.

CI (`.github/workflows/ci.yml`) runs the format check, lint, type check and tests, and builds the
Slidedown app, on every push to `main` and every pull request.
