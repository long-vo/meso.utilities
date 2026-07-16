# Slidedown

A PowerPoint-like presentation viewer that turns Markdown, HTML, AsciiDoc,
PDFs, and images into navigable slides — right in the browser. **Each Markdown,
HTML, or image file becomes one slide; each PDF page and each AsciiDoc section
becomes one slide**, ordered by filename.

Built with Vite + React + TypeScript.

## Quick start

Requires [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install      # install dependencies (first time only)
npm run dev      # start the dev server
```

Then open the printed URL (usually http://localhost:5173).

To create an optimized production build:

```bash
npm run build    # type-check + bundle into dist/
npm run preview  # serve the built site locally
```

## Run with Deno

The project also runs under [Deno](https://deno.com) 2 — no Node install
required. Deno runs the same code through Vite and installs the npm
dependencies itself:

```bash
deno install       # install npm dependencies into node_modules
deno task dev      # start the dev server
deno task build    # type-check + build into dist/
deno task preview  # preview the production build
```

The tasks live in `deno.json` and mirror the npm scripts.

## Deploy

Slidedown ships as a utility of [meso.utilities](../README.md) and has no
deploy workflow of its own. That repo's `.github/workflows/pages.yml` builds it
with Deno (`deno task build`) and publishes the output under `/slidedown/` on
the hub's GitHub Pages site:
<https://long-vo.github.io/meso.utilities/slidedown/>.

Vite's relative `base` (`'./'`) is what lets the build work under that sub-path
with no extra configuration.

## How it works

1. Open the app — you'll see a start screen.
2. **Drop `.md`, `.html`, `.adoc`, `.pdf`, or image files** onto it, or click to
   pick files. You can also click **"Load sample deck"** to see it in action
   immediately.
3. Slides are sorted **naturally by filename**, so `2-intro.md` comes before
   `10-summary.md`. Each Markdown, HTML, or image file is one slide; each PDF is
   expanded into one slide per page and each AsciiDoc file into one slide per
   top-level section (kept in order).

### Supported file types

| Type     | Extensions                                             | Becomes                              |
| -------- | ------------------------------------------------------ | ------------------------------------ |
| Markdown | `.md` `.markdown` `.mdown` `.mkd`                      | one slide per file (split on `---`)  |
| HTML     | `.html` `.htm`                                         | one sanitized slide per file         |
| AsciiDoc | `.adoc` `.asciidoc`                                    | one slide per top-level `==` section |
| PDF      | `.pdf`                                                 | one slide per page (via pdf.js)      |
| Image    | `.png` `.jpg` `.jpeg` `.gif` `.webp` `.avif` `.svg` `.bmp` | one slide per image              |

PDF pages are rendered to images entirely in the browser — nothing is uploaded.
Large PDFs take a moment to render and use more memory, since every page is
rasterized up front.

HTML files are sanitized before display: `<script>` is stripped and links open
in a new tab, while inline styles are kept. AsciiDoc is rendered to HTML in the
browser with [Asciidoctor.js](https://github.com/asciidoctor/asciidoctor.js)
(loaded on demand); the document title/author and a `:theme:` attribute fill in
the deck's title, author, and theme.

Prefix filenames with numbers to control order:
`01-title.md`, `02-agenda.md`, `03-details.md` …

A ready-to-try set of files lives in the [`examples/`](./examples) folder —
select all of them on the start screen to load them as a deck.

## Navigation

| Action               | Keys                              |
| -------------------- | --------------------------------- |
| Next (or fragment)   | `→` · `Space` · `Page Down` · `J` |
| Previous             | `←` · `Page Up` · `K`             |
| First / last         | `Home` / `End`                    |
| Zoom in / out        | `+` / `−`                         |
| Reset zoom           | `0`                               |
| Overview grid        | `O`                               |
| Speaker view         | `S`                               |
| Auto-play            | `P`                               |
| Toggle theme         | `T`                               |
| Pen (draw on slide)  | `D` · clear with `C`              |
| Laser pointer        | `W`                               |
| Export to PDF        | `E`                               |
| Fullscreen           | `F`                               |
| Exit pen/laser, overview or zoom | `Esc`                 |

`→` reveals the next fragment before advancing to the next slide. You can also
use the floating control bar at the bottom, or click any empty area of a slide
to advance.

### Zoom & pan

To inspect a slide up close, zoom in with the `+` / `−` control-bar buttons, the
`+` / `−` keys, or **Ctrl / ⌘ + scroll**. While zoomed in, **drag to pan** (or
scroll to pan). Press `0`, `Esc`, or the percentage button to reset. Zoom resets
automatically when you change slides.

## Markdown support

Standard GitHub-Flavored Markdown, rendered with [marked](https://marked.js.org)
and sanitized with [DOMPurify](https://github.com/cure53/DOMPurify):

- Headings, **bold**, _italic_, lists, links (open in a new tab)
- Tables and blockquotes
- Fenced code blocks with syntax highlighting via
  [highlight.js](https://highlightjs.org)
- **Line highlights & step-through** — add ranges to the fence:
  ` ```ts {2,5-7} ` highlights those lines; ` ```ts {1-3|5|7-9} ` steps
  through the groups with `→`, exactly like fragments
- Flowcharts and diagrams in ` ```mermaid ` code blocks, rendered with
  [Mermaid](https://mermaid.js.org) (flowchart, sequence, class, state, pie,
  Gantt, …)
- Images (`![alt](url)`)

The first heading in a file is used as its title in the overview grid; if there
is no heading, the filename is used.

## Authoring

A single Markdown file can be more than one slide:

- **Multiple slides** — separate them with a `---` line (keep a blank line
  before it).
- **Speaker notes** — everything after a `???` line becomes notes, shown only
  in the speaker view.
- **Fragments** — separate chunks with `+++` to reveal them one click at a
  time; `→` steps through fragments before moving to the next slide.
- **Entrance animations** — start a block or bullet with `@up`, `@down`,
  `@left`, `@right`, `@zoom`, or `@fade` to animate it in (on slide load, or
  when its `+++` fragment is revealed). Add timing in ms: `@up:200` sets a
  delay, `@zoom:0:800` sets delay then duration. Elements without a delay
  auto-stagger.
- **Layout directives** — lines at the very top of a slide:
  - `@columns` splits the slide into two columns at a `|||` line
  - `@image-left <url>` / `@image-right <url>` put an image in one half and
    the slide content in the other
  - `@background <colour | gradient | image url>` gives the slide a
    full-bleed background (also visible in thumbnails and the PDF export)
- **Front-matter** — an optional YAML block at the very top sets deck options:

```markdown
---
title: My Deck
author: Me
theme: dark
---
# First slide
```

## Presenting

- **Speaker view** (`S`) opens a second window with the current and next
  slide, your notes, and an elapsed timer. Navigate from either window.
- **Themes** — pick from Light, Dark, Midnight, Sepia, Forest, and High
  contrast via the palette button (or cycle with `T`); set a deck's default
  with front-matter `theme:` (e.g. `theme: midnight`). Your choice is
  remembered across sessions.
- **Export to PDF** (`E`) — opens the print dialog laid out one slide per
  16:9 page; choose "Save as PDF".
- **Auto-play** (`P`) — advances fragments then slides every few seconds,
  hands-free, and stops at the end.
- **Annotations** — `D` toggles a pen to draw on the current slide (strokes
  stick to the slide and survive flipping back and forth; `C` clears them),
  `W` toggles a laser-pointer dot. `Esc` puts the tool away.

## Project structure

```
src/
  App.tsx                 App shell: start screen ↔ presentation
  main.tsx                React entry point + global styles
  types.ts                Shared types (Slide, Direction)
  styles.css              All styling and the 16:9 slide theme
  lib/
    markdown.ts           Markdown → sanitized HTML pipeline (+ HTML sanitizer)
    deck.ts               Files → sorted slides, front-matter, sample loader
    pdf.ts                PDF pages → image slides (lazy)
    mermaid.ts            ```mermaid blocks → inline SVG (lazy)
  hooks/
    useKeyboardNav.ts     Global keyboard shortcuts
    useFullscreen.ts      Fullscreen toggle
  components/
    StartScreen.tsx       Drag & drop / file picker
    Presentation.tsx      Slide/zoom/fragment state, scaling, transitions
    Slide.tsx             A single scaled 16:9 slide
    Controls.tsx          Floating control bar
    ProgressBar.tsx       Top progress indicator
    Overview.tsx          Thumbnail grid
    SpeakerView.tsx       Pop-out presenter window (notes, timer)
    PrintView.tsx         Print/PDF layout (one page per slide)
    Icons.tsx             Inline SVG icons
  samples/                Bundled "Load sample deck" content
examples/                 Loose .md / .html / .adoc files to try drag & drop
```

## Notes

- Slides use a fixed 16:9 stage (1280×720) that scales to fit any window, so
  layout stays consistent like real presentation slides. Overly long content
  scrolls within its slide.
- All parsing happens client-side; nothing is uploaded anywhere.
