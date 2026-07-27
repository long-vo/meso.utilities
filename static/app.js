// meso.utilities — browser UI for the JSON sanitizer.
// Imports the SAME masking module the server uses, so results are identical and
// the payload never has to leave the page.
import { parseFields, runSanitize, runSanitizeLog } from "./sanitize.mjs";
import { buildRows, filterRows, linesAligned, presentLevels, rowHtml } from "./logview.mjs";
import { changedCount, pairLineDiff } from "./diff.mjs";
import { suggestSensitiveFields } from "./suggest.mjs";
import { sendHandoff, takeHandoff } from "./handoff.mjs";
import { registerCommands, TOOL_ICONS } from "./palette.js";
import { escapeHtml, highlightJson, makeToast } from "./ui.mjs";

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const els = {
  fields: /** @type {HTMLInputElement} */ ($("fields")),
  keepRange: /** @type {HTMLInputElement} */ ($("keep-range")),
  keepNum: /** @type {HTMLInputElement} */ ($("keep-num")),
  input: /** @type {HTMLTextAreaElement} */ ($("input")),
  inputError: $("input-error"),
  inputStatus: $("input-status"),
  output: $("output"),
  stats: $("stats"),
  chips: $("field-chips"),
  suggestBox: $("suggest-box"),
  suggestChips: $("suggest-chips"),
  minify: /** @type {HTMLInputElement} */ ($("minify")),
  diff: /** @type {HTMLInputElement} */ ($("diff")),
  copy: $("copy"),
  download: $("download"),
  loadExample: $("load-example"),
  clear: $("clear"),
  toast: $("toast"),
  modeJson: $("mode-json"),
  modeLog: $("mode-log"),
  maskAll: /** @type {HTMLInputElement} */ ($("mask-all")),
  redact: /** @type {HTMLInputElement} */ ($("redact")),
  logfile: /** @type {HTMLInputElement} */ ($("logfile")),
  logfileName: $("logfile-name"),
  sendDecode: $("send-decode"),
  outputBox: $("output-box"),
  logSearch: /** @type {HTMLInputElement} */ ($("log-search")),
  logSearchCount: $("log-search-count"),
  logPrev: $("log-prev"),
  logNext: $("log-next"),
  logLevels: $("log-levels"),
  logChanged: /** @type {HTMLInputElement} */ ($("log-changed")),
  logWrap: /** @type {HTMLInputElement} */ ($("log-wrap")),
};

/** "json" or "log". */
let mode = "json";
/** Name of the last attached log file, for the download filename. */
let logFileName = "";

/** Shared max for the "keep last N" slider and number input — must match the
 *  `max` on #keep-range / #keep-num in index.html. */
const KEEP_MAX = 12;
/** Input length (~1 MB) above which masking gets a busy hint and a longer
 *  debounce, since it runs synchronously on the main thread. */
const LARGE_INPUT = 1_000_000;

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

const LOG_EXAMPLE = [
  "[2026-07-10 04:12:39.550][INFO ][runtimelog.baloise-id]{application=baloise-id, client=172.31.138.81, requestId=15317}",
  "Received notification: class IdentificationNotificationRequest {",
  "    id: a0884b97-24df-4eaf-9077-d9f6b43629ee",
  "    tenantId: f346611c-6a34-4c32-b7d0-759f8299f8c4",
  "    status: VERIFICATION_CONFIRMED",
  "    language: null",
  "}",
  '2026-07-10 04:12:40.100 INFO request={"reqCtx":{"logonId":"L006344"},"avaloqPersId":7483881}',
].join("\n");

/** Latest rendered output text, for copy/download. */
let lastOutput = "";

/* --------------------------- rendering helpers --------------------------- */

const showToast = makeToast(els.toast);

/* ------------------------------- log view ------------------------------- */

/** Levels the reader has switched off. Empty means every level shows. */
const levelsOff = new Set();
/** Position of the highlighted search hit, and how many there are. */
let hitIndex = 0;
let hitCount = 0;

