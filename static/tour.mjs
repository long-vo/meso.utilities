// meso.utilities — the hub's guided tour: content and pure step logic. The tour
// is a focus stage — one tool per screen, Back/Continue — and this module holds
// everything about it that isn't the DOM: the prose, the two non-tool steps, and
// the arithmetic behind moving through them. Dual-consumption: imported
// unchanged by the browser (`tour.js`) and by `src/tour.test.ts`.
//
// Deliberately *not* here: titles, illustrations, colours, tags and hrefs. Those
// are read off the hub's own cards at runtime (see `tour.js`), so the stage and
// the card can never drift — one SVG, one title, one colour, shown at two sizes.
// `buildSteps` takes plain descriptors rather than elements, which is what keeps
// this module DOM-free and testable under Deno.

/** localStorage key recording that the tour has been seen. */
export const SEEN_KEY = "meso-tour-seen";

/**
 * Version of the tour the stored flag refers to. Bumping it re-shows the
 * first-visit nudge once to everyone — which is what a release that adds a tool
 * wants, since the tour then covers something the user has never been told
 * about. A stored value from an older version therefore counts as "not seen".
 */
export const SEEN_VERSION = "1";

/** True when the first-visit nudge should be offered for `stored`. */
export function shouldNudge(stored) {
  return stored !== SEEN_VERSION;
}

/* -------------------------------- content --------------------------------
   Per-tool prose, keyed by the card's `data-tool`. Each feature is a
   [label, text] pair: the label is the claim, the text is what backs it up.
   `src/tour.test.ts` fails if a card on the hub has no entry here (or an entry
   here has no card), so adding a tool cannot silently skip the tour. */

