// meso.utilities — makes the controls sidebar resizable. Loaded on each tool
// page next to theme.js. A handle on the sidebar's right edge drags the grid's
// first column width (the `--controls-w` custom property), clamped and
// remembered per tool in localStorage. No-ops on pages without a `.controls`
// sidebar (e.g. the hub).
import { clampWidth, DEFAULT_WIDTH, MAX_WIDTH, MIN_WIDTH, STEP, storageKey } from "./resize.mjs";

const layout = document.querySelector(".layout");
const controls = layout ? layout.querySelector(".controls") : null;

if (layout && controls) {
  const key = storageKey(location.pathname);

  const handle = document.createElement("div");
  handle.className = "controls-resizer";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", "Resize sidebar");
  handle.setAttribute("aria-valuemin", String(MIN_WIDTH));
  handle.setAttribute("aria-valuemax", String(MAX_WIDTH));
  handle.tabIndex = 0;
  controls.appendChild(handle);

  let width = DEFAULT_WIDTH;

  const apply = (w) => {
    layout.style.setProperty("--controls-w", `${w}px`);
    handle.setAttribute("aria-valuenow", String(w));
  };

  const save = (w) => {
    try {
      localStorage.setItem(key, String(w));
    } catch {
      /* storage may be unavailable; width just won't persist */
    }
  };

  const set = (w, persist) => {
    width = clampWidth(w);
    apply(width);
    if (persist) save(width);
  };

  // Restore the saved width (empty or corrupt values fall back to the default).
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null) width = clampWidth(saved);
  } catch {
    /* ignore */
  }
  apply(width);

  // --- pointer drag ---
  let dragging = false;
  let startX = 0;
  let startW = width;
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    dragging = true;
    startX = e.clientX;
    startW = width;
    document.body.classList.add("is-resizing");
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    set(startW + (e.clientX - startX), false);
  });
  handle.addEventListener("pointerup", (e) => {
    if (!dragging) return;
    dragging = false;
    handle.releasePointerCapture(e.pointerId);
    document.body.classList.remove("is-resizing");
    save(width);
  });

  // --- keyboard ---
  handle.addEventListener("keydown", (e) => {
    let next = width;
    if (e.key === "ArrowLeft") next = width - STEP;
    else if (e.key === "ArrowRight") next = width + STEP;
    else if (e.key === "Home") next = MIN_WIDTH;
    else if (e.key === "End") next = MAX_WIDTH;
    else return;
    e.preventDefault();
    set(next, true);
  });

  // Double-click restores the default width.
  handle.addEventListener("dblclick", () => set(DEFAULT_WIDTH, true));
}
