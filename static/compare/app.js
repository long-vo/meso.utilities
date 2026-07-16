// meso.utilities — browser UI for Compare Files.
// All diff/merge logic lives in compare.mjs (the module the parity tests
// exercise); this file only wires the DOM. Files are read client-side —
// nothing leaves the page.
import { alignPair, alignTriple, buildHunks, charDiff, mergeRows } from "./compare.mjs";
import { takeHandoff } from "../handoff.mjs";
import { registerCommands } from "../palette.js";
import { escapeHtml, makeToast } from "../ui.mjs";

const $ = (id) => document.getElementById(id);

const els = {
  inputs: [...document.querySelectorAll(".cmp-input")],
  names: [...document.querySelectorAll(".cmp-file-name")],
  panes: [...document.querySelectorAll(".cmp-pane")],
  inputStatus: $("input-status"),
  diffStatus: $("diff-status"),
  view: $("diff-view"),
  mergedDetails: $("merged-details"),
  mergedOut: $("merged-out"),
  copyMerged: $("copy-merged"),
  downloadMerged: $("download-merged"),
  fileInput: $("file-input"),
  mode2: $("mode-2"),
  mode3: $("mode-3"),
  example: $("example"),
  swap: $("swap"),
  clear: $("clear"),
  toast: $("toast"),
};

const showToast = makeToast(els.toast);

const PANE_LABELS = ["A", "B", "C"];
/** Rows beyond this are not rendered (the merge still uses all of them). */
const MAX_RENDER_ROWS = 8000;

const EXAMPLE = [
  [
    '{\n  "service": "checkout",\n  "port": 8080,\n  "retries": 3,\n  "timeoutMs": 2000,\n' +
    '  "features": {\n    "newPricing": false,\n    "auditLog": true\n  }\n}',
    '{\n  "service": "checkout",\n  "port": 8443,\n  "retries": 3,\n  "timeoutMs": 5000,\n' +
    '  "features": {\n    "newPricing": true,\n    "auditLog": true\n  },\n  "tls": true\n}',
    '{\n  "service": "checkout",\n  "port": 8443,\n  "retries": 5,\n  "timeoutMs": 5000,\n' +
    '  "features": {\n    "newPricing": true,\n    "auditLog": false\n  },\n  "tls": true\n}',
  ],
];

/** 2 or 3 — how many panes take part in the comparison. */
let fileCount = 2;
/** Latest computed alignment, hunks and per-hunk picks ("a" | "b" | "c"). */
let rows = [];
let hunks = [];
let picks = [];
/** Which pane the hidden file input is currently picking for. */
let pickingPane = 0;

/* ------------------------------- rendering ------------------------------- */

function renderEmpty(message) {
  els.view.innerHTML =
    `<pre class="code-out step-out"><code><span class="j-null">// ${message}</span></code></pre>`;
  els.view.className = "cmp-view";
  els.diffStatus.textContent = "";
  els.diffStatus.className = "status";
  els.mergedDetails.hidden = true;
}

/** One cell's inner HTML: plain text, or char-diff segments when given. */
function cellHtml(text, segments) {
  if (text === null) return "";
  if (!segments) return escapeHtml(text);
  return segments
    .map((seg) =>
      seg.changed ? `<span class="cmp-seg">${escapeHtml(seg.text)}</span>` : escapeHtml(seg.text)
    )
    .join("");
}

/** CSS class for one side of a row. */
function cellClass(row, side) {
  if (row.type === "same") return "c-same";
  if (row[side] === null) return "c-empty";
  if (fileCount === 2) return side === "a" ? "c-del" : "c-add";
  // 3-file mode: B is the anchor; A/C cells that differ from it are marked.
  if (side === "b") return "c-base";
  return row.b !== null && row[side] === row.b ? "c-same" : "c-add";
}

/** Inline char-diff segments for a row, keyed by side, or undefined. */
function rowSegments(row) {
  if (row.type === "mod") {
    const { a, b } = charDiff(row.a, row.b);
    return { a, b };
  }
  if (fileCount === 3 && row.type === "diff" && row.b !== null) {
    const segments = {};
    for (const side of ["a", "c"]) {
      if (row[side] !== null && row[side] !== row.b) {
        segments[side] = charDiff(row.b, row[side]).b;
      }
    }
    return segments;
  }
  return undefined;
}

