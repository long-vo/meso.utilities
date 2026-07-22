// meso.utilities — show/hide the controls sidebar. Loaded on each tool page
// next to resize.js. A topbar button (#controls-toggle) collapses the sidebar,
// reflowing the editor/result to full width; the state is remembered per tool
// in localStorage and applied before first paint by the inline head script
// (keyed on the same value), so a collapsed sidebar never flashes on load.
// Ctrl/⌘ B toggles it from the keyboard. No-ops on pages without a `.controls`
// sidebar (e.g. the hub).
import { parseHidden, serializeHidden, storageKey } from "./sidebar.mjs";

const ATTR = "data-controls-collapsed";
const root = document.documentElement;
const layout = document.querySelector(".layout");
const controls = layout ? layout.querySelector(".controls") : null;
const button = document.getElementById("controls-toggle");

if (layout && controls && button) {
  const key = storageKey(location.pathname);

  // Start from whatever the pre-paint script decided, then trust storage.
  let hidden = root.hasAttribute(ATTR);
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null) hidden = parseHidden(saved);
  } catch {
    /* storage unavailable; fall back to the current DOM state */
  }

  const apply = () => {
    root.toggleAttribute(ATTR, hidden);
    button.setAttribute("aria-expanded", String(!hidden));
    const verb = hidden ? "Show" : "Hide";
    button.title = `${verb} controls`;
    button.setAttribute("aria-label", `${verb} controls sidebar`);
  };

  const save = () => {
    try {
      localStorage.setItem(key, serializeHidden(hidden));
    } catch {
      /* storage unavailable; the choice just won't persist */
    }
  };

  const toggle = () => {
    // Move focus off the sidebar before it is hidden, so focus is never left
    // stranded on a display:none element.
    if (!hidden && controls.contains(document.activeElement)) button.focus();
    hidden = !hidden;
    apply();
    save();
  };

  apply();
  button.addEventListener("click", toggle);

  document.addEventListener("keydown", (event) => {
    const combo = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey &&
      event.key.toLowerCase() === "b";
    if (!combo) return;
    event.preventDefault();
    toggle();
  });
}
