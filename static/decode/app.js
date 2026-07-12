// meso.utilities — browser UI for Decode Anything.
// Imports the same detection module the tests exercise; input never leaves
// the page.
import { decodeAll } from "./decode.mjs";
import { encodeChain, encoderFor, ENCODERS } from "./encode.mjs";
import { decodeJwtParts, describeJwtTimes, verifyJwtSignature } from "./jwt.mjs";
import { sendHandoff, takeHandoff } from "../handoff.mjs";
import { registerCommands } from "../palette.js";

const $ = (id) => document.getElementById(id);

const els = {
  input: $("input"),
  inputStatus: $("input-status"),
  steps: $("steps"),
  stats: $("stats"),
  copy: $("copy"),
  download: $("download"),
  clear: $("clear"),
  sendSanitize: $("send-sanitize"),
  sendRest: $("send-rest"),
  toast: $("toast"),
  exampleJwt: $("example-jwt"),
  exampleGzip: $("example-gzip"),
  exampleUrl: $("example-url"),
  exampleEscaped: $("example-escaped"),
  modeDecode: $("mode-decode"),
  modeEncode: $("mode-encode"),
  encoderButtons: $("encoder-buttons"),
  layerChips: $("layer-chips"),
  layerUndo: $("layer-undo"),
  layerClear: $("layer-clear"),
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
/** "decode" (unwrap layers) or "encode" (stack layers). */
let pageMode = "decode";
/** Encoder kinds applied in encode mode, innermost first. */
let layers = [];

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
 * Render one step as a card: badge with the encoding name, an optional note,
 * and the output. For JWT steps, `stepInput` (the raw token) powers the
 * time-claim chips and the in-place signature verification.
 */
function renderStep(step, index, isFinal, stepInput) {
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
  if (step.kind === "jwt" && stepInput) {
    const panel = buildJwtPanel(stepInput);
    if (panel) wrap.appendChild(panel);
  }
  return wrap;
}

/** Time-claim chips + a local signature check for one JWT step card. */
function buildJwtPanel(token) {
  const parts = decodeJwtParts(token);
  if (!parts) return undefined;

  const box = document.createElement("div");
  box.className = "jwt-verify";

  const times = describeJwtTimes(parts.payload);
  if (times.length > 0) {
    const row = document.createElement("div");
    row.className = "chips jwt-times";
    for (const time of times) {
      const chip = document.createElement("span");
      chip.className = "chip" +
        (time.status === "ok" ? " resolved" : time.status === "bad" ? " missing" : "");
      chip.textContent = `${time.claim}: ${time.relative}`;
      chip.title = `${time.claim} = ${time.iso}`;
      row.appendChild(chip);
    }
    box.appendChild(row);
  }

  const isHmac = String(parts.header.alg).startsWith("HS");
  const row = document.createElement("div");
  row.className = "jwt-verify-row";
  const key = document.createElement("input");
  key.type = "text";
  key.className = "jwt-key";
  key.placeholder = isHmac
    ? `shared secret (${parts.header.alg})`
    : `public key as JWK / JWKS JSON (${parts.header.alg})`;
  key.spellcheck = false;
  key.autocomplete = "off";
  key.setAttribute("aria-label", "Verification key");
  const verify = document.createElement("button");
  verify.type = "button";
  verify.className = "btn btn-small";
  verify.textContent = "Verify signature";
  const badge = document.createElement("span");
  badge.className = "status";
  const runVerify = async () => {
    badge.textContent = "verifying…";
    badge.className = "status";
    const result = await verifyJwtSignature(token, key.value);
    badge.textContent = result.ok ? `✓ signature valid (${result.alg})` : `✗ ${result.reason}`;
    badge.className = result.ok ? "status ok" : "status bad";
  };
  verify.addEventListener("click", runVerify);
  key.addEventListener("keydown", (event) => {
    if (event.key === "Enter") runVerify();
  });
  row.append(key, verify, badge);
  box.appendChild(row);
  return box;
}

function renderEmpty(message) {
  els.steps.innerHTML =
    `<pre class="code-out step-out"><code><span class="j-null">// ${message}</span></code></pre>`;
  els.stats.innerHTML = "";
}

/* ------------------------------ core cycle ------------------------------- */

async function compute() {
  if (pageMode === "encode") {
    await computeEncode();
    return;
  }
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
    // A step's input is the previous step's output (the raw text for step 0) —
    // the JWT card needs it to verify the token in place.
    const stepInput = index === 0 ? raw.trim() : result.steps[index - 1].text;
    els.steps.appendChild(renderStep(step, index, index === result.steps.length - 1, stepInput));
  });

  const chain = result.steps.map((step) => step.label).join(" → ");
  els.stats.innerHTML = `<span>${escapeHtml(chain)}</span>`;
}

