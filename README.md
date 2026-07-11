# meso.utilities

[![CI](https://github.com/long-vo/meso.utilities/actions/workflows/ci.yml/badge.svg)](https://github.com/long-vo/meso.utilities/actions/workflows/ci.yml)

A static hub of small, self-contained team utilities behind a common master page. No backend —
everything here runs entirely in your browser and deploys to GitHub Pages.

- **Sanitize JSON** (`/sanitize/`) — mask sensitive fields inside a JSON payload or log file, ported
  from the Slack `/sanitize-text` command. Runs fully client-side.
- **Slidedown** (`/slidedown/`) — turn Markdown files, PDFs and images into navigable presentation
  slides, with speaker view, themes and PDF export. A Vite/React app (in `slidedown/`) built in CI;
  runs fully client-side.
- **Scrum Poker** — planning poker for team estimation. Lives in its own repo,
  [meso.poker](https://github.com/long-vo/meso.poker), and is hosted on Render (it needs a server
  for live rooms); the hub links straight to it.

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
static/
  index.html          hub / master page (lists all tools)
  styles.css          shared theme + hub + tool styles
  theme.js            shared dark/light toggle
  sanitize.mjs        masking logic (imported by the browser and the tests)
  app.js              sanitizer UI logic (imports ./sanitize.mjs)
  sanitize/
    index.html        Sanitize JSON UI
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

A versioned pre-commit hook (`.githooks/pre-commit`) runs the same four checks as CI on every
commit. Enable it once per clone:

```sh
git config core.hooksPath .githooks
```

Formatting is verified with `--check` (the hook never rewrites files mid-commit); if it fails, run
`deno task fmt` and re-stage. Bypass a single commit with `git commit --no-verify`.

CI (`.github/workflows/ci.yml`) runs the format check, lint, type check and tests on every push to
`main` and every pull request.
