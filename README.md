# meso.utilities

[![CI](https://github.com/long-vo/meso.utilities/actions/workflows/ci.yml/badge.svg)](https://github.com/long-vo/meso.utilities/actions/workflows/ci.yml)

A static hub of small, self-contained team utilities behind a common master page. No backend —
everything here runs entirely in your browser and deploys to GitHub Pages.

- **Sanitize JSON** (`/sanitize/`) — mask sensitive fields inside a JSON payload or log file, ported
  from the Slack `/sanitize-text` command. Runs fully client-side.
- **Decode Anything** (`/decode/`) — auto-detect and unwrap layered encodings (Base64, hex,
  URL-encoding, gzip/zlib, JWTs, PEM, `data:` URLs, escaped JSON) until something readable comes
  out. Runs fully client-side.
- **Log Analysis** (`/loganalysis/`) — drop the log files off a ticket (zip and gzip bundles unpack
  on the way in), several at once and from different applications, and read them as one merged
  timeline. Records (a header plus its whole body, not one line each) are grouped by the business id
  they mention — dossier, case, request, thread or REST call — with every id in the log offered as a
  filter. A density strip brushes the timeline down to the minutes that matter, search highlights
  every hit, and REST calls fold into a single row carrying method, URL, status and duration, with
  never-answered calls flagged and a sortable table rolling them up per service. Grouping by
  **problem** folds four hundred ERROR rows into the handful of distinct failures they really are,
  each naming its root cause and the dossiers it touched; a pause that is out of character for its
  group is called out where it happened; and **± Context** brings back the neighbouring records a
  filter hid. Pin the records that tell the story and copy them as a Markdown ticket comment. Runs
  fully client-side; logs are never stored.
- **Leave Request** (`/leave/`) — fill one small form and get the two artifacts the team's leave
  process needs: the pre-formatted HR leave-request email (step 1) and the Outlook calendar event
  (step 2), with one-click hand-offs to your mail app and to Outlook. Runs fully client-side.
- **Team Availability** (`/availability/`) — drop the team's vacation workbook
  (`mesoneer-Vacation-<year>.xlsx`) and see who's out when: a people × days heatmap with month and
  quarter views, a who's-out strip for today or any day you pick — with a copyable standup summary —
  and per-team capacity numbers against each week's maximum. CH-based colleagues can be tagged so
  Zürich public holidays apply. Runs fully client-side.
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

New here? **Take a tour** in the hub toolbar walks through the tools one screen at a time — what
each one is for and what it actually does — with Back/Continue, the arrow keys, and a progress rail
you can click to jump. It never opens by itself: on a first visit it only offers a small nudge
beside the button, and the tour is in the **Ctrl/⌘ K** palette from every page.

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

- **JSON blocks** — `… request={"logonId":"L006344"}` → `… request={"logonId":"*******"}`. A block
  that was pretty-printed across several lines comes back pretty-printed, not collapsed onto one
  line — which also keeps the log's line count intact, so the Diff view keeps pairing line N with
  line N.
- **Java `toString` object dumps** — `class Req { id: a08…; tenantId: f34… }` — each `field: value`
  is masked (structure openers and `null` are left alone).
- **Java maps** — `{application=baloise-id, client=172.31.138.81, …}` — each `key=value` is masked.

Timestamps, logger names and messages are preserved. Two toggles: **Mask all values** (default on;
turn off to mask only the field names you list) and **Redact IDs** (default off), which — when
enabled — additionally masks values by shape (UUIDs, IPv4 addresses, emails and IBANs) anywhere in
the log, even outside a structured block. It's opt-in because it will also mask loose identifiers in
plain log lines (e.g. `dossierId=<uuid>`), which you often want to keep for debugging.

### Reading the result

A masked log is still a log — thousands of lines, with the handful you care about buried in the
middle. The result panel carries four reading aids, all of them **view-only**: Copy and Download
always hand over the whole masked log, no matter what is filtered out on screen.

- **Line numbers** down a gutter, so you can point someone at a line. The gutter is excluded from a
  copied selection.
- **Find** highlights every occurrence and steps through them with ↑/↓ (or Enter / Shift+Enter),
  showing `3 of 17`. Searching never hides a line — the context around a hit stays put.
- **Level chips** (ERROR, WARN, INFO, DEBUG, TRACE) filter by severity, and only appear for the
  levels the log actually uses. A line that declares no level inherits the one above it, so
  filtering to ERROR keeps the stack trace and the object dump under the error, not just its header.
- **Only changed** collapses to the lines masking altered, and **Wrap** soft-wraps long lines with a
  hanging indent instead of scrolling sideways.

With **Diff** on, the same numbering and filters apply to the before/after pairs.

Both change-flag features (Diff and Only changed) compare line N against line N. Masking preserves
the line count for ordinary logs, but a JSON block whose source packed several keys onto one line —
or held an inline array — is re-emitted expanded, and the pairing stops meaning anything. When that
happens the two controls are disabled with a note, rather than flagging most of the log as changed.
Line numbers, level filtering and Find are unaffected: they only read the masked text.

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

## How Log Analysis works

The unit is the **record**, not the line. An Axon Ivy log writes a header (timestamp, level, logger,
thread, MDC) followed by a body that runs until the next header — and the bodies hold the
interesting things: a `class …NotificationRequest { … }` dump, a JSON payload, a REST envelope.
Splitting on newlines turns one event into forty orphan lines, so everything works on records that
keep their body attached. **Spring Boot console logs** (the e-portal pod logs) parse as first-class
records too, in both shapes: the plain Boot pattern and the e-portal one carrying a
`[traceId][dossierId][userId]` MDC prefix and the application name. There the message rides on the
header line and only stack traces continue below; the MDC slots become labelled, filterable ids, so
a stack trace whose dossier slot is empty still joins the dossier its trace was serving. Files
parsed together are merged into one timeline by timestamp, each record tagged with the file and
application it came from. A log in some other format still parses: a leading timestamp opens a
record, and text with no timestamps at all is shown as-is rather than refused.

**Identifiers are matched by value, not by label.** One case id appears as `caseIds [5a3c…]`, as
`"ubiIdCaseId":"5a3c…"`, inside the URL `/baloiseid/cases/5a3c…/files.zip` and inside the filename
`front_5a3c….jpg`. Labelled occurrences teach the tool what an id is _called_; a bare-UUID sweep
finds it everywhere else; filtering matches the value, so none of those four are missed. Values that
are a run of `*` are skipped, so a sanitized log grows no mask-shaped filters.

**Cases are linked to their dossier.** A record carrying both `ubiIdCaseId: 8df4…` and
`extCaseId: 5dad…` teaches that the case belongs to that dossier, so records naming only the case
join the dossier's group — which is what makes several application logs read as one flow. Only
records naming exactly one dossier teach a link, and the linking follows a narrow label allow-list:
`extPersonId` and `documentId` are excluded, because linking on those merges unrelated dossiers into
one useless group. The **Link cases to dossier** switch turns it off.

**Grouping** is a switch, not a reload: by dossier (the default), by problem (below), by request —
Ivy's per-app `requestId`, or a Spring `traceId`, which being globally unique joins one request
across pods — by thread — which shows what ran concurrently — by REST call, or flat. Records
matching no key collect in a trailing **Unattributed** group rather than disappearing.

**Four hundred ERROR records are rarely four hundred problems.** Grouping by **problem** folds them
into the handful of distinct failures they actually are. A JVM stack trace is parsed for its type,
its `Caused by:` chain and the first frame outside the framework packages — so a row reads
`SigningException: could not sign ← SQLException: connection reset by peer` instead of the opening
line of sixty stack frames. Clusters key on the **root cause**, because the same connection reset
under two different wrappers is one problem and the wrapper only names the layer that noticed. The
message is normalised first — UUIDs, timestamps, long hex and long digit runs become placeholders —
timidly on purpose: `500` stays a `500`, since a normaliser that merged it with `404` would hide two
different problems as one with no way to notice. Each cluster carries how often it happened, when it
started and stopped, and **which dossiers it touched** — the "how far did this spread" answer no
per-record view can give. A **problems** tile on the overview strip switches to the grouping.

**Where the time went.** Rows show their offset from the group's start, but the fact worth having is
usually that three of those four minutes passed between two adjacent records. A pause is called out
— on its own row between the two records it separates, plus a badge on the group header — when it is
both **5× the group's own median gap and at least a second**. Both conditions carry weight: the
multiple alone flags every row in a steady-cadence group, and the floor alone flags a 3 ms pause
between records logged microseconds apart.

**Getting back what a filter hid.** Narrowing to one dossier at ERROR is what makes a merged log
readable, and it is also what hides the four DEBUG records just before the failure that say why it
failed. **± Context** on any record pulls its neighbours out of the unfiltered merge and into the
group's own row list — 5 either side, widening to 10 and 20 — dimmed and tagged, since some of them
belong to other dossiers. `grep -C` for the timeline, without losing your place.

**REST calls fold.** The four records of a call — `Invoking REST service …`, `>> POST …`,
`… successful executed in 342 [ms]. Response status was 200`, `<< 200 …` — collapse into one row
carrying service, method, URL, status and duration (`1 [s]` normalised to 1000 ms). Pairing is per
file _and_ thread, because the same URL is called concurrently on several threads. An invocation
with no completion is flagged **no response**, which is the trace a hung integration leaves.
Filters: non-2xx or unanswered only, and slower than _N_ ms.

A **REST calls** view beside the timeline lists every call as a sortable table, over a per-service
rollup: calls, failed, unanswered, p50, p95 and slowest. `failed` and `unanswered` stay separate
counts — a 500 answered and said it broke, a hung call said nothing, and they send you looking in
different places — and a call with no readable duration is kept out of the percentiles rather than
folded in as 0 ms, which would report a hung integration as the fastest thing in the log.
Percentiles are nearest-rank, so every figure names a call you can find in the table under it. Pick
any call to take its records back to the timeline as a removable filter.

**Reading and reporting.** A density strip above the timeline shows where records — and errors —
cluster; drag across it (or click one slice) to filter the view to a window, shown as a removable
pill like every other filter. Search takes several terms (all must match; quote a phrase to keep it
whole), highlights every hit in rows and expanded records, and `n`/`p` hop between matching records.
Pin the records that carry the story and **Copy pinned** emits them as a Markdown ticket comment —
headers with file, timestamp and level, bodies fenced verbatim. Pins key on a file and a line rather
than a position in the merge, so dropping in the next log off the ticket no longer throws away the
set you were collecting; only removing the file a pin lives in drops it. Either copy button has a
download beside it, because a merged timeline runs to more records than the clipboard is a sensible
way to move. An MDC value the identifier index recognises is a filter chip like any other, so
`requestId=5511520` in an expanded record is one click from narrowing the view. A record's payloads
can also be handed straight to Decode Anything. For merges that mix clocks — Ivy logs local time,
the pods UTC — each file gets a whole-hour clock shift that realigns ordering and deltas while every
displayed timestamp stays exactly as logged. Zip and gzip bundles unpack on drop, keeping only
`.log`/`.txt`/`.out` entries.

Logs live in memory for the session only — nothing is written to `localStorage`, and nothing is
uploaded.

## How the leave request works

Leave Request turns one small form into the two artifacts the team's "How to Submit a Leave Request"
page mandates: the **HR leave-request email** (step 1) and the **Outlook calendar event** (step 2).
Nothing is sent — the buttons hand off to your own mail app and to Outlook on the web.

- **Leave types.** Annual, Sick, Core and Social leave produce both artifacts. **Remote** and
  **WFH** aren't leave, so the HR-email step is hidden — along with the two fields that only feed it
  (**Reason** and **Cc**) — and only the calendar event remains. Core and Social leave are full-day
  only; Annual and Sick leave (and Remote/WFH) can be taken as a **Morning** or **Afternoon** half
  day.
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
  `mesoneer_vn@mesoneer.io` plus any optional Extra recipients (one or more, comma- or
  semicolon-separated). An optional **Note** becomes the event's **description** — all of it; leave
  the Note empty and the event has no description. It is never the **Reason**, since everyone
  invited can read the event, which is why the two are separate fields (the Note stays on screen for
  Remote/WFH, where Reason is hidden). **Add to Outlook (web)** prefills the subject, the Note,
  dates, all-day flag, attendees and turns off **Request Response**; reminder chips list what the
  event will carry, and **Status = Free** — the one thing no URL can set — is worth a glance before
  you send.
- **Copy as prompt.** Copies the whole request — the HR email and the calendar event, each with its
  recipients, plus the event settings — behind a short instruction, to paste into an AI assistant.
  One with a mail/calendar connector can then check it over and, once you confirm, send and create
  both. Remote and WFH have no HR email, so their prompt is the event alone.
- **Save to Availability.** Records the request on your row in Team Availability's grid: Annual
  leave writes `p` (`m`/`a` for a half day), Sick `s`/`sm`/`sa`, Core `c`, and Remote/WFH
  `r`/`rm`/`ra`. Nothing is written from here — the change is parked in `localStorage` and applied
  the next time Team Availability opens, in any tab, however long the detour takes. It reports what
  it could not do rather than guessing: weekends inside the range and days outside the imported
  workbook are skipped, and a name the roster doesn't know is named back to you instead of adding a
  row. What lands is logged in Team Availability's **Recorded changes** panel.
- **Saved recipients.** Addresses used in the Cc and Extra recipients fields are remembered (in
  `localStorage`, shared by both) and offered as autocomplete — pick one to complete the address
  you're typing, ✕ a suggestion to forget it, or **Save recipients** to keep the current addresses
  without sending. They're auto-saved when you Open in mail / Add to Outlook.
- **Templates.** Save the reusable fields (everything except the dates — including the event
  **Note**) as a named preset — one click refills the form for the next request. Templates and your
  name persist in `localStorage`; the dates always start fresh, so an applied preset never replays
  stale dates — which is also why the Note is a plain form field rather than an editable copy of the
  event text: there are no dates baked into it to go stale.
- **Copying.** Every read-only value (To, Cc, both subjects, the recipients, the event description)
  is itself a button — click it to copy just that value; the toolbar buttons above each card still
  copy the same things.
- **Optional addresses.** A malformed address only blocks what it would break: a bad **Cc** disables
  the two email hand-offs (which would otherwise drop it silently) but leaves the copy buttons and
  the whole event step working, and a bad **Extra recipient** does the mirror image.

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

The heatmap draws one row per person and one column per day (month or quarter zoom) under a sticky
month/day header, with weekends hatched, today outlined, half-day codes as split cells and a rule
between teams. It's a real ARIA grid: **Tab** enters it once, the **arrow keys** move between cells
(**Page Up/Down** by ten rows, **Ctrl + Home/End** to the corners), and **Enter** on a day header
reports on that day. Each cell announces the person, the date and the reason — naming the holiday
(`Tet Holiday`, `Bundesfeier`) where the built-in sets know it. Hovering lights up the cell's whole
row and column, so reading across ninety-odd columns doesn't mean tracking one with a finger. Above
it, the strip groups who's off, on a half day, or remote/onsite — for today by default, or for **any
day** you pick from the date field, a heatmap day header or the week index; one click copies a
plain-text summary for standup or Slack. A weekend says so instead of reporting "nobody out", and a
public holiday collapses to a single chip rather than listing the whole roster. The week section
keeps its per-person chips and adds a per-day count line (`27.07 · 8   28.07 · 11`) to scan first.
Below, the capacity table shows each team's available person-days per week **over the week's
theoretical maximum** (a half day counts 0.5; remote and onsite count as working), labels a month's
part weeks by their first visible day, and prints `–` rather than `0` for a week nothing was
imported for. It also draws the conclusion those numbers only imply: any team-week whose available
person-days fall under a **threshold you set** (default 60% of that week's maximum; slide to 0 to
switch it off) is marked in the table, and a line above it counts them and names the thinnest first.
People or whole teams can be tagged **VN**/**CH**; CH-tagged people get the built-in canton Zürich
holiday set overlaid on their working days.

Clicking a name in the grid (or ⌘K → **Person year summary**) opens that person's whole imported
axis, whatever month the heatmap is showing: their days by kind, a bar per month scaled against
their heaviest one, and every absence as a grouped date range — a Friday-to-Monday run reads as one
two-day absence, not four. Two counts live side by side on purpose: the chips count what each code
_describes_, so WFH earns "8 days" of its own, while the line above them counts availability, where
WFH costs nothing. Another person can be picked from the dialog itself, and the absence list is
narrowed by a tick box per **leave type** — only the types that person actually has, so no box leads
anywhere empty. **WFH and public holidays start unticked**: neither is a day someone chose to take
off, and left in, the two of them bury the ones that are. Both still count in the chips and the
month bars, which are the whole person by design.

Under it, **Leave balances** shows the year's leave accounting per person, read from the workbook's
`General` sheet: the days it **records** — working days, the balance carried over from the previous
year, the year's annual allowance, planned days and day-offs taken — beside what is **remaining** of
the annual, core and sick allowances. The two groups share one header because the sheet's own
arithmetic ties them together (`Annual remaining = carried over + allowance − planned − taken`), and
`Annual` heads a column in each — which is why the group captions above them are not decoration.

The block is located by its own `Annual leave | Core leave | Sick Leave` / `remain` header rather
than by position, and each recorded column by its own heading, so a column that moves between
workbook years costs only itself. The carry-over column is headed by the bare previous year (`2025`
in the 2026 workbook), which is why it's matched as a year and not as a word. Rows join the roster
by name; a balance row matching nobody lands in the warnings panel instead of inventing a person.

The table follows the team/name filter and its sort, so it reads as the heatmap's own roster, and it
totals the visible rows. Two distinctions it keeps: a **negative** number is marked — that allowance
is overdrawn, not a rendering fault — and a blank cell prints `–` rather than `0`, because "nothing
recorded yet" is not "nothing left". These numbers are the whole year's, unlike everything else on
the page, which is why the table has no week columns. The panel is hidden entirely when nothing
carried a balance, e.g. after importing only a quarter `.csv`.

Requests saved in Leave Request land back on the person's row the next time this tool opens (see
**Save to Availability**), so the round trip closes: pick days here, file the request there, see it
here. Each applied request is logged under **Recorded changes**, the panel beneath the legend — who,
which days, what was written and how many days took it, plus the tool that asked and when — so a
code you didn't expect on your row has an explanation instead of a mystery. The last 20 are kept,
alongside the rest of the data in `localStorage`.

The panel is the master copy of what this tool wrote, so it says when the grid stops agreeing with
it. Importing a workbook that predates a request writes over the days it added; the record then
reads **⚠ no longer on the grid** (or `2 of 3 days` when only part of it went), the panel heads the
list with a count, and the record is yours to re-file or delete. The check is live against the
current grid, so re-filing the request clears its warning on its own.

Deleting a single record (the × beside it) also undoes it: those days go back to exactly what they
held before — the previous code, not a blanket "working" — and the toast offers **Undo**. A day that
moved on since, because a later request overwrote it, is left at its newer value and counted in the
toast rather than silently rolled back. **Clear history** is the other half of that pair: it forgets
the whole log without touching a single day — and offers **Undo** too, since the records are the
only account of what wrote those days. (Both Undos live in the toast, so a later message replaces
them; act on it while it's up.)

Days picked in the grid go to the Leave Request tool. Drag along one person's row (or press
**Enter** on a cell, **Shift + Enter** to extend the run, **Esc** to drop it). **Send to Leave** is
only offered for a pick that holds a day someone could actually take off: a run that is entirely
weekend, entirely public holiday, or both leaves the button disabled and says which
(`weekend only — nothing to request`), because there is no day to request and marking a holiday
would spend a leave day on a day nobody works. The pick still paints, so you can see what you
grabbed and adjust it. A mixed run is fine — Friday to Monday is the normal case, and the weekend in
the middle is simply skipped. Days already marked as leave stay requestable: filing the HR request
for days blocked on the grid is what the button is for. The ⌘K command refuses the same picks the
disabled button does.

Month navigation isn't clamped to the imported range, so you can step into a month the workbook
never covered — its cells are blank but still pickable, and their tooltip says
`outside the imported range` rather than `no data`, which is the other reason a cell can be empty.
Those days are **still requestable**: the dates are real, and HR doesn't care where your local copy
of the workbook stops. What they can't do is take a mark, so the pick's label counts them
(`· 3 outside the imported range`) and the dialog's mark checkbox tells you what will actually
happen — how many days will be written, or, when none of them can be, the checkbox is disabled
outright. That matters because the mark runs immediately before the tab navigates to Leave Request,
so a tick that would do nothing has no way to report back; the only honest place to say so is before
you tick it.

**Send to Leave** opens a dialog prefilled with the name, the dates and the leave type the picked
day code implies — `v`/`p` annual, `c` core, `s` sick, `r` WFH; a half-day code picked on its own
arrives as that half day. Adjust any field before sending. **Also mark these days on the heatmap —
and book them against the leave balance** is ticked by default: a request filed from the grid is
nearly always meant to show on it, so the matching day code is written straight away (recorded in
the change history, so it's undoable). Untick it to leave the grid alone until the request comes
back from Leave's own "save to grid". It starts unticked, and disabled, when there is nothing on the
grid to write — every picked day being a weekend or outside the imported range.

Days written onto the grid — by that checkbox or by a request coming back from Leave — move the
person's leave balance with them, so the grid and the balances panel never describe the same absence
differently. A day booked as annual leave comes off `Working`, goes onto `Day offs` and comes off
what's `Annual` remaining; planned vacation books to `Planned` instead; core and sick come off their
own remainders; remote and WFH are still worked days, so they move nothing. Half-day codes move half
a day, and the sheet's own arithmetic
(`Annual remaining = carried over + allowance − planned − taken`) holds after every change. Two
things it deliberately won't do: a field the workbook never recorded stays blank rather than being
invented from zero, and a person with no balance row is left alone. Undo gives back exactly what was
booked — and only for the days actually restored, so a day a later request moved on keeps the
booking that request gave it.

Everything (model, tags, filters) persists in this browser's `localStorage` and can be exported to /
imported from `availability.json` — either the full model, or (**Export view**, shown while a
team/name filter is active) just the visible slice with tags pruned to the included people, e.g. one
team's plan for its lead. The drop zone takes whichever of the three you give it (`.xlsx`, a quarter
`.csv`, an `availability.json` export) and routes it. A workbook covers the whole year, so it
_replaces_ what's loaded and asks first; every partial payload — CSV quarter, JSON export, share
link — _merges_ by name, so importing one team's slice never drops the rest of the roster. **Share
link** copies a URL that carries the same slice gzip-compressed in the URL fragment — like
Slidedown's and Shortlink's share links, the fragment is never sent to any server, and opening it
asks before merging into that browser's data — unless the link also carries `?auto=1`, which takes
the payload straight away (what `scripts/availability-share-url.ts --auto` emits for an unattended
refresh, since nobody is there to click Replace). One caveat, stated on the button too: the link
_is_ the data, so anyone who obtains it can read those names and absences — share it only where
you'd share the roster itself. The `.xlsx` itself is read by a small values-only zip/XML reader
(`static/availability/xlsx.mjs`) — no third-party library.

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
(compact rows) and **Grid** — a speed-dial of compact row-tiles, each showing the link's name over
the target's host beside the site's favicon, with a colored monogram standing in until the icon
loads (or when the site has none). Hovering a tile floats its copy/edit/delete buttons above it, so
even a long name stays readable. In both views, drag a link to reorder it within its group (the
order is stored per link and survives export/import); links you haven't reordered sort
alphabetically after the ordered ones. Dropping a link on another group's links, empty space or
header moves it into that group — at the drop position, or at the end for headers (which also works
on collapsed groups). **Edit** on a row/tile loads the link into the form to change its name, target
or group; a pencil on a group header renames the group inline (sub-groups follow along). **New
group** creates an empty group to organize into — explicitly created groups persist while empty
(unlike link-implied ones, which vanish with their last link) and carry a ✕ to remove them again;
they live in this browser only, since the export file carries links, not empty groups. Tile and
sub-group label colors are deterministic (hashed from the target hostname and the group name), so
the same site and group keep their colors on every visit. Favicons are requested from each target's
own origin (`https://<host>/favicon.ico`) — never a third-party icon service — so rendering the grid
only ever contacts sites you already have links to, and nothing else learns what you've saved. Load
outcomes are remembered per browser (successes for a week, failures for a day), so re-renders show
known icons at once and hosts without one aren't retried on every render.

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
toggle the theme, show/hide the side panels — from the keyboard.

On every tool page the controls sidebar can be collapsed to give the editor and result the full
width — via the sidebar toggle in the top bar, the palette, or **Ctrl/⌘ B**. The tools with a
right-hand rail (Leave's templates, Shortlink's filter and speed-dial, Text Transform's favourites,
Team Availability's legend) have a second toggle beside it for that rail — **Ctrl/⌘ Shift B**. Both
choices are remembered per tool, independently (as is the sidebar's drag-to-resize width).

Tools also chain into each other. The **Send to** buttons next to a tool's result hand the output to
another tool: decode a payload, send it to Sanitize to mask it; mask a log file in Sanitize, send it
to Log Analysis to group and filter it; pick someone's days in Team Availability's heatmap, send
them to Leave Request. The handoff travels through `sessionStorage` in your browser (same tab only,
consumed on arrival, expires after 5 minutes) — nothing is uploaded.

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
  logview.test.ts     log-view numbering/level/search tests (import the module from static/)
  loganalysis.test.ts log parsing/id-extraction/grouping tests (from static/loganalysis/)
  problems.test.ts    throwable-parsing and error-clustering tests (from static/loganalysis/)
  suggest.test.ts     sensitive-field suggestion tests (import the module from static/)
  encode.test.ts      encode-chain parity tests (roundtrip through decode.mjs)
  jwt.test.ts         JWT verification tests (import the module from static/decode/)
  curl.test.ts        curl-import tests (roundtrip through buildCurlCommand)
  leave.test.ts       leave-request builder tests (import the module from static/leave/)
  shortlink.test.ts   shortlink logic tests (import the module from static/shortlink/)
  transform.test.ts   text-transform tests (import the modules from static/transform/)
  reorder.test.ts     hub card-ordering tests (import the module from static/)
  tour.test.ts        guided-tour content/step tests (also reads static/index.html)
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
  tour.js             the hub's guided tour: dialog, rendering, keyboard
  tour.mjs            tour content + step logic (imported by the browser and the tests)
  sanitize.mjs        masking logic (imported by the browser and the tests)
  diff.mjs            line-pair diff for the sanitizer's Diff view (browser and tests)
  logview.mjs         masked-log reading aids: numbering, levels, search (browser and tests)
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
  loganalysis/
    index.html        Log Analysis UI
    app.js            timeline UI logic (imports ./loganalysis.mjs)
    loganalysis.mjs   record parsing, id index, REST spans, grouping (browser and tests)
    problems.mjs      throwable parsing, message normalising, error clustering
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
