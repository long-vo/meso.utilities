// meso.utilities — shared command palette (Ctrl/⌘ K), imported by every page's
// main script. Filtering/ranking is pure and lives in palette.mjs (covered by
// the parity tests); this module owns the overlay DOM and keyboard wiring.
import { filterCommands } from "./palette.mjs";

/** Commands contributed by the current page, shown above the built-ins. */
const registered = [];

/**
 * Add page-specific commands. Each command is
 * `{ icon?, title, hint?, keywords?, run }` — `run` is called when picked.
 * A function may be registered instead of an array: it is called every time
 * the palette renders and must return commands, so pages can contribute
 * entries derived from changing state (e.g. saved items).
 */
export function registerCommands(commands) {
  if (typeof commands === "function") registered.push(commands);
  else registered.push(...commands);
}

/** Registered commands with any provider functions expanded. */
function registeredCommands() {
  return registered.flatMap((entry) => (typeof entry === "function" ? entry() : entry));
}

/* ------------------------------- built-ins ------------------------------- */
// Tool links resolve relative to THIS file (static root), so they are correct
// from the hub and from any tool page, locally and under the GitHub Pages
// sub-path alike.

const TOOL_LINKS = [
  { icon: "🧰", title: "All utilities", href: "./", keywords: ["hub", "home", "master", "index"] },
  {
    icon: "🔒",
    title: "Sanitize JSON",
    href: "sanitize/",
    keywords: ["mask", "redact", "log", "secrets"],
  },
  {
    icon: "🔍",
    title: "Decode Anything",
    href: "decode/",
    keywords: ["base64", "jwt", "hex", "gzip", "url"],
  },
  {
    icon: "🌴",
    title: "Leave Request",
    href: "leave/",
    keywords: ["leave", "holiday", "vacation", "time off", "annual", "sick", "wfh", "remote", "hr"],
  },
  {
    icon: "🔗",
    title: "Shortlink",
    href: "shortlink/",
    keywords: ["link", "url", "bookmark", "go", "redirect", "group"],
  },
  {
    icon: "📽️",
    title: "Slidedown",
    href: "slidedown/",
    keywords: ["slides", "presentation", "markdown", "deck"],
  },
  {
    icon: "🃏",
    title: "Scrum Poker",
    href: "https://meso-poker.onrender.com/",
    keywords: ["estimate", "planning", "team"],
  },
];

function normalizePath(pathname) {
  return pathname.replace(/index\.html$/, "");
}

/** Tool links (minus the page we are on) plus site-wide actions. */
function builtinCommands() {
  const here = normalizePath(location.pathname);
  const links = TOOL_LINKS
    .map((link) => ({ ...link, url: new URL(link.href, import.meta.url).href }))
    .filter((link) => normalizePath(new URL(link.url).pathname) !== here)
    .map((link) => ({
      icon: link.icon,
      title: link.title,
      hint: "open",
      keywords: link.keywords,
      run: () => {
        location.href = link.url;
      },
    }));
  const actions = [
    {
      icon: "🌓",
      title: "Toggle dark / light theme",
      hint: "action",
      keywords: ["theme", "dark", "light", "colour", "color"],
      run: () => document.getElementById("theme-toggle")?.click(),
    },
  ];
  // Only tool pages have a controls sidebar; skip the action on the hub.
  if (document.getElementById("controls-toggle")) {
    actions.push({
      icon: "◧",
      title: "Toggle controls sidebar",
      hint: "action",
      keywords: ["sidebar", "controls", "panel", "hide", "show", "collapse", "expand"],
      run: () => document.getElementById("controls-toggle")?.click(),
    });
  }
  return [...links, ...actions];
}

/* -------------------------------- overlay -------------------------------- */

let backdrop;
let input;
let list;
/** Commands currently rendered, in display order. */
let items = [];
let activeIndex = 0;
/** Element focused before the palette opened, restored on close. */
let restoreFocusTo;

