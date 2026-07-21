// meso.utilities — shared UI helpers used by the hub and every no-build tool.
// Dual-consumption: imported unchanged by the browser `app.js` files and
// exercised by `src/ui.test.ts`. Nothing here touches the DOM at import time
// (`makeToast` only does so when its returned function runs), so the module
// loads cleanly in Deno for the parity tests.

/** Escape HTML so arbitrary text is safe to inject via innerHTML. */
export function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Lightweight JSON syntax highlighter. Masked string values (those starting
 * with one or more "*") get a distinct colour so redactions stand out against
 * the rest of the payload.
 */
export function highlightJson(jsonString) {
  const esc = escapeHtml(jsonString);
  return esc.replace(
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      let cls = "j-num";
      if (match.startsWith("&quot;") || match.startsWith('"')) {
        if (/:\s*$/.test(match)) {
          cls = "j-key";
        } else if (/^(?:&quot;|")\*+/.test(match)) {
          cls = "j-masked";
        } else {
          cls = "j-str";
        }
      } else if (match === "true" || match === "false") {
        cls = "j-bool";
      } else if (match === "null") {
        cls = "j-null";
      }
      return `<span class="${cls}">${match}</span>`;
    },
  );
}

/** Milliseconds a toast stays visible — unified across the hub and all tools. */
const TOAST_MS = 2400;
/** Toasts carrying an action stay longer so there's time to click it. */
const TOAST_ACTION_MS = 6000;

/**
 * Build a `showToast(message, action?)` bound to one toast element. Each page
 * owns its own `#toast` node, so the element (not a global) is captured in the
 * closure; a missing element makes the toast a no-op. The optional
 * `{ label, onAction }` renders a button (e.g. Undo) that hides the toast and
 * runs the callback.
 */
export function makeToast(el) {
  let timer;
  return function showToast(message, action) {
    if (!el) return;
    el.textContent = message;
    if (action && typeof action.onAction === "function") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "toast-action";
      btn.textContent = action.label;
      btn.addEventListener("click", () => {
        clearTimeout(timer);
        el.classList.remove("show");
        action.onAction();
      });
      el.append(" ", btn);
    }
    el.classList.add("show");
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.remove("show"), action ? TOAST_ACTION_MS : TOAST_MS);
  };
}