/** @type {Record<string, { lede: string, features: [string, string][] }>} */
export const TOUR_CONTENT = {
  sanitize: {
    lede: "Mask the sensitive fields in a payload or a whole log file before you paste it into a " +
      "ticket. The masking is lifted from the Slack /sanitize-text command, so what you get here " +
      "is what the bot gave you.",
    features: [
      [
        "Masks by key, at any depth.",
        "Any value whose key matches your field list is masked — inside objects, inside arrays, " +
        "case-insensitively. The last N characters stay readable; anything shorter than N is " +
        "masked whole, so short secrets never leak.",
      ],
      [
        "Diff view proves it.",
        "Toggle Diff to see the original beside the masked output line by line — everything " +
        "sensitive caught, nothing else changed.",
      ],
      [
        "Suggested fields find what you forgot.",
        "The payload is scanned for keys that look sensitive by name (password, …Name, phone…) " +
        "or by value shape — emails, IBANs, JWTs, card numbers, tokens — and each one missing " +
        "from your list is offered as a one-click chip.",
      ],
      [
        "Log-file mode reads whole logs.",
        "Attach a .log or .txt and it masks the structured parts it finds: JSON blocks, Java " +
        "toString dumps and Java maps. Timestamps, logger names and messages are left intact.",
      ],
      [
        "Redact IDs, when you want it.",
        "An opt-in toggle also masks by shape — UUIDs, IPv4 addresses, emails, IBANs — anywhere " +
        "in the log. Off by default, because those loose identifiers are often the thing you're " +
        "debugging.",
      ],
    ],
  },

  decode: {
    lede:
      "Paste something unreadable and it unwraps one layer at a time until text comes out — then " +
      "flips around and stacks the layers back up when you need to build a test payload.",
    features: [
      [
        "Layer by layer, up to twelve.",
        "Base64 → gzip → formatted JSON is one paste. Hex, URL-encoding, zlib, PEM, data: URLs " +
        "and escaped JSON are all in the chain, each step shown as its own layer.",
      ],
      [
        "Conservative on purpose.",
        "A Base64 or hex decode is only accepted when the result is readable UTF-8 or a " +
        "recognised binary format (gzip, zlib, PDF, PNG, ZIP, DER). Plain words, paths and IDs " +
        "that merely look encoded are left alone.",
      ],
      [
        "JWTs get a card of their own.",
        "Claims decoded, and exp / nbf / iat explained in human terms rather than epoch seconds.",
      ],
      [
        "Verify the signature in place.",
        "Paste the HMAC secret or a JWK/JWKS and the token is verified right there — HS, RS, PS " +
        "and ES families, via WebCrypto, in the browser.",
      ],
      [
        "Encode mode mirrors it.",
        "Type plain text and stack layers in any order: Base64 (standard or URL-safe), hex, " +
        "percent-encoding, gzip+Base64, JSON escaping. Building a payload is the same motion as " +
        "reading one.",
      ],
    ],
  },

  leave: {
    lede: "One small form produces the two artifacts the team's leave process asks for — the HR " +
      "email and the Outlook calendar event — already formatted. Nothing is sent from here; the " +
      "buttons hand off to your own apps.",
    features: [
      [
        "The form follows the leave type.",
        "Annual, Sick and Core produce both artifacts. Remote and WFH aren't leave, so the HR " +
        "step disappears along with the two fields that only feed it. Half days are offered " +
        "where the type allows them.",
      ],
      [
        "Dates that know the calendar.",
        "The start date opens on the next working day, a range collapses to a single date for a " +
        "half day, and the summary line counts the days and warns about weekend endpoints.",
      ],
      [
        "Editable, then handed off.",
        "The generated email body is yours to tweak — the hand-offs use your version, and Reset " +
        "returns to the generated text. Open in mail uses mailto:; Open in Outlook (web) opens a " +
        "pre-filled compose tab.",
      ],
      [
        "The calendar event, prefilled.",
        "Subject, dates, all-day flag and attendees are set for you; reminder chips flag the one " +
        'thing a URL can\'t do — unchecking "Request Response".',
      ],
      [
        "Save to Availability closes the loop.",
        "The matching day codes are written onto your row in Team Availability the next time it " +
        "opens — in any tab, however long the detour takes — and it reports what it skipped " +
        "instead of guessing.",
      ],
      [
        "Templates and saved recipients.",
        "Everything except the dates can be saved as a named preset, and addresses you've used " +
        "are offered as autocomplete. Both live in this browser.",
      ],
    ],
  },

  availability: {
    lede:
      "Drop the team's vacation workbook and it becomes one people × days model: who's out, how " +
      "thin each team's week is, and what everyone's year looks like — parsed in the tab, never " +
      "uploaded.",
    features: [
      [
        "Distrustful parsing.",
        "Dates come from quarter + column position + the workbook year, because the file's own " +
        "date headers carry stale years. Any cell that isn't a known day code lands in a " +
        "warnings panel with its sheet and cell reference — and counts as working, so dirty data " +
        "never silently shrinks capacity.",
      ],
      [
        "A heatmap you can drive from the keyboard.",
        "One row per person, one column per day, weekends hatched and today outlined. It's a " +
        "real ARIA grid: arrow keys move between cells, Page Up/Down by ten rows, Enter on a day " +
        "header reports on that day.",
      ],
      [
        "Who's out, and what's left.",
        "A strip groups who's off, on a half day or remote — today or any day you pick — with a " +
        "one-click plain-text summary for standup. Below it, per-team available person-days " +
        "against each week's maximum, with a low-capacity threshold you set.",
      ],
      [
        "One person's whole year.",
        "Click a name for their days by kind, a bar per month, and every absence grouped into " +
        "date ranges — a Friday-to-Monday run reads as one two-day absence, not four.",
      ],
      [
        "Leave balances, from the workbook's own arithmetic.",
        "Carried over, allowance, planned, taken and what remains of annual, core and sick — " +
        "kept in step with every day written onto the grid.",
      ],
      [
        "It goes both ways.",
        "Pick days on a row and Send to Leave; the request comes back onto the grid, logged in " +
        "Recorded changes — where each entry can be undone, and says so if a later import " +
        "overwrote it.",
      ],
    ],
  },

  shortlink: {
    lede:
      "Give a URL a name you'll remember and reach it as #name. A personal directory that lives " +
      "in your browser — organised, searchable, and shareable when you choose to.",
    features: [
      [
        "#name → the URL.",
        "Lowercase names, unique across groups. An unknown #name shows the directory with the " +
        "name pre-filled instead of a dead end, and pasting a target into the empty form " +
        "suggests a name from the URL.",
      ],
      [
        "Groups, nested and collapsible.",
        "A / in the group name nests — Team/Frontend sits under Team — and dragging a link into " +
        "another group moves it there. Groups you create explicitly stick around while empty.",
      ],
      [
        "List or speed-dial.",
        "A grid of compact row-tiles — the name over the target's host, beside its favicon, " +
        "with a colour monogram standing in when there isn't one. Icons are fetched from each " +
        "target's own origin — never a third-party icon service — so nothing else learns what " +
        "you've saved.",
      ],
      [
        "Dynamic links.",
        "#name/rest appends to the target, and a {q} placeholder is replaced by it: " +
        "q → https://google.com/search?q={q} makes #q/deno fmt a search. The form previews the " +
        "substitution as you type.",
      ],
      [
        "Import without surprises.",
        "A shared link, a shortlinks.json, or your browser's bookmarks export — all go through " +
        "the same picker, which tags anything that would replace an existing name and can be " +
        "undone from the toast.",
      ],
    ],
  },

  transform: {
    lede:
      "One text area and a searchable action list, modelled on IntelliJ's String Manipulation " +
      "plugin. Pick an action and the text changes in place — or select part of it first and " +
      "change only that.",
    features: [
      [
        "Case, every way round.",
        "camelCase, kebab, snake, SCREAMING_SNAKE, dot.case, PascalCase — or cycle, which " +
        "detects the current format and moves to the next. Conversions run per line, so a " +
        "pasted list of identifiers converts in one go, indentation intact.",
      ],
      [
        "Sorting that knows what it's sorting.",
        "Natural order via Intl.Collator (so a2 comes before a10), by length, hexadecimally, " +
        "hierarchically — indented children stay attached to their parent — plus reverse, " +
        "shuffle and recursive JSON key sort.",
      ],
      [
        "Filter, trim, align.",
        "grep, inverted grep and group-by-grep take plain text or /regex/flags. Trim, collapse " +
        "whitespace, dedupe lines, drop empty ones. Align turns delimited lines into padded " +
        "columns.",
      ],
      [
        "Convert and re-quote.",
        'Minify JSON, JSON ↔ YAML, shift quotes " → \' → ` → " with the contents re-escaped, ' +
        "curly ↔ straight, and path separators Windows ↔ UNIX.",
      ],
      [
        "Undo, favourites, ⌘K.",
        "Every action steps through an undo history, ☆ pins the ones you use to a favourites " +
        "rail, and all of them are runnable from the command palette.",
      ],
    ],
  },

  slidedown: {
    lede:
      "Turn what you already wrote into slides. Drop Markdown, HTML, AsciiDoc, PDFs or images — " +
      "or write straight into the live editor — and present without leaving the browser.",
    features: [
      [
        "Drop files or write in place.",
        "A live editor beside the deck, so the slide updates as you type; or drag in the files " +
        "you already have.",
      ],
      [
        "Present properly.",
        "Speaker view, themes and keyboard navigation — the parts you actually need in front of " +
        "a room.",
      ],
      [
        "Export to PDF.",
        "The deck leaves as a file when it needs to be attached rather than presented.",
      ],
      [
        "Share by link.",
        "A text deck's content travels in the URL fragment — which is never sent to any server — " +
        "so a link is the whole deck, no upload involved.",
      ],
      [
        "The one tool with a build step.",
        "A Vite/React app in slidedown/, compiled in CI and published under /slidedown/. " +
        "Everything else on the hub ships as-is.",
      ],
    ],
  },

  poker: {
    lede:
      "Planning poker for estimation: everyone picks a card, you reveal together, and the number " +
      "is the team's rather than the loudest voice's.",
    features: [
      [
        "Share a room code.",
        "One person opens a room, the rest join with the code, and estimates stay hidden until " +
        "the reveal.",
      ],
      [
        "Reveal together.",
        "No anchoring — nobody sees a number before their own is in.",
      ],
      [
        "The one that needs a server.",
        "Live rooms can't be done in a static page, so this lives in its own repo, meso.poker, " +
        "and is hosted on Render. The hub links straight to it with an ↗ card.",
      ],
    ],
  },
};