/**
 * Rows rendered at once. A log can run to hundreds of thousands of lines, and
 * each row is several DOM nodes; past this the view is truncated and the stats
 * row says so, rather than locking up the tab.
 */
const MAX_RENDER_ROWS = 4000;

/** The levels the chip row is currently built for, so it can be reused. */
let chipLevels = "";

/**
 * Level filter chips for the levels the current log actually uses. Toggling one
 * recomputes, which lands back here — so the chips are only rebuilt when the
 * set of levels itself changes. Re-creating them every time would drop keyboard
 * focus the moment a chip was activated.
 */
function renderLevelChips(present) {
  // One level is not a filter — nothing to narrow down to.
  els.logLevels.hidden = present.length < 2;

  if (present.join() === chipLevels) {
    for (const chip of els.logLevels.children) {
      const on = !levelsOff.has(chip.textContent ?? "");
      chip.classList.toggle("is-off", !on);
      chip.setAttribute("aria-pressed", String(on));
    }
    return;
  }

  chipLevels = present.join();
  els.logLevels.innerHTML = "";
  for (const level of present) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `chip chip-level level-${level.toLowerCase()}`;
    chip.textContent = level;
    const on = !levelsOff.has(level);
    chip.classList.toggle("is-off", !on);
    chip.setAttribute("aria-pressed", String(on));
    chip.addEventListener("click", () => {
      if (levelsOff.has(level)) levelsOff.delete(level);
      else levelsOff.add(level);
      compute();
    });
    els.logLevels.appendChild(chip);
  }
}

/** One line of the log view: a number gutter plus the line itself. */
function rowMarkup(row, diff) {
  const num = `<span class="log-n" aria-hidden="true">${row.n}</span>`;
  const text = `<span class="log-t">${rowHtml(row.text, row.hits)}</span>`;
  if (!(diff && row.changed)) return `<span class="log-row">${num}${text}</span>`;
  return `<span class="log-row is-del">${num}<span class="log-t">- ${
    escapeHtml(row.before)
  }</span></span>` +
    `<span class="log-row is-add">${num}<span class="log-t">+ ${
      rowHtml(row.text, row.hits)
    }</span></span>`;
}

