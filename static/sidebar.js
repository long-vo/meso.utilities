// meso.utilities — show/hide the side panels. Loaded on each tool page next to
// resize.js. Two topbar buttons collapse a panel each: #controls-toggle the
// controls sidebar, #rail-toggle the right-hand rail (templates, favourites,
// legend, filters — only the tools that have one). Either way the editor/result
// reflow into the freed space; the state is remembered per tool in localStorage
// and applied before first paint by the inline head script (keyed on the same
// values), so a collapsed panel never flashes on load. Ctrl/⌘ B toggles the
// sidebar, Ctrl/⌘ Shift B the rail. No-ops on pages without the panel in
// question (the hub has neither; Decode and Sanitize have no rail).
import { parseHidden, railStorageKey, serializeHidden, storageKey } from "./sidebar.mjs";

const root = document.documentElement;
const layout = document.querySelector(".layout");

/**
 * Wire one collapse toggle: button ⇄ `<html>` attribute ⇄ localStorage.
 * `label` reads as "Hide <label>" on the button, `aria` as "Hide <aria>".
 */
function setup({ panel, button, attr, key, label, aria, isCombo }) {
  if (!panel || !button) return;

  // Start from whatever the pre-paint script decided, then trust storage.
  let hidden = root.hasAttribute(attr);
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null) hidden = parseHidden(saved);
  } catch {
    /* storage unavailable; fall back to the current DOM state */
  }

  const apply = () => {
    root.toggleAttribute(attr, hidden);
    button.setAttribute("aria-expanded", String(!hidden));
    const verb = hidden ? "Show" : "Hide";
    button.title = `${verb} ${label}`;
    button.setAttribute("aria-label", `${verb} ${aria}`);
  };

  const save = () => {
    try {
      localStorage.setItem(key, serializeHidden(hidden));
    } catch {
      /* storage unavailable; the choice just won't persist */
    }
  };

  const toggle = () => {
    // Move focus off the panel before it is hidden, so focus is never left
    // stranded on a display:none element.
    if (!hidden && panel.contains(document.activeElement)) button.focus();
    hidden = !hidden;
    apply();
    save();
  };

  apply();
  button.addEventListener("click", toggle);

  document.addEventListener("keydown", (event) => {
    if (!isCombo(event)) return;
    event.preventDefault();
    toggle();
  });

  // The panel itself can be [hidden] by the page (Availability keeps its rail
  // out until a workbook is imported); there is nothing to toggle then, so the
  // button follows it.
  const syncButton = () => {
    button.hidden = panel.hidden;
  };
  syncButton();
  new MutationObserver(syncButton).observe(panel, {
    attributes: true,
    attributeFilter: ["hidden"],
  });
}

if (layout) {
  setup({
    panel: layout.querySelector(".controls"),
    button: document.getElementById("controls-toggle"),
    attr: "data-controls-collapsed",
    key: storageKey(location.pathname),
    label: "controls",
    aria: "controls sidebar",
    isCombo: (event) =>
      (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey &&
      event.key.toLowerCase() === "b",
  });

  const rail = /** @type {HTMLElement | null} */ (layout.querySelector(".rail"));
  // Each page names its own rail ("templates", "favourites", …).
  const railLabel = (rail && rail.dataset.railLabel) || "side";
  setup({
    panel: rail,
    button: document.getElementById("rail-toggle"),
    attr: "data-rail-collapsed",
    key: railStorageKey(location.pathname),
    label: `${railLabel} panel`,
    aria: `${railLabel} panel`,
    isCombo: (event) =>
      (event.metaKey || event.ctrlKey) && !event.altKey && event.shiftKey &&
      event.key.toLowerCase() === "b",
  });
}