/* ---------------------------- the two book-ends ----------------------------
   The hub's own features (client-side by default, ⌘K, favourites, drag order,
   Send-to chaining) belong here rather than on a tool step, so no tool has to
   carry them. Both use the neutral `card--brand` palette: the tour's own steps
   shouldn't borrow a tool's identity. */

/** @type {{ id: string, kind: string, color: string, title: string, kicker: string, lede: string, tags: string[], features: [string, string][] }} */
export const INTRO = {
  id: "intro",
  kind: "intro",
  color: "card--brand",
  title: "Eight small tools, one page",
  kicker: "Welcome",
  tags: ["8 tools", "One page"],
  lede: "Every tool here does one job and does it without a server — your data stays in the tab. " +
    "This tour spends one screen on each. Two minutes, and you can leave any time.",
  features: [
    [
      "Nothing is uploaded.",
      "Sanitize, Decode, Leave, Availability, Shortlink, Transform and Slidedown all run " +
      "entirely in your browser. Scrum Poker is the one exception — live rooms need a server, " +
      "so it is hosted and opens in its own tab.",
    ],
    [
      "⌘K goes anywhere.",
      "Ctrl/⌘ K opens the command palette on every page: jump between tools, or run the page " +
      "you're on — copy the result, switch mode, toggle the theme, show and hide the side panels.",
    ],
    [
      "Make the grid yours.",
      "☆ stars a tool as a favourite and the toolbar filter narrows the grid to those; the ⠿ " +
      "grip drags a card anywhere — arrow keys work too. Both are remembered in this browser.",
    ],
    [
      "Tools chain into each other.",
      "The Send to buttons hand one tool's output to the next: decode a payload and send it to " +
      "Sanitize; pick days in Availability and send them to Leave Request.",
    ],
  ],
};