/** Move the highlighted search hit and scroll it into view within the output. */
function markCurrentHit(scroll) {
  els.output.querySelector(".is-current")?.classList.remove("is-current");
  els.logSearchCount.textContent = els.logSearch.value === ""
    ? ""
    : hitCount === 0
    ? "no matches"
    : `${hitIndex + 1} of ${hitCount}`;
  if (hitCount === 0) return;
  const hit = els.output.querySelector(`[data-hit="${hitIndex}"]`);
  if (!hit) return; // beyond the render cap
  hit.classList.add("is-current");
  // "nearest" scrolls the <pre> minimally instead of jumping the whole page.
  if (scroll) hit.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function stepHit(delta) {
  if (hitCount === 0) return;
  hitIndex = (hitIndex + delta + hitCount) % hitCount;
  markCurrentHit(true);
}

/**
 * Render the masked log with its reading aids applied. Purely presentational:
 * `lastOutput` (what Copy and Download use) is the whole masked log either way.
 * @returns {string} the stats fragment describing what was filtered out
 */
function renderLogView(beforeText, afterText) {
  const rows = buildRows(beforeText, afterText);
  const present = presentLevels(rows);
  renderLevelChips(present);

  // Both change-flag features read line N against line N. If masking did not
  // preserve the line count, that pairing is meaningless — turn them off and
  // say so rather than flag half the log as changed.
  const aligned = linesAligned(beforeText, afterText);
  els.logChanged.disabled = !aligned;
  els.diff.disabled = !aligned;

  const enabled = present.filter((level) => !levelsOff.has(level));
  const filtering = enabled.length !== present.length;
  // An empty list means "no filter" to filterRows, so every-level-off is
  // handled here rather than silently showing everything.
  const view = filtering && enabled.length === 0
    ? { rows: [], shown: 0, total: rows.length, matches: 0 }
    : filterRows(rows, {
      levels: filtering ? enabled : null,
      onlyChanged: aligned && els.logChanged.checked,
      query: els.logSearch.value,
    });

  hitCount = view.matches;
  if (hitIndex >= hitCount) hitIndex = 0;

  const capped = view.rows.slice(0, MAX_RENDER_ROWS);
  // Size the gutter from the widest number on screen; a per-row max-content
  // track would give every row its own width and stagger the numbers.
  const widest = capped.length ? String(capped[capped.length - 1].n).length : 1;
  els.outputBox.style.setProperty("--log-gutter", `${widest}ch`);
  const diff = aligned && els.diff.checked;
  els.output.innerHTML = capped.length === 0
    ? `<span class="j-null">// no lines match the current filters</span>`
    : capped.map((row) => rowMarkup(row, diff)).join("");
  markCurrentHit(false);

  const changed = rows.filter((row) => row.changed).length;
  return (view.shown !== view.total
    ? `<span><b>${view.shown}</b> of <b>${view.total}</b> lines shown</span>`
    : "") +
    (diff ? `<span><b>${changed}</b> line${changed === 1 ? "" : "s"} changed</span>` : "") +
    (aligned
      ? ""
      : `<span class="warn">masking re-flowed this log, so Diff and Only changed are off</span>`) +
    (view.shown > MAX_RENDER_ROWS
      ? `<span class="warn">view truncated to the first ${MAX_RENDER_ROWS} lines</span>`
      : "");
}

/** Blank the log view's own state — used when the log input is emptied. */
function resetLogView() {
  hitIndex = 0;
  hitCount = 0;
  els.logLevels.hidden = true;
  els.logLevels.innerHTML = "";
  chipLevels = "";
  els.logSearchCount.textContent = "";
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

/**
 * Render a before/after line diff into the output — masking changes values in
 * place, so line N pairs with line N — and append a changed-line count to the
 * stats row (call after the stats are rendered).
 */
function renderDiff(beforeText, afterText) {
  const rows = pairLineDiff(beforeText, afterText);
  els.output.innerHTML = rows
    .map((row) =>
      row.changed
        ? `<span class="d-del">- ${escapeHtml(row.before)}</span>\n<span class="d-add">+ ${
          escapeHtml(row.after)
        }</span>`
        : `  ${escapeHtml(row.after)}`
    )
    .join("\n");
  const changed = changedCount(rows);
  els.stats.innerHTML += `<span><b>${changed}</b> line${changed === 1 ? "" : "s"} changed</span>`;
}

/** Chips for keys that look sensitive but aren't masked yet — click to add. */
function renderSuggestions(suggestions) {
  els.suggestBox.hidden = suggestions.length === 0;
  els.suggestChips.innerHTML = "";
  for (const { name, reason } of suggestions) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip chip-add";
    chip.textContent = `+ ${name}`;
    chip.title = `${reason} — click to add it to the mask list`;
    chip.addEventListener("click", () => {
      const current = els.fields.value.trim().replace(/[,\s]+$/, "");
      els.fields.value = current === "" ? name : `${current}, ${name}`;
      compute();
    });
    els.suggestChips.appendChild(chip);
  }
}

/* ------------------------------ core cycle ------------------------------ */

function compute() {
  // Only the log path disables these (see renderLogView), so clear the flags
  // before every run rather than leaving a stale one behind on a mode switch.
  els.diff.disabled = false;
  els.logChanged.disabled = false;

  if (mode === "log") {
    computeLog();
    return;
  }

  const jsonText = els.input.value;
  const fields = parseFields(els.fields.value);

  if (jsonText.trim() === "") {
    renderChips(fields, null);
    renderSuggestions([]);
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
    renderSuggestions([]);
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
  renderStats(result.stats, result.fields);
  const parsed = JSON.parse(jsonText);
  if (els.diff.checked) {
    // The diff always compares pretty vs pretty so lines pair up; Minify
    // still applies to Copy/Download.
    renderDiff(JSON.stringify(parsed, null, 2), result.pretty);
  } else {
    els.output.innerHTML = highlightJson(pretty);
  }
  renderSuggestions(suggestSensitiveFields(parsed, result.fields));
}

/** Log mode: mask every JSON block embedded in the log text. */
function computeLog() {
  const text = els.input.value;
  const maskAll = els.maskAll.checked;
  const fields = parseFields(els.fields.value);

  els.input.classList.remove("invalid");
  els.inputError.textContent = "";
  renderChips(maskAll ? [] : fields, null);
  renderSuggestions([]);

  if (text.trim() === "") {
    els.inputStatus.textContent = "";
    els.inputStatus.className = "status";
    els.output.innerHTML = `<span class="j-null">// attach or paste a log to begin</span>`;
    els.stats.innerHTML = "";
    lastOutput = "";
    resetLogView();
    return;
  }

  const result = runSanitizeLog(text, {
    keepLast: els.keepNum.value,
    maskAll,
    redact: els.redact.checked,
    fields,
  });
  lastOutput = result.text;

  const { blocks, maskedValues, patternHits } = result.stats;
  const total = maskedValues + patternHits;
  els.inputStatus.textContent = total ? `${total} masked` : "nothing to mask";
  els.inputStatus.className = total ? "status ok" : "status";

  // The view renders first: its stats depend on what the filters left visible.
  const viewStats = renderLogView(text, result.text);
  els.stats.innerHTML =
    `<span>Masked <b>${maskedValues}</b> value${maskedValues === 1 ? "" : "s"}</span>` +
    (blocks ? `<span><b>${blocks}</b> block${blocks === 1 ? "" : "s"}</span>` : "") +
    (patternHits
      ? `<span><b>${patternHits}</b> ID${patternHits === 1 ? "" : "s"} redacted</span>`
      : "") +
    viewStats;
}

/** Switch between JSON and Log-file modes. */
function setMode(next) {
  mode = next;
  document.body.setAttribute("data-mode", next);
  const isLog = next === "log";
  els.modeLog.classList.toggle("is-active", isLog);
  els.modeJson.classList.toggle("is-active", !isLog);
  els.modeLog.setAttribute("aria-pressed", String(isLog));
  els.modeJson.setAttribute("aria-pressed", String(!isLog));
  els.input.placeholder = isLog
    ? "Paste log text, or attach a .log file above…"
    : '{ "customer": { "lastName": "Weber", "email": "jara@example.com" } }';
  // In log mode the field list only applies when "mask all" is off.
  els.fields.disabled = isLog && els.maskAll.checked;
  compute();
}

/**
 * Debounce recompute so typing stays snappy. Masking is synchronous, so for
 * large inputs (~1 MB+) lengthen the debounce and show a "processing…" hint —
 * the recompute still blocks briefly, but it no longer fires on every keystroke.
 */
let debounceTimer;
function scheduleCompute() {
  clearTimeout(debounceTimer);
  const large = els.input.value.length >= LARGE_INPUT;
  if (large) {
    els.inputStatus.textContent = "processing…";
    els.inputStatus.className = "status";
  }
  debounceTimer = setTimeout(compute, large ? 500 : 110);
}

/* ------------------------------- actions -------------------------------- */

function loadExample() {
  if (mode === "log") {
    els.input.value = LOG_EXAMPLE;
    logFileName = "";
    els.logfileName.textContent = "or paste log text below";
    compute();
    return;
  }
  els.fields.value = EXAMPLE.fields;
  els.keepNum.value = String(EXAMPLE.keepLast);
  els.keepRange.value = String(Math.min(KEEP_MAX, EXAMPLE.keepLast));
  els.input.value = JSON.stringify(EXAMPLE.json, null, 2);
  compute();
}

function clearAll() {
  els.input.value = "";
  els.fields.value = "";
  logFileName = "";
  els.logfileName.textContent = "or paste log text below";
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
  const isLog = mode === "log";
  const name = isLog
    ? (logFileName ? logFileName.replace(/\.[^.]+$/, "") + ".masked.log" : "masked.log")
    : "sanitized.json";
  const blob = new Blob([lastOutput], { type: isLog ? "text/plain" : "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast(`Downloaded ${name}`);
}

/** Read a log file client-side (from the picker or a drop) and switch to Log mode. */
async function loadLogFile(file) {
  logFileName = file.name;
  els.logfileName.textContent = `${file.name} · ${(file.size / 1024).toFixed(0)} KB`;
  els.input.value = await file.text();
  if (mode === "log") compute();
  else setMode("log");
}

/** Hand the current result to another tool — its page consumes it on load. */
function sendResultTo(target) {
  if (!lastOutput) return;
  if (!sendHandoff(sessionStorage, target, lastOutput, "Sanitize JSON")) {
    showToast("Result too large to hand off — use Copy instead");
    return;
  }
  location.href = `../${target}/`;
}

/* --------------------------------- wire --------------------------------- */

els.fields.addEventListener("input", scheduleCompute);
els.input.addEventListener("input", scheduleCompute);
els.minify.addEventListener("change", compute);
els.diff.addEventListener("change", compute);

// Keep the slider and number input in sync, both trigger a recompute.
els.keepRange.addEventListener("input", () => {
  els.keepNum.value = els.keepRange.value;
  scheduleCompute();
});
els.keepNum.addEventListener("input", () => {
  const n = parseInt(els.keepNum.value, 10);
  if (Number.isNaN(n)) {
    // Empty or partial entry — don't fight the typist; the slider rests at 0.
    els.keepRange.value = "0";
    scheduleCompute();
    return;
  }
  const clamped = Math.max(0, Math.min(KEEP_MAX, n));
  if (clamped !== n) els.keepNum.value = String(clamped); // show the clamp, don't silently pin
  els.keepRange.value = String(clamped);
  scheduleCompute();
});

els.modeJson.addEventListener("click", () => setMode("json"));
els.modeLog.addEventListener("click", () => setMode("log"));

els.maskAll.addEventListener("change", () => {
  els.fields.disabled = mode === "log" && els.maskAll.checked;
  compute();
});
els.redact.addEventListener("change", compute);

// Log view. Every one of these is view-only — Copy and Download stay whole.
els.logSearch.addEventListener("input", () => {
  hitIndex = 0;
  compute();
  markCurrentHit(true);
});
els.logSearch.addEventListener("keydown", (e) => {
  const key = /** @type {KeyboardEvent} */ (e);
  if (key.key !== "Enter") return;
  key.preventDefault();
  stepHit(key.shiftKey ? -1 : 1);
});
els.logPrev.addEventListener("click", () => stepHit(-1));
els.logNext.addEventListener("click", () => stepHit(1));
els.logChanged.addEventListener("change", compute);
els.logWrap.addEventListener("change", () => {
  els.outputBox.classList.toggle("is-wrap", els.logWrap.checked);
});

// Attaching a file via the picker reads it client-side and switches to Log mode.
els.logfile.addEventListener("change", async () => {
  const file = els.logfile.files && els.logfile.files[0];
  if (!file) return;
  await loadLogFile(file);
  els.logfile.value = ""; // allow re-selecting the same file
});

// Drop a log file anywhere on the editor panel, not just via the picker. Only
// intercept file drags, so dragging selected text into the textarea still works.
const editorPanel = /** @type {HTMLElement} */ (document.querySelector(".panel.editor"));
editorPanel.addEventListener("dragover", (e) => {
  if (!(/** @type {DragEvent} */ (e)).dataTransfer?.types.includes("Files")) return;
  e.preventDefault();
  editorPanel.classList.add("drag-over");
});
editorPanel.addEventListener("dragleave", (e) => {
  const leaving = /** @type {Node | null} */ ((/** @type {DragEvent} */ (e)).relatedTarget);
  if (!editorPanel.contains(leaving)) editorPanel.classList.remove("drag-over");
});
editorPanel.addEventListener("drop", (e) => {
  const dropped = (/** @type {DragEvent} */ (e)).dataTransfer;
  const file = dropped?.files && dropped.files[0];
  if (!file) return;
  e.preventDefault();
  editorPanel.classList.remove("drag-over");
  loadLogFile(file);
});

els.loadExample.addEventListener("click", loadExample);
els.clear.addEventListener("click", clearAll);
els.copy.addEventListener("click", copyResult);
els.download.addEventListener("click", downloadResult);
els.sendDecode.addEventListener("click", () => sendResultTo("decode"));
// (theme toggle is wired by the shared theme.js module)

registerCommands([
  { icon: "📋", title: "Copy result", hint: "action", run: copyResult },
  { icon: "⬇️", title: "Download result", hint: "action", run: downloadResult },
  {
    icon: "🔁",
    title: "Switch JSON / Log mode",
    hint: "action",
    keywords: ["mode", "log", "json"],
    run: () => setMode(mode === "log" ? "json" : "log"),
  },
  {
    icon: "🔀",
    title: "Toggle diff view",
    hint: "action",
    keywords: ["diff", "changes", "compare", "before", "after"],
    run: () => {
      els.diff.checked = !els.diff.checked;
      compute();
    },
  },
  { icon: "✨", title: "Load example", hint: "action", run: loadExample },
  {
    icon: "🔎",
    title: "Find in the masked log",
    hint: "log",
    keywords: ["search", "find", "log", "highlight"],
    run: () => {
      if (mode !== "log") setMode("log");
      els.logSearch.focus();
      els.logSearch.select();
    },
  },
  {
    icon: "🎚️",
    title: "Toggle only-changed lines",
    hint: "log",
    keywords: ["filter", "changed", "masked", "log"],
    run: () => {
      if (mode !== "log") setMode("log");
      els.logChanged.checked = !els.logChanged.checked;
      compute();
    },
  },
  {
    icon: "↩️",
    title: "Toggle line wrap",
    hint: "log",
    keywords: ["wrap", "soft", "lines", "log"],
    run: () => {
      els.logWrap.checked = !els.logWrap.checked;
      els.outputBox.classList.toggle("is-wrap", els.logWrap.checked);
    },
  },
  {
    icon: TOOL_ICONS.decode,
    title: "Send result to Decode Anything",
    hint: "action",
    run: () => sendResultTo("decode"),
  },
]);

// An incoming handoff from another tool wins over the default example. The
// mode follows the payload: parseable JSON → JSON mode, anything else → Log.
function receiveHandoff() {
  const handoff = takeHandoff(sessionStorage, "sanitize");
  if (!handoff) return false;
  els.input.value = handoff.text;
  let isJson = true;
  try {
    JSON.parse(handoff.text);
  } catch {
    isJson = false;
  }
  const nextMode = isJson ? "json" : "log";
  if (mode !== nextMode) setMode(nextMode); // setMode recomputes
  else compute();
  showToast(`Received from ${handoff.from || "another tool"}`);
  return true;
}

// Re-check on back/forward-cache restores too (Send to → Back → Send to again
// revives this page without re-running the script).
globalThis.addEventListener("pageshow", (event) => {
  if (event.persisted) receiveHandoff();
});

if (!receiveHandoff()) {
  // Start with the example so the page looks alive.
  loadExample();
}
