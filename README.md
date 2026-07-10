# meso.utilities

[![CI](https://github.com/long-vo/meso.utilities/actions/workflows/ci.yml/badge.svg)](https://github.com/long-vo/meso.utilities/actions/workflows/ci.yml)

A tiny [Deno](https://deno.com/) web app with small, self-contained team utilities behind a common
master page (hub):

- **Sanitize JSON** (`/sanitize/`) — mask sensitive fields inside a JSON payload or log file,
  ported from the Slack `/sanitize-text` command.
- **Scrum Poker** (`/poker/`) — planning poker for team estimation: share a room code, everyone
  picks a card, reveal together.

**Live:** <https://long-vo.github.io/meso.utilities/> — the hub; masking runs entirely in your
browser.

The masking logic (`src/sanitize.mjs`) is lifted verbatim — semantics-wise — from
`slack-slash-app/src/commands/sanitizeText.js`, so a payload is masked here exactly the way the
Slack modal masked it. The browser and the server import the **same** module, so what you see in the
UI is what the API returns.

> Masking runs entirely in your browser. Your JSON is never uploaded — the `/api/sanitize` endpoint
> exists only for scripts and CI that want it.

## How masking works

- Any value whose **key** matches one of the field names is masked — at any depth, inside objects
  and arrays, case-insensitively.
- Masking reveals the last **N** characters and replaces the rest with `*`. Strings no longer than N
  are masked entirely (short secrets never leak).
- Strings and numbers are masked; booleans and `null` are left untouched.
- If a matched key's value is a container, every leaf inside it is masked.

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

## Run locally

Requires Deno 2.x.

```sh
deno task start      # http://localhost:8000
deno task dev        # same, with --watch auto-reload
```

Other tasks:

```sh
deno task test       # run the parity tests
deno task check      # type-check
deno task fmt        # format
deno task lint       # lint
```

Set `PORT` to change the port locally (e.g. `PORT=3000 deno task start`).

## API

```sh
curl -s http://localhost:8000/api/sanitize \
  -H 'content-type: application/json' \
  -d '{
    "json": { "user": { "email": "a@b.com" }, "token": "sk_live_abc123" },
    "fields": "email, token",
    "keepLast": 4
  }'
```

Request body:

| Field      | Type                | Notes                                              |
| ---------- | ------------------- | -------------------------------------------------- |
| `json`     | string \| object    | The payload to sanitize (raw JSON string or value) |
| `fields`   | string \| string\[] | Field names to mask (comma/space/newline or array) |
| `keepLast` | number \| string    | Trailing characters to keep visible (default `0`)  |

Response: `{ sanitized, pretty, fields, keepLast, stats }`, where `stats` is
`{ maskedValues, matchedKeys, fieldCount }`. Invalid JSON returns HTTP 400 with `{ error }`.

To mask JSON blocks inside a log, `POST /api/sanitize-log`:

```sh
curl -s http://localhost:8000/api/sanitize-log \
  -H 'content-type: application/json' \
  -d '{ "log": "INFO request={\"logonId\":\"L006344\",\"tenantId\":8334}", "keepLast": 0 }'
```

Body: `log` (string, required), `keepLast` (default `0`), `maskAll` (default `true`; set `false` and
pass `fields` to mask only those keys), `redact` (default `false`; when `true`, mask
UUIDs/IPs/emails/IBANs by shape anywhere). Response: `{ text, stats }` where `stats` is
`{ blocks, maskedValues, jsonBlocks, mapBlocks, fieldLines, patternHits }`.

`GET /health` returns a liveness JSON payload.

## Scrum Poker

Open `/poker/`, enter your name and either create a room or join with a teammate's 4–8 character
code (invite links look like `/poker/?room=QK7M`). Everyone picks a card from the classic deck
(0 ½ 1 2 3 5 8 13 20 40 100 ? ☕); votes stay hidden until someone hits **Reveal**, which locks the
round and shows the average, the vote distribution and a consensus banner. **New round** clears the
cards. Anyone can edit the shared story line, reveal or reset — no host role, no accounts. Empty
rooms evaporate after a few minutes. Every player can pick a **card theme** (ocean, violet, forest,
sunset, ruby) via the dots next to "Your card" — your deck and the card back other players see take
that colour, and the choice is remembered for the next session.

At the bottom sits a **random-name wheel** for picking who presents, breaks a tie or fetches the
coffee. It mirrors the people in the room until someone edits it — add guests or remove names via
the chips — after which it keeps the custom list. Spins are part of the room state, so everyone
watches the wheel land on the same name.

Live rooms need the Deno server: sockets connect to `/api/poker/ws?room=CODE&name=NAME` and rooms
live in memory, driven by the shared reducer in `src/poker.mjs`. On Deno Deploy, sockets for one
room may land on different isolates; a `BroadcastChannel` gossips per-isolate snapshots (participant
maps are disjoint, shared flags resolve last-writer-wins) so every isolate renders the full room.
On the static GitHub Pages build there is no server — the page detects this and falls back to a
single-person **solo mode** using the same reducer in the browser.

## Deploy to Deno Deploy

No build step. Point a Deno Deploy project at this repo with:

- **Entrypoint:** `main.ts`

The static assets and `src/sanitize.mjs` are read relative to the module URL, so they resolve the
same on Deploy as they do locally. Deno Deploy supplies the port automatically.

## Deploy to GitHub Pages

Because masking runs entirely client-side, the UI also works as a pure static site — no backend.
`.github/workflows/pages.yml` assembles `_site/` (the `static/` files plus `src/sanitize.mjs`) and
publishes it on every push to `main`.

One-time setup: in the repo, go to **Settings → Pages → Build and deployment → Source** and choose
**GitHub Actions**. The site then publishes to <https://long-vo.github.io/meso.utilities/>.

Not available on Pages (both need the Deno server): the `/api/sanitize` endpoints and live poker
rooms — the sanitizer is fully functional anyway, and the poker page falls back to solo mode.

## Layout

```
main.ts               Deno.serve entry: routes + JSON API + poker WebSocket
src/
  sanitize.mjs        shared masking logic (server + browser)
  sanitize.test.ts    parity tests
  poker.mjs           shared poker-room reducer (server + browser solo mode)
  poker-server.ts     poker rooms: WebSocket handling + isolate gossip
  poker.test.ts       poker reducer tests
static/
  index.html          hub / master page (lists all tools)
  styles.css          shared theme + hub + tool styles
  theme.js            shared dark/light toggle
  app.js              sanitizer UI logic (imports /sanitize.mjs)
  sanitize/
    index.html        Sanitize JSON UI
  poker/
    index.html        Scrum Poker UI
    poker.js          poker client (WebSocket + solo fallback)
```

Each tool lives in its own `static/<tool>/` folder and is linked from the hub; shared assets
(`styles.css`, `theme.js`) stay at the static root and are referenced with relative paths, so the
site works both on the Deno server and as a plain static build.

## Development

Trunk-based: `main` is always deployable and protected — no direct pushes, all changes go through a
PR with green CI. Branch with `feature/…`, `bugfix/…` or `chore/…`; commit messages use an
imperative title (e.g. `Add minify toggle`). Run `deno task check`, `deno task lint`,
`deno task fmt` and `deno task test` before opening a PR.

CI (`.github/workflows/ci.yml`) runs the format check, lint, type check and tests on every push to
`main` and every pull request.