/** @type {{ id: string, kind: string, color: string, title: string, kicker: string, lede: string, tags: string[], features: [string, string][] }} */
export const OUTRO = {
  id: "outro",
  kind: "outro",
  color: "card--brand",
  title: "You've seen the whole toolbox",
  kicker: "That's everything",
  tags: [],
  lede:
    "Nothing here needs setting up — open a tool and start. Three things worth carrying out of " +
    "the tour:",
  features: [
    [
      "Ctrl/⌘ K from anywhere.",
      "The fastest way back to any of these, and the way to run the current page without hunting " +
      "for the button.",
    ],
    [
      "Star what you use.",
      "☆ on a card, then Favourites only, and the grid is the two or three tools you actually " +
      "open. Drag the rest into whatever order suits you.",
    ],
    [
      "Take the tour again whenever.",
      "Take a tour stays in the toolbar, and it's in the command palette too.",
    ],
  ],
};

/**
 * Assemble the step list: the intro, one step per card that has content, then
 * the outro. `cards` are plain descriptors — `{ id, title, color, href, tags,
 * external }` — read off the hub in `tour.js`; a card with no `TOUR_CONTENT`
 * entry is skipped rather than rendered empty (the parity test is what stops
 * that being silent). The tool steps keep the order they are given, which is
 * the hub's *authored* order: a dragged grid or an active favourites filter
 * must not reorder or skip the tour.
 */
export function buildSteps(cards) {
  const tools = (cards ?? [])
    .filter((card) => card && typeof card.id === "string" && card.id in TOUR_CONTENT);
  return [
    INTRO,
    ...tools.map((card, index) => ({
      id: card.id,
      kind: "tool",
      color: card.color,
      title: card.title,
      kicker: `Tool ${index + 1} of ${tools.length} · ${
        card.external ? "hosted, opens in a new tab" : "runs in your browser"
      }`,
      tags: card.tags ?? [],
      href: card.href,
      external: Boolean(card.external),
      lede: TOUR_CONTENT[card.id].lede,
      features: TOUR_CONTENT[card.id].features,
    })),
    OUTRO,
  ];
}

/**
 * Keep a step index inside the list. Every way of moving — the buttons, the
 * arrow keys, Home/End, a click on the progress rail — goes through this, so
 * they can't disagree about what the ends are.
 */
export function clampIndex(index, length) {
  if (!Number.isFinite(index) || length <= 0) return 0;
  return Math.max(0, Math.min(Math.trunc(index), length - 1));
}