function hunkHeaderHtml(hunkIndex) {
  const pick = picks[hunkIndex] ?? "a";
  const buttons = PANE_LABELS.slice(0, fileCount)
    .map((label, i) => {
      const side = "abc"[i];
      const active = pick === side ? " is-active" : "";
      return `<button type="button" class="btn btn-small cmp-keep${active}" ` +
        `data-hunk="${hunkIndex}" data-side="${side}" ` +
        `aria-pressed="${pick === side}">Keep ${label}</button>`;
    })
    .join("");
  return `<div class="cmp-hunk"><span class="cmp-hunk-label">Difference ${
    hunkIndex + 1
  }</span><span class="cmp-hunk-keep">${buttons}</span></div>`;
}

function render() {
  const sides = "abc".slice(0, fileCount).split("");
  const nums = { a: 0, b: 0, c: 0 };
  const parts = [];
  let hunkIndex = 0;
  const limit = Math.min(rows.length, MAX_RENDER_ROWS);

  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    if (hunkIndex < hunks.length && i === hunks[hunkIndex].start) {
      parts.push(hunkHeaderHtml(hunkIndex));
      hunkIndex++;
    }
    const segments = rowSegments(row);
    const cells = sides
      .map((side) => {
        const num = row[side] === null ? "" : ++nums[side];
        return `<span class="cmp-num">${num}</span>` +
          `<span class="cmp-cell ${cellClass(row, side)}">${
            cellHtml(row[side], segments?.[side])
          }</span>`;
      })
      .join("");
    parts.push(`<div class="cmp-row">${cells}</div>`);
  }
  if (rows.length > limit) {
    parts.push(
      `<div class="cmp-hunk"><span class="cmp-hunk-label">… ${rows.length - limit} ` +
        `more lines not shown (merge still includes them)</span></div>`,
    );
  }
  els.view.innerHTML = parts.join("");
  els.view.className = `cmp-view cmp-${fileCount}`;
}

function renderMerged() {
  if (hunks.length === 0) {
    els.mergedDetails.hidden = true;
    return;
  }
  els.mergedDetails.hidden = false;
  els.mergedOut.textContent = mergeRows(rows, hunks, picks);
}

/* ------------------------------ core cycle ------------------------------- */

function compute() {
  const texts = els.inputs.slice(0, fileCount).map((input) => input.value);
  if (texts.every((text) => text === "")) {
    els.inputStatus.textContent = "";
    els.inputStatus.className = "status";
    renderEmpty(`add content to ${fileCount === 2 ? "two" : "three"} files to compare`);
    rows = [];
    hunks = [];
    picks = [];
    return;
  }

  rows = fileCount === 2 ? alignPair(texts[0], texts[1]) : alignTriple(...texts);
  hunks = buildHunks(rows);
  picks = new Array(hunks.length).fill(undefined);

  if (hunks.length === 0) {
    els.inputStatus.textContent = "files are identical";
    els.inputStatus.className = "status ok";
    els.diffStatus.textContent = "no differences";
    els.diffStatus.className = "status ok";
  } else {
    els.inputStatus.textContent = `${hunks.length} difference${hunks.length === 1 ? "" : "s"}`;
    els.inputStatus.className = "status";
    els.diffStatus.textContent = `${hunks.length} difference${
      hunks.length === 1 ? "" : "s"
    } — pick what to keep`;
    els.diffStatus.className = "status";
  }
  render();
  renderMerged();
}

/** Debounce recompute so typing stays snappy. */
let debounceTimer;
function scheduleCompute() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(compute, 200);
}

/* ------------------------------- actions --------------------------------- */

function mergedText() {
  if (rows.length === 0) return undefined;
  return mergeRows(rows, hunks, picks);
}

async function copyMerged() {
  const text = mergedText();
  if (text === undefined) {
    showToast("Nothing to merge yet");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast("Merged result copied");
  } catch {
    showToast("Copy failed — select and copy manually");
  }
}

function downloadMerged() {
  const text = mergedText();
  if (text === undefined) {
    showToast("Nothing to merge yet");
    return;
  }
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "merged.txt";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast("Downloaded merged.txt");
}

function setFileCount(next) {
  fileCount = next;
  document.body.setAttribute("data-files", String(next));
  const is3 = next === 3;
  els.mode3.classList.toggle("is-active", is3);
  els.mode2.classList.toggle("is-active", !is3);
  els.mode3.setAttribute("aria-selected", String(is3));
  els.mode2.setAttribute("aria-selected", String(!is3));
  compute();
}