/** Encode mode: apply the stacked layers to the plain input. */
async function computeEncode() {
  const run = ++runCounter;
  const raw = els.input.value;

  if (raw === "") {
    els.inputStatus.textContent = "";
    els.inputStatus.className = "status";
    renderEmpty("type plain text to encode");
    lastFinal = undefined;
    return;
  }

  const result = await encodeChain(raw, layers);
  if (run !== runCounter) return; // superseded by newer input

  if (result.steps.length === 0) {
    els.inputStatus.textContent = "no layers applied";
    els.inputStatus.className = "status";
    renderEmpty("add a layer on the left — Base64, hex, URL, gzip…");
    lastFinal = undefined;
    return;
  }

  lastFinal = { text: result.final, isBinary: false };
  els.inputStatus.textContent = `${result.steps.length} layer${
    result.steps.length === 1 ? "" : "s"
  } applied`;
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

/** Hand the final decoded text to another tool — consumed on its page load. */
function sendResultTo(target) {
  if (!lastFinal) return;
  if (!sendHandoff(sessionStorage, target, lastFinal.text, "Decode Anything")) {
    showToast("Result too large to hand off — use Copy instead");
    return;
  }
  location.href = `../${target}/`;
}

function setExample(text) {
  els.input.value = text;
  if (pageMode !== "decode") setPageMode("decode"); // setPageMode recomputes
  else compute();
}

function clearAll() {
  els.input.value = "";
  compute();
  els.input.focus();
}

/** Switch between Decode (unwrap) and Encode (stack layers) mode. */
function setPageMode(next) {
  pageMode = next;
  document.body.setAttribute("data-mode", next);
  const isEncode = next === "encode";
  els.modeEncode.classList.toggle("is-active", isEncode);
  els.modeDecode.classList.toggle("is-active", !isEncode);
  els.modeEncode.setAttribute("aria-selected", String(isEncode));
  els.modeDecode.setAttribute("aria-selected", String(!isEncode));
  els.input.placeholder = isEncode
    ? "Type or paste plain text — then add layers on the left…"
    : "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.… — or Base64, hex, %-encoded, gzip'd, escaped JSON";
  compute();
}

/** Show the applied encode layers, in order, and sync the layer buttons. */
function renderLayerChips() {
  els.layerChips.innerHTML = "";
  if (layers.length === 0) {
    const hint = document.createElement("span");
    hint.className = "chip unused";
    hint.textContent = "none yet";
    els.layerChips.appendChild(hint);
  }
  layers.forEach((kind, index) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = `${index + 1}. ${encoderFor(kind)?.label ?? kind}`;
    els.layerChips.appendChild(chip);
  });
  els.layerUndo.disabled = layers.length === 0;
  els.layerClear.disabled = layers.length === 0;
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
els.sendSanitize.addEventListener("click", () => sendResultTo("sanitize"));
els.sendRest.addEventListener("click", () => sendResultTo("rest"));
els.modeDecode.addEventListener("click", () => setPageMode("decode"));
els.modeEncode.addEventListener("click", () => setPageMode("encode"));
els.layerUndo.addEventListener("click", () => {
  layers.pop();
  renderLayerChips();
  compute();
});
els.layerClear.addEventListener("click", () => {
  layers = [];
  renderLayerChips();
  compute();
});
for (const encoder of ENCODERS) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn-ghost btn-small";
  button.textContent = encoder.label;
  button.title = `Wrap the current result in ${encoder.label}`;
  button.addEventListener("click", () => {
    layers.push(encoder.kind);
    renderLayerChips();
    compute();
  });
  els.encoderButtons.appendChild(button);
}
renderLayerChips();
// (theme toggle is wired by the shared theme.js module)

registerCommands([
  { icon: "📋", title: "Copy result", hint: "action", run: copyResult },
  { icon: "⬇️", title: "Download result", hint: "action", run: downloadResult },
  {
    icon: "✨",
    title: "Load JWT example",
    hint: "action",
    keywords: ["jwt", "example"],
    run: () => setExample(EXAMPLES.jwt),
  },
  {
    icon: "🔁",
    title: "Switch Decode / Encode mode",
    hint: "action",
    keywords: ["mode", "encode", "reverse", "build"],
    run: () => setPageMode(pageMode === "encode" ? "decode" : "encode"),
  },
  {
    icon: "🔒",
    title: "Send result to Sanitize JSON",
    hint: "action",
    run: () => sendResultTo("sanitize"),
  },
  {
    icon: "🛰️",
    title: "Send result to REST Client",
    hint: "action",
    run: () => sendResultTo("rest"),
  },
]);

// An incoming handoff from another tool wins over the default example.
function receiveHandoff() {
  const handoff = takeHandoff(sessionStorage, "decode");
  if (!handoff) return false;
  setExample(handoff.text);
  showToast(`Received from ${handoff.from || "another tool"}`);
  return true;
}

// Re-check on back/forward-cache restores too (Send to → Back → Send to again
// revives this page without re-running the script).
globalThis.addEventListener("pageshow", (event) => {
  if (event.persisted) receiveHandoff();
});

if (!receiveHandoff()) {
  // Start with the JWT example so the page looks alive.
  setExample(EXAMPLES.jwt);
}
