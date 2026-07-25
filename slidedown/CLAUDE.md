# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Slidedown is a client-only, PowerPoint-like presentation viewer. The user drops
files on a start screen — or writes/pastes text in a live editor — and navigates
the result as slides. There is no backend and no router (the only URL state is
the `#deck=…` share link and the `#editor` deep link) — everything runs in the
browser and all file parsing is local.

The core rule: **one file = one slide, ordered by natural filename sort**, with
exceptions — a PDF expands to one slide per page, an AsciiDoc file to one slide
per top-level `==` section, an image is one slide, a `mermaid` code block
becomes an inline diagram, and a Markdown file may itself split into several
slides on `---`. HTML files are sanitized into a single slide.

## Commands

npm and Deno 2 are interchangeable; `deno.json` tasks mirror the npm scripts and
resolve binaries from `node_modules/.bin`, so install first either way.

- `npm install` / `deno install` — install dependencies
- `npm run dev` / `deno task dev` — Vite dev server (http://localhost:5173)
- `npm run build` / `deno task build` — **`tsc && vite build`**; a type error fails the build
- `npm run preview` / `deno task preview` — serve the production build from `dist/`

There is no test runner or linter configured; type-checking via `tsc` (run as
part of `build`) is the only automated check.

## Architecture

Data flows in one direction: **files → `Slide[]` → render**.

- `src/App.tsx` is a `mode` state machine — `start` → `editor` → `present` —
  plus a transient restore state for a `#deck=…` share link on mount (spinner
  while decoding; failure falls back to `StartScreen` with an error). Files
  dropped on the start screen go straight to `present`; the "Write or paste
  slides" button opens the `editor`. `present` records its origin
  (`presentOrigin`), so exiting a presentation launched from the editor returns
  to the editor (text intact) rather than the start screen. The editor `Draft`
  (`{ text, format }`) is lifted here and persisted to
  `localStorage['slidedown.draft']` (debounced). A `#editor` hash opens the
  editor directly and is mirrored into the address bar while editing — but the
  sync bails on a `#deck=…` link so it never clobbers a share link.
- `src/lib/share.ts` — content-in-URL share links (mermaid.live-style):
  `'#deck=1.' + base64url(deflate-raw(JSON SourceFile[]))` via the native
  `CompressionStream` API. Only text decks are shareable: `slidesFromFiles()`
  sets `Deck.sources` when every input is Markdown/HTML/AsciiDoc, and the
  "Copy share link" button in `Controls.tsx` is disabled otherwise (binary
  payloads would exceed practical URL limits). `decodeHashToFiles()` returns
  `null` on any malformed input; bump the `1.` version when the format
  changes.
- `src/types.ts` defines the model. A `Slide` has a `kind` of `'markdown'`
  (renders `html`) or `'image'` (renders `src`, a data/object URL), plus optional
  `notes` (rendered HTML) and a `fragmentCount` (>= 1). `ProtoSlide` is a slide
  before its index-based `id`. `slidesFromFiles()` returns a `Deck`
  (`{ slides, meta }`) where `meta` carries front-matter (`title`, `author`,
  `theme`). It also defines the paste editor's `Draft` (`{ text, format }`) and
  `ComposeFormat` / `COMPOSE_FORMATS` / `COMPOSE_FORMAT_LABELS`.
- `src/lib/deck.ts` is the loader and the heart of the app. `slidesFromFiles()`
  filters supported files, sorts them naturally by filename, and expands each:
  Markdown → strip front-matter, split on `---`, split notes on `???`, split
  fragments on `+++`, `renderMarkdown` + mermaid enhancement; images → one image
  slide; PDFs → one image slide per page; HTML → one sanitized slide; AsciiDoc →
  `@asciidoctor/core` render, one slide per top-level `==` section (with the doc
  title/author/`:theme:` feeding deck meta). It assigns final ids at the end.
  `sampleSlides()` builds the bundled demo deck the same way. Both are async.
- `src/lib/markdown.ts` — `marked` + `marked-highlight`/`highlight.js` +
  `DOMPurify`. Links are rewritten to open in a new tab. Returns sanitized HTML.
- `src/lib/pdf.ts` — renders each PDF page to a canvas then a PNG data URL. The
  pdf.js worker is wired via the `?url` import.
- `src/lib/mermaid.ts` — `renderMermaidInHtml()` finds `code.language-mermaid`
  in already-rendered HTML and replaces each block with inline SVG. Runs once at
  load time so slides and overview thumbnails both just render stored HTML.
- `src/components/Editor.tsx` — the paste/write editor. A debounced effect wraps
  the textarea text in a virtual `File([text], 'deck.<ext>')` and runs it through
  `slidesFromFiles()` — **no new parsing; pasted text is treated exactly like a
  dropped file** — guarding out-of-order async builds with a `buildId` ref and a
  `mounted` ref (the present transition unmounts it). It reuses `SlideView` for
  the big preview (fit-scaled like `Presentation`, but rendered **outside**
  `.stage-wrap` so all `+++` fragments show) and the `.thumb*` markup for the
  rail. **Present** rebuilds synchronously from the current text so a mid-debounce
  click can't launch a stale deck.
- `src/components/Presentation.tsx` — owns index/step/direction/zoom/pan/
  overview/speaker/print state and all interaction. Slides live on a **fixed
  1280×720 (16:9) stage** scaled to fit via a `ResizeObserver` (`fitScale`);
  displayed scale is `fitScale × zoom`. `→`/`←` walk fragment `step` within a
  slide before changing `index`.
- Presentation composes `Slide`, `Controls`, `ProgressBar`, `Overview`,
  `SpeakerView`, and `PrintView`; keyboard/fullscreen live in `src/hooks/`.
- `src/components/SpeakerView.tsx` opens a second window (`window.open`) and
  `createPortal`s into it, copying the main document's styles; it shows the
  current/next slide, notes, and a timer, and shares state with the main window.
- `src/components/PrintView.tsx` + a `@media print` block render one 1280×720
  page per slide; `exportPdf` sets `printing` then calls `window.print()`.
- Theme is an app-level `ThemeName` (light, dark, midnight, sepia, forest,
  contrast) on `document.documentElement` (`data-theme`), persisted to
  `localStorage`, overridable per deck via front-matter. Each theme is a block
  of CSS variables under `[data-theme='…']` in `styles.css` (including the
  `--glow-*` aurora colours); add one by extending `THEMES` in `types.ts` plus a
  CSS block and a `.swatch-*` colour.
- **Chrome tokens.** The **presentation** chrome stays dark in every theme (it
  reads `--app-bg` directly), but the **start screen and editor** are surfaces
  people sit on, so they follow the theme via a shared `--chrome-*` token set:
  light for the light-content themes (light/sepia/forest/contrast), dark for
  dark/midnight. The tokens are scoped to the `.editor` / `.start` roots (not the
  theme blocks) so the editor's per-deck `data-theme` on `.editor-right` — which
  themes only the preview slide + thumbnails — can't hijack the surrounding
  chrome. Reused-but-dark-tuned bits (the `.start-brand*` wordmark, `.ctrl-btn`
  theme-menu trigger) are re-pointed at `--chrome-*`; on bright themes the
  `meso.utilities` wordmark takes the hub's blue→purple brand gradient to match
  the other utilities.

## Conventions and gotchas

- **Keep `pdfjs-dist`, `mermaid` and `@asciidoctor/core` lazy.** They are
  dynamically `import()`-ed from `deck.ts` only when a PDF, a `language-mermaid`
  block, or an `.adoc` file is present. Do not add a static import of any of them
  into the main module graph — it would move them out of their on-demand chunks
  and bloat the ~128 KB (gzip) main bundle. (Mermaid further code-splits per
  diagram type; many small chunks is expected.)
- Mermaid detection depends on the `language-mermaid` class emitted by
  `marked-highlight`; changing the markdown highlighter must preserve it.
- The 1280×720 base size is assumed throughout scaling and thumbnail math — keep
  slide/thumbnail transforms in sync if you change it.
- Filename order is a **numeric-aware** `localeCompare`, so `2-x.md` precedes
  `10-x.md`. Users prefix files `01-`, `02-` to order a deck.
- Authoring markers are parsed in `deck.ts` **before** `marked` sees the text:
  front-matter (`---`…`---` at the very top), slide splits (`---`), speaker
  notes (`???`), and fragments (`+++`). Because `---` now splits slides, it is
  no longer available as a horizontal rule. Fragments are hidden via
  `.slide-content .fragment`, so they stay fully visible in thumbnails and PDF
  export (which live outside `.slide-content`).
- Adding an input format: extend `deck.ts` (an `isXxxFile` check,
  `isSupportedFile`, a proto builder), handle any new `kind` in `Slide.tsx` and
  `Overview.tsx`, and update the `accept` attribute in `StartScreen.tsx`. For a
  **text** format, also add it to `COMPOSE_FORMATS` / `COMPOSE_FORMAT_LABELS` in
  `types.ts` and the extension map in `Editor.tsx` so it appears in the paste
  editor's format selector.
- Theme is driven by CSS variables in `src/styles.css` (`--accent`, `--app-bg*`,
  `--slide-bg`); the slide title (`h1`) uses `--accent`.
- TypeScript is `strict` with `noUnusedLocals`/`noUnusedParameters`; the new JSX
  transform is on, so no `React` import is needed in components.

## Deployment

Slidedown has no deploy workflow of its own. It is a utility within the
`meso.utilities` repo, whose `.github/workflows/pages.yml` builds it with Deno
(`deno task build`) and assembles the output into the hub's GitHub Pages site
under `/slidedown/`. Vite `base` is `'./'` (relative) so the build works under
that sub-path without further configuration.
