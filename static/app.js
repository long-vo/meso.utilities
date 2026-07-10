// meso.utilities — browser UI for the JSON sanitizer.
// Imports the SAME masking module the server uses, so results are identical and
// the payload never has to leave the page.
import { parseFields, runSanitize } from "/sanitize.mjs";

const $ = (id) => document.getElementById(id);

const els = {
  fields: $("fields"),
  keepRange: $("keep-range"),
  keepNum: $("keep-num"),
  input: $("input"),
  inputError: $("input-error"),
  inputStatus: $("input-status"),
  output: $("output"),
  stats: $("stats"),
  chips: $("field-chips"),
  minify: $("minify"),
  copy: $("copy"),
  download: $("download"),
  loadExample: $("load-example"),
  clear: $("clear"),
  themeToggle: $("theme-toggle"),
  themeIcon: document.querySelector(".theme-icon"),
  toast: $("toast"),
};

const EXAMPLE = {
  fields: "lastName, email, phoneNumber, token, iban",
  keepLast: 4,
  json: {
    customer: {
      firstName: "Jara",
      lastName: "Weber",
      email: "jara.weber@example.com",
      phoneNumber: "+41 79 123 45 67",
      verified: true,
      addresses: [
        { type: "home", city: "Bern", zip: "3000" },
      ],
    },
    account: {
      iban: "CH93 0076 2011 6238 5295 7",
      balance: 15230.75,
      token: "sk_live_9f8b7c6d5e4f3a2b1c0d",
    },
    auditTrail: [
      { actor: "system", email: "ops@example.com" },
    ],
  },
};

/** Latest rendered output text, for copy/download. */
let lastOutput = "";

/* --------------------------- rendering helpers --------------------------- */

/** Escape HTML so arbitrary JSON text is safe to inject. */
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Lightweight JSON syntax highlighter. Masked string values (those starting
 * with one or more "*") get a distinct colour so you can see what was hidden.
 */
function highlightJson(jsonString) {
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

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove("show"), 1600);
}

function renderChips(fields, matchedLower) {
  els.chips.innerHTML = "";
  for (const name of fields) {
    const chip = document.createElement("span");
    chip.className = "chip";
    if (matchedLower) {
      chip.classList.add(matchedLower.has(name.toLowerCase()) ? "matched" : "unused");
    }
    chip.textContent = name;
    els.chips.appendChild(chip);
  }
}

function renderStats(stats, fields) {
  const matched = stats.matchedKeys.length;
  const distinctFields = new Set(fields.map((f) => f.toLowerCase())).size;
  els.stats.innerHTML =
    `<span>Masked <b>${stats.maskedValues}</b> value${stats.maskedValues === 1 ? "" : "s"}</span>` +
    `<span><b>${matched}</b> of <b>${distinctFields}</b> field${
      distinctFields === 1 ? "" : "s"
    } matched</span>` +
    (stats.matchedKeys.length
      ? `<span>Keys: ${stats.matchedKeys.map((k) => escapeHtml(k)).join(", ")}</span>`
      : "");
}

/* ------------------------------ core cycle ------------------------------ */

function compute() {
  const jsonText = els.input.value;
  const fields = parseFields(els.fields.value);

  if (jsonText.trim() === "") {
    renderChips(fields, null);
    els.input.classList.remove("invalid");
    els.inputError.textContent = "";
    els.inputStatus.textContent = "";
    els.inputStatus.className = "status";
    els.output.innerHTML = `<span class="j-null">// paste a JSON payload to begin</span>`;
    els.stats.innerHTML = "";
    lastOutput = "";
    return;
  }

  const result = runSanitize(jsonText, els.fields.value, els.keepNum.value);

  if (!result.ok) {
    renderChips(fields, null);
    els.input.classList.add("invalid");
    els.inputError.textContent = `Invalid JSON: ${result.error}`;
    els.inputStatus.textContent = "invalid";
    els.inputStatus.className = "status bad";
    return;
  }

  els.input.classList.remove("invalid");
  els.inputError.textContent = "";
  els.inputStatus.textContent = "valid";
  els.inputStatus.className = "status ok";

  const matchedLower = new Set(result.stats.matchedKeys.map((k) => k.toLowerCase()));
  renderChips(fields, matchedLower);

  const pretty = els.minify.checked ? JSON.stringify(result.sanitized) : result.pretty;
  lastOutput = pretty;
  els.output.innerHTML = highlightJson(pretty);
  renderStats(result.stats, result.fields);
}

/** Debounce recompute so typing stays snappy. */
let debounceTimer;
function scheduleCompute() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(compute, 110);
}

/* ------------------------------- actions -------------------------------- */

function loadExample() {
  els.fields.value = EXAMPLE.fields;
  els.keepNum.value = String(EXAMPLE.keepLast);
  els.keepRange.value = String(Math.min(12, EXAMPLE.keepLast));
  els.input.value = JSON.stringify(EXAMPLE.json, null, 2);
  compute();
}

function clearAll() {
  els.input.value = "";
  els.fields.value = "";
  compute();
  els.input.focus();
}

async function copyResult() {
  if (!lastOutput) return;
  try {
    await navigator.clipboard.writeText(lastOutput);
    showToast("Copied to clipboard");
  } catch {
    showToast("Copy failed — select and copy manually");
  }
}

function downloadResult() {
  if (!lastOutput) return;
  const blob = new Blob([lastOutput], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "sanitized.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast("Downloaded sanitized.json");
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  els.themeIcon.textContent = theme === "dark" ? "🌙" : "☀️";
  try {
    localStorage.setItem("meso-theme", theme);
  } catch {
    /* storage may be unavailable; theme just won't persist */
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  applyTheme(current === "dark" ? "light" : "dark");
}

/* --------------------------------- wire --------------------------------- */

els.fields.addEventListener("input", scheduleCompute);
els.input.addEventListener("input", scheduleCompute);
els.minify.addEventListener("change", compute);

// Keep the slider and number input in sync, both trigger a recompute.
els.keepRange.addEventListener("input", () => {
  els.keepNum.value = els.keepRange.value;
  scheduleCompute();
});
els.keepNum.addEventListener("input", () => {
  const n = Math.max(0, parseInt(els.keepNum.value, 10) || 0);
  els.keepRange.value = String(Math.min(12, n));
  scheduleCompute();
});

els.loadExample.addEventListener("click", loadExample);
els.clear.addEventListener("click", clearAll);
els.copy.addEventListener("click", copyResult);
els.download.addEventListener("click", downloadResult);
els.themeToggle.addEventListener("click", toggleTheme);

// Restore saved theme, then start with the example so the page looks alive.
try {
  const saved = localStorage.getItem("meso-theme");
  if (saved === "light" || saved === "dark") applyTheme(saved);
} catch {
  /* ignore */
}
loadExample();
