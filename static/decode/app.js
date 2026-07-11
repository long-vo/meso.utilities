// meso.utilities — browser UI for Decode Anything.
// Imports the same detection module the tests exercise; input never leaves
// the page.
import { decodeAll } from "./decode.mjs";

const $ = (id) => document.getElementById(id);

const els = {
  input: $("input"),
  inputStatus: $("input-status"),
  steps: $("steps"),
  stats: $("stats"),
  copy: $("copy"),
  download: $("download"),
  clear: $("clear"),
  toast: $("toast"),
  exampleJwt: $("example-jwt"),
  exampleGzip: $("example-gzip"),
  exampleUrl: $("example-url"),
  exampleEscaped: $("example-escaped"),
};

const EXAMPLES = {
  jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJMMDA2MzQ0IiwibmFtZSI6IkphcmEgV2Vi" +
    "ZXIiLCJ0ZW5hbnQiOiJiYWxvaXNlLWlkIiwiaWF0IjoxNzUyMTkyMDAwLCJleHAiOjQxMDI0NDQ4MDB9." +
    "3q2-7wAAsig",
  gzip: "H4sIAAAAAAAAAx3MywqCQBgG0Hf51jOgzt9c3IUXGCgNibYxjdpGFHWKQHz3qO1ZnA1LN2fhg3TDMD2n" +
    "0bZIcYoiKYjAELrRjeGPvSAp49hz6QRx8iLhD9VGXB1MrxNjeu0JO8MaXHitSHErGlva7Hi1dXXP6qq0" +
    "zbnIweDebpjmS7esv1iRFlrH+xdgDymmiwAAAA==",
  url: "%7B%22redirect%22%3A%22https%3A%2F%2Fportal.example.ch%2Fcb%3Fstate%3Dx%20y%22%2C" +
    "%22scope%22%3A%22openid%20profile%22%7D",
  escaped: String.raw`{\"reqCtx\":{\"logonId\":\"L006344\"},\"avaloqPersId\":7483881}`,
};

/** Final step of the latest decode, for copy/download. */
let lastFinal;
/** Monotonic run counter so a stale async decode never overwrites a newer one. */
let runCounter = 0;

/* --------------------------- rendering helpers --------------------------- */

/** Escape HTML so arbitrary decoded text is safe to inject. */
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Lightweight JSON syntax highlighter (same approach as the sanitizer UI).
 */
function highlightJson(jsonString) {
  const esc = escapeHtml(jsonString);
  return esc.replace(
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      let cls = "j-num";
      if (match.startsWith("&quot;") || match.startsWith('"')) {
        cls = /:\s*$/.test(match) ? "j-key" : "j-str";
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

/** Kinds whose output is JSON and worth syntax-highlighting. */
const JSON_KINDS = new Set(["json", "jwt"]);

/**
 * Render one decode step as a card: badge with the encoding name, an optional
 * note, and the decoded output.
 */
function renderStep(step, index, isFinal) {
  const wrap = document.createElement("div");
  wrap.className = "step" + (isFinal ? " is-final" : "");

  const head = document.createElement("div");
  head.className = "step-head";
  head.innerHTML = `<span class="step-num">${index + 1}</span>` +
    `<span class="step-badge">${escapeHtml(step.label)}</span>` +
    (step.note ? `<span class="step-note">${escapeHtml(step.note)}</span>` : "");
  wrap.appendChild(head);

  const pre = document.createElement("pre");
  pre.className = "code-out step-out";
  const code = document.createElement("code");
  if (JSON_KINDS.has(step.kind)) {
    code.innerHTML = highlightJson(step.text);
  } else {
    code.textContent = step.text;
  }
  pre.appendChild(code);
  wrap.appendChild(pre);
  return wrap;
}

function renderEmpty(message) {
  els.steps.innerHTML =
    `<pre class="code-out step-out"><code><span class="j-null">// ${message}</span></code></pre>`;
  els.stats.innerHTML = "";
}

/* ------------------------------ core cycle ------------------------------- */

async function compute() {
  const run = ++runCounter;
  const raw = els.input.value;

  if (raw.trim() === "") {
    els.inputStatus.textContent = "";
    els.inputStatus.className = "status";
    renderEmpty("paste an encoded value to begin");
    lastFinal = undefined;
    return;
  }

  const result = await decodeAll(raw);
  if (run !== runCounter) return; // superseded by newer input

  if (result.steps.length === 0) {
    els.inputStatus.textContent = "no known encoding detected";
    els.inputStatus.className = "status";
    renderEmpty("nothing to decode — input looks like plain text");
    lastFinal = undefined;
    return;
  }

  lastFinal = result.final;
  els.inputStatus.textContent = `${result.steps.length} layer${
    result.steps.length === 1 ? "" : "s"
  } decoded`;
  els.inputStatus.className = "status ok";

  els.steps.innerHTML = "";
  result.steps.forEach((step, index) => {
    els.steps.appendChild(renderStep(step, index, index === result.steps.length - 1));
  });

  const chain = result.steps.map((step) => step.label).join(" → ");
  els.stats.innerHTML = `<span>${escapeHtml(chain)}</span>`;
}

/** Debounce recompute so typing stays snappy. */
let debounceTimer;
function scheduleCompute() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(compute, 150);
}

/* ------------------------------- actions --------------------------------- */

async function copyResult() {
  if (!lastFinal) return;
  try {
    await navigator.clipboard.writeText(lastFinal.text);
    showToast("Copied to clipboard");
  } catch {
    showToast("Copy failed — select and copy manually");
  }
}

function downloadResult() {
  if (!lastFinal) return;
  const isBinary = lastFinal.isBinary && lastFinal.bytes;
  const name = isBinary ? "decoded.bin" : "decoded.txt";
  const blob = isBinary
    ? new Blob([lastFinal.bytes], { type: "application/octet-stream" })
    : new Blob([lastFinal.text], { type: "text/plain" });
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

function setExample(text) {
  els.input.value = text;
  compute();
}

function clearAll() {
  els.input.value = "";
  compute();
  els.input.focus();
}

/* --------------------------------- wire ---------------------------------- */

els.input.addEventListener("input", scheduleCompute);
els.copy.addEventListener("click", copyResult);
els.download.addEventListener("click", downloadResult);
els.clear.addEventListener("click", clearAll);
els.exampleJwt.addEventListener("click", () => setExample(EXAMPLES.jwt));
els.exampleGzip.addEventListener("click", () => setExample(EXAMPLES.gzip));
els.exampleUrl.addEventListener("click", () => setExample(EXAMPLES.url));
els.exampleEscaped.addEventListener("click", () => setExample(EXAMPLES.escaped));
// (theme toggle is wired by the shared theme.js module)

// Start with the JWT example so the page looks alive.
setExample(EXAMPLES.jwt);
