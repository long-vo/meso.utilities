# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## What this is

A static hub of small, self-contained team utilities behind one master page. There is **no backend**
— every tool runs entirely in the browser, and the site deploys to GitHub Pages. Deno 2.x is used
only as a dev toolchain (formatter, linter, type-checker, test runner, static file server); there is
no server code.

## Commands

```sh
deno task dev     # static file server on http://localhost:8000 (serves static/ only — NOT slidedown)
deno task test    # run all parity tests
deno task check   # type-check both halves — see the gotcha below for the file lists
deno task check:tests    # …just the src/*.test.ts files (strict, deno.json)
deno task check:browser  # …just the browser modules (deno.browser.json)
deno task fmt     # format
deno task lint    # lint
```

Run a single test file or case:

```sh
deno test --allow-read src/decode.test.ts
deno test --allow-read --filter "maskLog: masks every value"
```

**Always verify after finishing a task.** Run `deno task fmt`, `deno task lint`, `deno task check`
and `deno task test`, and confirm all four pass before treating the work as complete. These mirror
CI and the pre-commit hook below — do not report a task done until they are green.

Type-checking runs under **two configs**, and the split is deliberate. `deno.json` keeps the
`src/*.test.ts` files strict. `deno.browser.json` covers the browser modules, which are plain JS:
without `checkJs` the check silently passes on anything — an undeclared identifier included, which
is exactly the bug class it exists to catch. It sets `noImplicitAny: false` (browser code here has
no parameter annotations) but keeps **`strictNullChecks` on**, because without it TypeScript cannot
narrow a discriminated union and every `if (!result.ok)` guard reports a false error on
`result.error`. Elements are bound through `$()`, so where the code uses `value`/`checked`/
`disabled` the `els` entry carries a `/** @type {HTMLInputElement} */`-style cast naming the element
the page actually holds.

A versioned pre-commit hook (`.githooks/pre-commit`) mirrors CI by running fmt-check → check → lint
→ test. Enable it once per clone: `git config core.hooksPath .githooks`. It verifies formatting with
`--check` (never rewrites mid-commit), so on a format failure run `deno task fmt` and re-stage.
Bypass once with `git commit --no-verify`.

`slidedown/` is a separate Vite/React/TS app with its own toolchain (`cd slidedown && deno task dev`
on :5173, `deno task build`). It is excluded from the root `deno.json` and has its own
`slidedown/CLAUDE.md` — read that before working in it.

## Architecture

**The dual-consumption module pattern is the central idea.** Each no-build tool's pure logic lives
in a plain ES module (`static/sanitize.mjs`, `static/decode/decode.mjs`, `static/leave/leave.mjs`).
That module is imported _unchanged_ by both the browser UI (`app.js`) and the Deno tests
(`src/*.test.ts` import straight from `static/`). There is no bundler, no build step, and no
separate test copy — the logic under test is byte-for-byte the logic that ships to the browser. This
is why the tests are called "parity tests." When you touch a tool, keep pure/testable logic in the
`.mjs` module and confine DOM wiring to `app.js`.

Tools come in three tiers:

- **No-build, client-side** — live in `static/<tool>/` as ES modules + HTML, served as-is
  (`sanitize`, `decode`, `leave`). `sanitize` is the odd one out: its files sit at the `static/`
  root (`app.js`, `sanitize.mjs`, `diff.mjs`, `suggest.mjs`, `sanitize/index.html`).
- **Build-required** — `slidedown/`, compiled into `_site/slidedown/` only at deploy time.
- **External/hosted** — Scrum Poker lives in its own repo (`meso.poker`) and is just linked from the
  hub with an ↗ card.

The hub (`static/index.html` + `static/hub.js`) lists every tool as a card and owns hub-only
interactions (share-to-Slack, favourite stars, favourites-only filter, drag-to-reorder, the guided
tour — all persisted in `localStorage`). Cards carry a `data-tool` id that the favourites/filter/
order/tour logic keys off; new cards need one. The card order is the user's own — favourites no
longer float to the top — and `static/reorder.mjs` holds that ordering logic (dual-consumption, with
parity tests): saved orders are reconciled against the cards on the page, so a tool added later
lands at the end instead of disappearing.

**The guided tour** (`static/tour.js` + `static/tour.mjs`) is a focus-stage dialog: one tool per
screen, Back/Continue. Its defining property is that it declares _no_ visuals of its own — title,
colour class, tags, href and the illustration are all read off the hub's cards at runtime (the
`.card-art` SVG is `cloneNode`d), so the stage and the card cannot drift. `tour.mjs` holds only the
prose, keyed by `data-tool`, plus the step arithmetic; `src/tour.test.ts` scrapes `data-tool` out of
`index.html` and fails when a card has no entry, which is what stops a new tool silently skipping
the tour. Three things there that look incidental and aren't: it is handed `originalCards` (the
authored order, unfiltered) so a dragged grid or the favourites filter can't reorder or skip steps;
the `--card-*` properties are `@property`-registered purely so the palette can _transition_ between
tools; and tinted text uses `--tour-accent` rather than `--card-art1`, because the 400 stop fails
4.5:1 on the dark panel (pink) and on white (lime) — see the contrast note in the stylesheet.