function ensureOverlay() {
  if (backdrop) return;
  backdrop = document.createElement("div");
  backdrop.className = "palette-backdrop";
  backdrop.hidden = true;

  const panel = document.createElement("div");
  panel.className = "palette";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "Command palette");

  input = document.createElement("input");
  input.className = "palette-input";
  input.type = "text";
  input.placeholder = "Jump to a tool or run an action…";
  input.setAttribute("aria-label", "Search commands");
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-controls", "palette-list");

  list = document.createElement("div");
  list.className = "palette-list";
  list.id = "palette-list";
  list.setAttribute("role", "listbox");

  const foot = document.createElement("div");
  foot.className = "palette-foot";
  foot.textContent = "↑↓ to navigate · Enter to run · Esc to close";

  panel.append(input, list, foot);
  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);

  input.addEventListener("input", () => {
    activeIndex = 0;
    render(input.value);
  });
  input.addEventListener("keydown", onInputKeydown);
  // mousedown (not click) so the input never blurs when the backdrop is hit
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) close();
  });
}

function render(query) {
  items = filterCommands([...registeredCommands(), ...builtinCommands()], query);
  activeIndex = Math.min(activeIndex, Math.max(0, items.length - 1));
  list.innerHTML = "";
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "palette-empty";
    empty.textContent = "No matching command";
    list.appendChild(empty);
    input.removeAttribute("aria-activedescendant");
    return;
  }
  items.forEach((command, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "palette-item" + (index === activeIndex ? " is-active" : "");
    item.id = `palette-item-${index}`;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(index === activeIndex));

    const icon = document.createElement("span");
    icon.className = "palette-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = command.icon ?? "·";
    const title = document.createElement("span");
    title.className = "palette-title";
    title.textContent = command.title;
    item.append(icon, title);
    if (command.hint) {
      const hint = document.createElement("span");
      hint.className = "palette-hint-text";
      hint.textContent = command.hint;
      item.appendChild(hint);
    }

    // mousedown (not click) so the input keeps focus until the command runs
    item.addEventListener("mousedown", (event) => event.preventDefault());
    item.addEventListener("click", () => runCommand(command));
    list.appendChild(item);
  });
  input.setAttribute("aria-activedescendant", `palette-item-${activeIndex}`);
}

function setActive(index) {
  activeIndex = (index + items.length) % items.length;
  [...list.children].forEach((child, childIndex) => {
    child.classList.toggle("is-active", childIndex === activeIndex);
    child.setAttribute("aria-selected", String(childIndex === activeIndex));
  });
  list.children[activeIndex]?.scrollIntoView({ block: "nearest" });
  input.setAttribute("aria-activedescendant", `palette-item-${activeIndex}`);
}

function onInputKeydown(event) {
  if (event.key === "ArrowDown" && items.length > 0) {
    setActive(activeIndex + 1);
    event.preventDefault();
  } else if (event.key === "ArrowUp" && items.length > 0) {
    setActive(activeIndex - 1);
    event.preventDefault();
  } else if (event.key === "Enter" && items[activeIndex]) {
    runCommand(items[activeIndex]);
    event.preventDefault();
  }
}

function runCommand(command) {
  close();
  command.run?.();
}

function isOpen() {
  return backdrop !== undefined && !backdrop.hidden;
}

function open() {
  ensureOverlay();
  restoreFocusTo = document.activeElement;
  backdrop.hidden = false;
  input.value = "";
  activeIndex = 0;
  render("");
  input.focus();
}

function close() {
  if (!isOpen()) return;
  backdrop.hidden = true;
  if (restoreFocusTo && typeof restoreFocusTo.focus === "function") restoreFocusTo.focus();
  restoreFocusTo = undefined;
}

/* --------------------------------- wire ---------------------------------- */

document.addEventListener("keydown", (event) => {
  const isPaletteKey = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey &&
    event.key.toLowerCase() === "k";
  if (isPaletteKey) {
    event.preventDefault();
    if (isOpen()) close();
    else open();
  } else if (event.key === "Escape" && isOpen()) {
    close();
    event.preventDefault();
  }
});

// Optional discoverability button in the topbar (present on every page).
document.getElementById("palette-open")?.addEventListener("click", open);
