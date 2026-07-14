// meso.utilities — browser UI for the JSON sanitizer.
// Imports the SAME masking module the server uses, so results are identical and
// the payload never has to leave the page.
import { parseFields, runSanitize, runSanitizeLog } from "./sanitize.mjs";
import { changedCount, pairLineDiff } from "./diff.mjs";
import { suggestSensitiveFields } from "./suggest.mjs";
import { sendHandoff, takeHandoff } from "./handoff.mjs";
import { registerCommands } from "./palette.js";
import { escapeHtml, highlightJson, makeToast } from "./ui.mjs";

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
  suggestBox: $("suggest-box"),
  suggestChips: $("suggest-chips"),
  minify: $("minify"),
  diff: $("diff"),
  copy: $("copy"),
  download: $("download"),
  loadExample: $("load-example"),
  clear: $("clear"),
  toast: $("toast"),
  modeJson: $("mode-json"),
  modeLog: $("mode-log"),
  maskAll: $("mask-all"),
  redact: $("redact"),
  logfile: $("logfile"),
  logfileName: $("logfile-name"),
  sendDecode: $("send-decode"),
  // REST hidden — restore alongside the send-rest button and its listener/command.
  // sendRest: $("send-rest"),
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

/**
 * Highlight a masked log: escape everything, then colour the masked values
 * (quoted strings that start with one or more "*") so the redactions stand out
 * against the untouched log text.
 */
function highlightLog(text) {
  // Highlight any run of 2+ asterisks plus any revealed tail (quoted or bare),
  // so redactions stand out against the untouched log text.
  return escapeHtml(text).replace(
    /\*{2,}[\w.@:+/-]*/g,
    (match) => `<span class="j-masked">${match}</span>`,
  );
}

const showToast = makeToast(els.toast);

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
  els.stats.innerHTML =
    `<span>Masked <b>${maskedValues}</b> value${maskedValues === 1 ? "" : "s"}</span>` +
    (blocks ? `<span><b>${blocks}</b> block${blocks === 1 ? "" : "s"}</span>` : "") +
    (patternHits
      ? `<span><b>${patternHits}</b> ID${patternHits === 1 ? "" : "s"} redacted</span>`
      : "");

  if (els.diff.checked) renderDiff(text, result.text);
  else els.output.innerHTML = highlightLog(result.text);
}

/** Switch between JSON and Log-file modes. */
function setMode(next) {
  mode = next;
  document.body.setAttribute("data-mode", next);
  const isLog = next === "log";
  els.modeLog.classList.toggle("is-active", isLog);
  els.modeJson.classList.toggle("is-active", !isLog);
  els.modeLog.setAttribute("aria-selected", String(isLog));
  els.modeJson.setAttribute("aria-selected", String(!isLog));
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

// Attaching a file via the picker reads it client-side and switches to Log mode.
els.logfile.addEventListener("change", async () => {
  const file = els.logfile.files && els.logfile.files[0];
  if (!file) return;
  await loadLogFile(file);
  els.logfile.value = ""; // allow re-selecting the same file
});

// Drop a log file anywhere on the editor panel, not just via the picker. Only
// intercept file drags, so dragging selected text into the textarea still works.
const editorPanel = document.querySelector(".panel.editor");
editorPanel.addEventListener("dragover", (e) => {
  if (!e.dataTransfer.types.includes("Files")) return;
  e.preventDefault();
  editorPanel.classList.add("drag-over");
});
editorPanel.addEventListener("dragleave", (e) => {
  if (!editorPanel.contains(e.relatedTarget)) editorPanel.classList.remove("drag-over");
});
editorPanel.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
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
// REST hidden — els.sendRest.addEventListener("click", () => sendResultTo("rest"));
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
    icon: "🔍",
    title: "Send result to Decode Anything",
    hint: "action",
    run: () => sendResultTo("decode"),
  },
  // REST hidden — restore to re-list "Send result to REST Client" in the palette.
  // {
  //   icon: "🛰️",
  //   title: "Send result to REST Client",
  //   hint: "action",
  //   run: () => sendResultTo("rest"),
  // },
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