Four things the drag wiring in `hub.js` depends on, each of which looks removable and isn't:

- The pointer listeners live on `document`, not on the grip via `setPointerCapture` — reordering
  re-inserts the dragged card, which implicitly releases the capture and strands the drag.
- The dragged card's own empty slot is part of the hit-testing geometry, without which a drag into
  the last row's empty tail oscillates as the grid reflows under the pointer.
- The `card-appear` entrance animation is retired (`.cards.is-settled`) before any reorder: a
  replayed animation's `transform` outranks the inline one the drag sets, snapping the card back.
- Both the drag and the keyboard path commit through `withVisibleOrder`, so reordering while the
  favourites filter is on leaves the cards it hides in the slots they already had.

Shared assets live at the `static/` root and are referenced by every tool with relative paths: a
**single** `styles.css` covers the hub and all tools (scope page-specific rules — the hub page uses
`<main class="hub">`/`<body class="page-hub">`, tool pages use `<main class="layout">`), plus
`theme.js` (dark/light toggle), `palette.js` + `palette.mjs` (the Ctrl/⌘ K command palette — pages
contribute page-specific actions via `registerCommands`) and `handoff.mjs` (the cross-tool "Send to"
handoff over `sessionStorage`). Both shared `.mjs` modules follow the dual-consumption pattern and
have parity tests.

A gotcha with that single stylesheet: some tool pages override the shared `.layout` grid with extra
areas — Leave's `.page-leave .layout` adds a `templates` column. A shared `.layout` grid override
(`grid-template-areas`/`grid-template-columns`) can outrank those page rules by CSS specificity and
silently drop the extra area, hiding a panel. Check any shared layout change against every tool page
(Leave especially), or scope it to the page's own `.page-<tool> .layout`.

`sidebar.js` + `sidebar.mjs` collapse the side panels: `#controls-toggle` (Ctrl/⌘ B) the controls
sidebar, `#rail-toggle` (Ctrl/⌘ Shift B) the third column on the tools that have one — Leave's
templates, Shortlink's rail, Transform's favourites, Availability's legend. A rail opts in by
carrying `class="rail"` and a `data-rail-label` (the button reads "Hide <label> panel"); the wiring
then follows the sidebar's: a flag on `<html>` (`data-rail-collapsed`), set pre-paint by the inline
head script from `meso-rail-hidden-<tool>`, so nothing flashes. Three consequences worth knowing:

- Hiding the panel is shared (`:root[data-rail-collapsed] .rail`), but **dropping its grid column is
  per page** — the three-column templates are page-scoped and outrank anything generic, so each page
  spells out its own `[data-rail-collapsed]` and `[data-controls-collapsed][data-rail-collapsed]`
  grids next to its existing rules. A new rail needs all of them, including the `:has()` variants
  (Leave's hidden editor), which tie on specificity unless the two-attribute selector exists.
- Those rules cover the side-by-side breakpoint only. Stacked, the rail's row is last, so an
  unclaimed area costs one 18px gap and nothing else.
- A rail the page itself hides (Availability's, until a workbook is imported) takes the button with
  it — `sidebar.js` mirrors the panel's `hidden` onto the button via a `MutationObserver`, which is
  why `#rail-toggle`'s `display` rule is scoped `:not([hidden])`.

### Foldable sections — the chevron belongs to the label

Anything foldable inside a panel is folded **by its own label**, and the chevron (`▾` open, `▸`
folded) is **attached to that label, pushed to the panel's right edge** — never a separate control
beside it, never floating mid-row. Availability's controls sidebar is the reference: every field
heading is a `.field-collapse` button carrying a `<span class="caret">`, wired through
`setupCollapse(button, body, key)` in its `app.js` and persisted per field. Adding another one means
matching all of it, because each piece is load-bearing:

- The heading is the button, so it **cannot stay a `<label for=…>`** — a click would toggle _and_
  activate the control, which on a file field opens the file dialog. Give the input its own
  `aria-label` instead, and keep the button's `aria-controls`/`aria-expanded` honest.
- The field's contents get a wrapper div (the `aria-controls` target), since `setupCollapse` hides
  one element.
- Sidebar labels wear the shared `background-clip: text` gradient (see the `@supports` block), so a
  new label-button must join that selector list and reset **`background-color`**, not `background` —
  `background: none` drops the gradient image and leaves transparently-filled text on nothing.
- Authored bodies need the pre-paint inline script at the end of the section: unlike the
  render-filled panels, they would flash open while the deferred module loads. It derives the
  storage key the same way `app.js` does (`meso-<tool>-<body id>-collapsed`).
- Native `<details>` fields keep their own type but get the same right-edge chevron via
  `summary::after` (`list-style: none` + the `-webkit-details-marker` reset).

Two deliberate exceptions, both about what the right edge already holds: the "Who's out" panel keeps
its chevron beside the title, because that edge is the day picker and Copy summary; and
Availability's CSV paste keeps the native left-hand marker with **no** chevron — it is a second way
to fill the Vacation workbook field it now nests inside, not a field of its own.

### Tool iconography — keep it consistent

Since the favicon refresh, every tool has **one visual identity**: a card color class
(`card--purple`, `card--teal`, `card--green`, `card--coral`, `card--pink`, `card--amber`,
`card--blue`) plus an SVG icon. That same icon and color must appear everywhere the tool is
referenced — do not introduce emojis for tool references (emojis remain only for non-tool action
glyphs like 📋 ⬇️ 🌓, and for the hub itself, 🧰). **Every** tool in `TOOL_ICONS` has an SVG, Scrum
Poker included: it was the last emoji hold-out, and the guided tour's recap grid — eight icons side
by side — is what made a full-colour 🃏 beside seven flat tinted glyphs impossible to ignore.
Anywhere tools are shown together, one emoji among SVGs reads as a bug:

- **Favicon** (`static/<tool>/index.html`) — inline `data:` SVG filled with the tool's own
  `--card-art1` hex (dark-theme value), not another tool's color.
- **Breadcrumb** — `<span class="crumb-icon card--<color>">` in the tool page's topbar.
- **⌘K palette** — `TOOL_ICONS` in `static/palette.js` holds the shared markup (icons starting with
  `<` render via `innerHTML`; trusted codebase strings only). `TOOL_LINKS` and any page-registered
  "Send to <tool>" commands must reference `TOOL_ICONS.<tool>`, never an emoji.
- **Send-to buttons** on other tool pages — reuse the same crumb-icon markup inline (see the
  Sanitize/Decode/Transform pages); `.btn .crumb-icon` handles the baseline alignment.

SVG part classes are **context-scoped** — using one outside its context renders unstyled (black):
`.crumb-icon` styles only `i1`/`i2` (fills) and `is1`/`is2` (strokes); `.card-art` styles
`ap`/`a1`/`a2`/`a3` (fills), `adp`/`tp` (text fills), `sd`/`s1`/`s1-thin` (strokes). Light-theme
gotcha inside card art: `--card-paper` is pure white and `--card-tint` near-white, so never pair an
`ap` shape with `tp` text (white-on-white). Give white `ap` shapes an `s1-thin` outline, put `adp`
text on `ap`, and `tp` text on `a1` — the Scrum Poker card is the reference for these pairings.

`sanitize.mjs`'s masking is lifted verbatim (semantics-wise) from the Slack `/sanitize-text`
command; `src/sanitize.test.ts` exists to assert that parity.

Deploy is `.github/workflows/pages.yml`: it copies `static/` → `_site/`, then builds slidedown into
`_site/slidedown/`. The hub itself stays build-free.

### Adding a no-build tool

1. Create `static/<tool>/index.html` + `app.js` (DOM wiring) + `<tool>.mjs` (pure logic).
2. Add `src/<tool>.test.ts` importing the `.mjs` from `static/`.
3. **Add the new files to both check tasks in `deno.json`** — `src/<tool>.test.ts` to `check:tests`
   and `static/<tool>/app.js` to `check:browser`. Both name their files explicitly, so anything new
   goes unchecked otherwise.
4. Add a card with a unique `data-tool` to `static/index.html`.
5. **Register the tool in the ⌘K palette** — add an entry to `TOOL_LINKS` in `static/palette.js` so
   it's reachable from every page (no test catches a missing one).
6. Give the tool a consistent icon — pick a card color, add its SVG to `TOOL_ICONS`, and use the
   same icon/color for the favicon, breadcrumb and card art (see "Tool iconography" above).
7. **Add a `TOUR_CONTENT` entry** in `static/tour.mjs` — a lede and 3–6 `[label, text]` features.
   `src/tour.test.ts` fails until you do; nothing else about the tour needs touching, since it reads
   the rest off the card.
8. Update README.md

## Conventions

`deno fmt` uses a 100-char line width and excludes `static/**/*.html`. Trunk-based flow: `main` is
protected and always deployable — no direct pushes; changes go through a PR with green CI. Branch
with `feature/…`, `bugfix/…` or `chore/…`; commit messages use an imperative title (e.g.
`Add minify toggle`). Run fmt, lint, check and test before opening a PR.
