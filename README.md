# SliderWeb

A PowerPoint-like presentation viewer that turns a list of Markdown files into
navigable slides — right in the browser. **Each Markdown file becomes one
slide**, ordered by filename.

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

## Deploy to GitHub Pages

The workflow at `.github/workflows/deploy.yml` builds the site **with Deno**
(`denoland/setup-deno`) and publishes it to GitHub Pages on every push to
`main`.

One-time setup:

1. Push the repo to GitHub with `main` as the default branch.
2. In the repo, open **Settings → Pages → Build and deployment** and set
   **Source** to **GitHub Actions**.
3. Push to `main` (or trigger the workflow from the **Actions** tab).

Once it finishes, the site is live at a public URL:

```
https://<your-username>.github.io/<repo-name>/
```

For example, `https://<your-username>.github.io/SliderWeb/`. The Vite config
uses a relative `base`, so assets resolve correctly under the repository
sub-path — no extra configuration required.

## How it works

1. Open the app — you'll see a start screen.
2. **Drop `.md` files** onto it, or click to pick files. You can also click
   **"Load sample deck"** to see it in action immediately.
3. Each file becomes one slide. Slides are sorted **naturally by filename**, so
   `2-intro.md` comes before `10-summary.md`.

Prefix filenames with numbers to control order:
`01-title.md`, `02-agenda.md`, `03-details.md` …

A ready-to-try set of files lives in the [`examples/`](./examples) folder —
select all of them on the start screen to load them as a deck.

## Navigation

| Action            | Keys                              |
| ----------------- | --------------------------------- |
| Next slide        | `→` · `Space` · `Page Down` · `J` |
| Previous slide    | `←` · `Page Up` · `K`             |
| First / last      | `Home` / `End`                    |
| Zoom in / out     | `+` / `−`                         |
| Reset zoom        | `0`                               |
| Overview grid     | `O`                               |
| Fullscreen        | `F`                               |
| Exit overview / zoom | `Esc`                          |

You can also use the floating control bar at the bottom, or click any empty
area of a slide to advance.

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
- Images (`![alt](url)`)

The first heading in a file is used as its title in the overview grid; if there
is no heading, the filename is used.

## Project structure

```
src/
  App.tsx                 App shell: start screen ↔ presentation
  main.tsx                React entry point + global styles
  types.ts                Shared types (Slide, Direction)
  styles.css              All styling and the 16:9 slide theme
  lib/
    markdown.ts           Markdown → sanitized HTML pipeline
    deck.ts               Files → sorted slides, sample loader
  hooks/
    useKeyboardNav.ts     Global keyboard shortcuts
    useFullscreen.ts      Fullscreen toggle
  components/
    StartScreen.tsx       Drag & drop / file picker
    Presentation.tsx      Slide state, scaling, transitions
    Slide.tsx             A single scaled 16:9 slide
    Controls.tsx          Floating control bar
    ProgressBar.tsx       Top progress indicator
    Overview.tsx          Thumbnail grid
    Icons.tsx             Inline SVG icons
  samples/                Bundled "Load sample deck" content
examples/                 Loose .md files to try drag & drop
```

## Notes

- Slides use a fixed 16:9 stage (1280×720) that scales to fit any window, so
  layout stays consistent like real presentation slides. Overly long content
  scrolls within its slide.
- All parsing happens client-side; nothing is uploaded anywhere.