function setPaneText(pane, text, name) {
  if (pane >= els.inputs.length) return;
  els.inputs[pane].value = text;
  els.names[pane].textContent = name ?? "";
}

async function loadFiles(pane, files) {
  for (let i = 0; i < files.length && pane + i < els.inputs.length; i++) {
    const file = files[i];
    setPaneText(pane + i, await file.text(), file.name);
  }
  if (files.length > 1 && fileCount === 2 && files.length + pane > 2) setFileCount(3);
  else compute();
}

function loadExample() {
  const [a, b, c] = EXAMPLE[0];
  setPaneText(0, a, "checkout.dev.json");
  setPaneText(1, b, "checkout.uat.json");
  setPaneText(2, c, "checkout.prod.json");
  compute();
}

function swapAB() {
  const [a, b] = [els.inputs[0].value, els.inputs[1].value];
  const [na, nb] = [els.names[0].textContent, els.names[1].textContent];
  setPaneText(0, b, nb);
  setPaneText(1, a, na);
  compute();
}

function clearAll() {
  els.inputs.forEach((_, pane) => setPaneText(pane, "", ""));
  compute();
  els.inputs[0].focus();
}

/* --------------------------------- wire ---------------------------------- */

els.inputs.forEach((input) => input.addEventListener("input", scheduleCompute));
els.mode2.addEventListener("click", () => setFileCount(2));
els.mode3.addEventListener("click", () => setFileCount(3));
els.example.addEventListener("click", loadExample);
els.swap.addEventListener("click", swapAB);
els.clear.addEventListener("click", clearAll);
els.copyMerged.addEventListener("click", copyMerged);
els.downloadMerged.addEventListener("click", downloadMerged);

// Per-hunk "Keep A/B/C" picks — delegated, the view re-renders on input anyway.
els.view.addEventListener("click", (event) => {
  const button = event.target.closest("[data-hunk]");
  if (!button) return;
  picks[Number(button.dataset.hunk)] = button.dataset.side;
  render();
  renderMerged();
});

// File pickers: one hidden <input type="file">, re-targeted per pane.
for (const button of document.querySelectorAll("[data-pick-file]")) {
  button.addEventListener("click", () => {
    pickingPane = Number(button.dataset.pickFile);
    els.fileInput.value = "";
    els.fileInput.click();
  });
}
els.fileInput.addEventListener("change", () => {
  if (els.fileInput.files?.length) loadFiles(pickingPane, els.fileInput.files);
});

// Drag & drop: each pane accepts a drop; dropping several files at once fills
// this pane and the following ones. Only file drags are intercepted, so
// dragging selected text into a textarea still works.
els.panes.forEach((pane, index) => {
  pane.addEventListener("dragover", (event) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    pane.classList.add("drag-over");
  });
  pane.addEventListener("dragleave", (event) => {
    if (!pane.contains(event.relatedTarget)) pane.classList.remove("drag-over");
  });
  pane.addEventListener("drop", (event) => {
    pane.classList.remove("drag-over");
    if (!event.dataTransfer.files?.length) return;
    event.preventDefault();
    loadFiles(index, event.dataTransfer.files);
  });
});

registerCommands([
  { icon: "📋", title: "Copy merged result", hint: "action", run: copyMerged },
  { icon: "⬇️", title: "Download merged result", hint: "action", run: downloadMerged },
  {
    icon: "🔁",
    title: "Switch 2 / 3 file mode",
    hint: "action",
    keywords: ["three", "way", "mode"],
    run: () => setFileCount(fileCount === 2 ? 3 : 2),
  },
  { icon: "⇄", title: "Swap File A and File B", hint: "action", run: swapAB },
  { icon: "✨", title: "Load example files", hint: "action", run: loadExample },
]);

// An incoming handoff from another tool lands in File A.
function receiveHandoff() {
  const handoff = takeHandoff(sessionStorage, "compare");
  if (!handoff) return false;
  setPaneText(0, handoff.text, "");
  compute();
  showToast(`Received from ${handoff.from || "another tool"} — now fill File B`);
  return true;
}

globalThis.addEventListener("pageshow", (event) => {
  if (event.persisted) receiveHandoff();
});

if (!receiveHandoff()) compute();
