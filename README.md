# meso.utilities

[![CI](https://github.com/long-vo/meso.utilities/actions/workflows/ci.yml/badge.svg)](https://github.com/long-vo/meso.utilities/actions/workflows/ci.yml)

A static hub of small, self-contained team utilities behind a common master page. No backend —
everything here runs entirely in your browser and deploys to GitHub Pages.

- **Sanitize JSON** (`/sanitize/`) — mask sensitive fields inside a JSON payload or log file, ported
  from the Slack `/sanitize-text` command. Runs fully client-side.
- **Decode Anything** (`/decode/`) — auto-detect and unwrap layered encodings (Base64, hex,
  URL-encoding, gzip/zlib, JWTs, PEM, `data:` URLs, escaped JSON) until something readable comes
  out. Runs fully client-side.
- **REST Client** (`/rest/`) — compose and send REST requests (method, headers, auth, body), inspect
  status/headers/body, copy any request as curl, with a local request history. Runs fully
  client-side; the target API must allow CORS.
- **Slidedown** (`/slidedown/`) — turn Markdown files, PDFs and images into navigable presentation
  slides, with speaker view, themes and PDF export. A Vite/React app (in `slidedown/`) built in CI;
  runs fully client-side.
- **Scrum Poker** — planning poker for team estimation. Lives in its own repo,
  [meso.poker](https://github.com/long-vo/meso.poker), and is hosted on Render (it needs a server
  for live rooms); the hub links straight to it.

On the hub, the ☆ star at the top-right of each card marks a tool as a favourite — favourites float
to the top of the grid and are remembered in your browser's `localStorage`. Every page also has a
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

## How the REST client works

Requests are sent with `fetch` straight from your browser to the target API — there is no proxy, so
nothing passes through any server of ours. The flip side: the API must allow cross-origin (CORS)
calls from the page's origin, and an `http://` API can't be called from the `https://` site (except
localhost). When a request can't run in the browser, **Copy as curl** exports the exact same request
— headers, auth and body, properly shell-escaped — to run in a terminal. Bearer/Basic auth helpers
set the `Authorization` header, JSON bodies get `Content-Type: application/json` automatically
(explicit headers always win), and the last 20 requests are kept in `localStorage` — including auth
values, so mind shared machines.

**Environments & variables:** define named environments (dev, uat, prod, …) with variables in the
sidebar and reference them as `{{name}}` anywhere in the URL, headers, auth fields or body. The
active environment is switched next to the request; chips under the URL show each variable used —
green when resolved, red when missing — and sending (or curl export, which uses the resolved values)
is blocked while anything is red. History keeps the `{{placeholders}}` plus an environment badge, so
one saved request replays against any environment. Typing `{{` in the URL, headers, auth fields or
body opens an autocomplete of the active environment's variables (↑↓ to select, Enter/Tab to accept,
Esc to close). Environments live in `localStorage` (key `meso-rest-environments`); variable values
are masked in the editor by default.

**Import curl:** the inverse of the export — click **Import curl** (or just paste a curl command
into the URL field) and the method, URL, headers, auth and body fill themselves in.
`Authorization:
Bearer/Basic` headers land in the auth fields, multiple `-d` parts join like curl
joins them, `-G` moves data into the query string, and anything that can't be imported (`-o`,
`--retry`, …) is listed in the toast rather than silently dropped.

**Response tooling & capture:** JSON responses get a **Tree** view — collapsible nodes with a search
box that prunes the tree to matching keys/values — next to the raw pretty-print. Clicking any leaf
fills the JSON-path box (`$.data.items[0].id`); the extracted value previews live, and **Capture**
saves it as a `{{variable}}` in the active environment (one is created if none exists). That closes
the login-then-call loop: send the login request, capture `$.access_token` as `{{token}}`, reference
it in the next request.

## Palette & handoff

Press **Ctrl/⌘ K** on any page (or the `⌘K` button in the top bar) to open the command palette: it
jumps to any tool and runs the current page's main actions — copy result, send request, switch mode,
toggle the theme — from the keyboard.

Tools also chain into each other. The **Send to** buttons next to a tool's result hand the output to
another tool: decode a payload, send it to Sanitize to mask it, then send the masked JSON to the
REST client as a request body. The handoff travels through `sessionStorage` in your browser (same
tab only, consumed on arrival, expires after 5 minutes) — nothing is uploaded.

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
  rest.test.ts        REST-client logic tests (import the module from static/rest/)
  handoff.test.ts     cross-tool handoff tests (import the module from static/)
  palette.test.ts     command-palette filtering tests (import the module from static/)
  diff.test.ts        diff-view line-pairing tests (import the module from static/)
  suggest.test.ts     sensitive-field suggestion tests (import the module from static/)
  encode.test.ts      encode-chain parity tests (roundtrip through decode.mjs)
  jwt.test.ts         JWT verification tests (import the module from static/decode/)
  curl.test.ts        curl-import tests (roundtrip through buildCurlCommand)
  jsonpath.test.ts    JSON-path extraction tests (import the module from static/rest/)
static/
  index.html          hub / master page (lists all tools)
  styles.css          shared theme + hub + tool styles
  theme.js            shared dark/light toggle
  palette.js          shared command palette (Ctrl/⌘ K) overlay, on every page
  palette.mjs         palette filtering/ranking (imported by the browser and the tests)
  handoff.mjs         cross-tool "Send to" handoff (imported by the browser and the tests)
  hub.js              hub master-page interactions (share to Slack, favourite stars)
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
  rest/
    index.html        REST Client UI
    app.js            REST UI logic + fetch (imports ./rest.mjs)
    rest.mjs          pure request/curl/format logic (imported by browser and tests)
    curl.mjs          curl-command import parser (imported by browser and tests)
    jsonpath.mjs      JSON-path extraction for capture (imported by browser and tests)
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
