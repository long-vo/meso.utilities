// meso.utilities — browser UI for the REST Client.
// The fetch happens right here in the page; rest.mjs supplies the pure logic
// (header parsing, curl export, formatting) and is what the tests cover.
import {
  applyVariableCompletion,
  BODYLESS_METHODS,
  buildCurlCommand,
  buildRequestHeaders,
  collectRequestVariables,
  describeSendError,
  filterVariableNames,
  findVariableToken,
  formatBytes,
  formatDuration,
  formatJsonBody,
  HEADER_NAME_SUGGESTIONS,
  HISTORY_LIMIT,
  isJsonContentType,
  isTextualContentType,
  REQUEST_METHODS,
  resolveRequest,
  serializeHeaderRows,
  substituteVariables,
  suggestHeaderValues,
  toVariableMap,
  validateUrl,
} from "./rest.mjs";
import { parseCurlCommand } from "./curl.mjs";
import { extractJsonPath, variableStringFor } from "./jsonpath.mjs";
import { sendHandoff, takeHandoff } from "../handoff.mjs";
import { registerCommands } from "../palette.js";
import { escapeHtml, highlightJson, makeToast } from "../ui.mjs";

const $ = (id) => document.getElementById(id);

const els = {
  method: $("method"),
  url: $("url"),
  send: $("send"),
  abort: $("abort"),
  authKind: $("auth-kind"),
  authToken: $("auth-token"),
  authUser: $("auth-user"),
  authPass: $("auth-pass"),
  headerRows: $("header-rows"),
  addHeader: $("add-header"),
  headerNameList: $("header-name-list"),
  headerValueList: $("header-value-list"),
  body: $("body"),
  beautifyBody: $("beautify-body"),
  copyCurl: $("copy-curl"),
  loadExample: $("load-example"),
  inputStatus: $("input-status"),
  inputError: $("input-error"),
  history: $("history"),
  historyEmpty: $("history-empty"),
  clearHistory: $("clear-history"),
  respLine: $("resp-line"),
  respStatus: $("resp-status"),
  respTime: $("resp-time"),
  respSize: $("resp-size"),
  respHeadersBox: $("resp-headers-box"),
  respHeaders: $("resp-headers"),
  respBody: $("resp-body"),
  respError: $("resp-error"),
  copyBody: $("copy-body"),
  sendSanitize: $("send-sanitize"),
  sendDecode: $("send-decode"),
  importCurl: $("import-curl"),
  curlBox: $("curl-box"),
  curlInput: $("curl-input"),
  curlApply: $("curl-apply"),
  curlCancel: $("curl-cancel"),
  curlError: $("curl-error"),
  respTools: $("resp-tools"),
  viewTree: $("view-tree"),
  viewRaw: $("view-raw"),
  respSearch: $("resp-search"),
  respTree: $("resp-tree"),
  respRaw: $("resp-raw"),
  capturePath: $("capture-path"),
  capturePreview: $("capture-preview"),
  captureName: $("capture-name"),
  captureSave: $("capture-save"),
  toast: $("toast"),
  envEmpty: $("env-empty"),
  envEditor: $("env-editor"),
  envName: $("env-name"),
  envNew: $("env-new"),
  envNewFirst: $("env-new-first"),
  envDuplicate: $("env-duplicate"),
  envDelete: $("env-delete"),
  varCount: $("var-count"),
  varMask: $("var-mask"),
  varRows: $("var-rows"),
  envSelect: $("env-select"),
  varChips: $("var-chips"),
};

const HISTORY_KEY = "meso-rest-history";
const ENVIRONMENTS_KEY = "meso-rest-environments";
/** Cap the rendered response body so huge payloads don't freeze the tab. */
const BODY_DISPLAY_LIMIT = 2 * 1024 * 1024;

const EXAMPLE = {
  method: "GET",
  url: "https://api.github.com/repos/denoland/deno",
  headers: "Accept: application/vnd.github+json",
  body: "",
};

/** Latest response body text, for the copy button. */
let lastBodyText = "";
/** Parsed JSON of the latest response (undefined when not JSON). */
let lastJsonValue;
/** "tree" or "raw" — which body view is active for JSON responses. */
let respView = "tree";
/** AbortController of the in-flight request, if any. */
let inflight;

/* --------------------------- rendering helpers --------------------------- */

const showToast = makeToast(els.toast);

/* ------------------------------ composer state --------------------------- */

function readAuth() {
  return {
    kind: els.authKind.value,
    token: els.authToken.value,
    username: els.authUser.value,
    password: els.authPass.value,
  };
}

function readRequest() {
  return {
    method: els.method.value,
    url: els.url.value,
    headerText: readHeaderText(),
    auth: readAuth(),
    body: els.body.value,
  };
}

function syncAuthInputs() {
  const kind = els.authKind.value;
  els.authToken.hidden = kind !== "bearer";
  els.authUser.hidden = kind !== "basic";
  els.authPass.hidden = kind !== "basic";
}

function syncBodyState() {
  const isBodyless = BODYLESS_METHODS.has(els.method.value);
  els.body.disabled = isBodyless;
  els.beautifyBody.disabled = isBodyless;
  els.body.placeholder = isBodyless
    ? `${els.method.value} requests send no body`
    : '{ "name": "Jara" }';
}

/** Warn ahead of time about calls the browser is going to block or fail. */
function updateInputStatus() {
  const target = validateUrl(substituteVariables(els.url.value, activeVariableMap()));
  if (!target.ok) {
    els.inputStatus.textContent = "";
    els.inputStatus.className = "status";
    return;
  }
  const isLocalTarget = /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(target.url);
  if (location.protocol === "https:" && target.url.startsWith("http:") && !isLocalTarget) {
    els.inputStatus.textContent = "http: target on an https page — likely blocked";
    els.inputStatus.className = "status bad";
  } else {
    els.inputStatus.textContent = "";
    els.inputStatus.className = "status";
  }
}

/* ------------------------------ environments ----------------------------- */

/** Values start masked so tokens don't linger on shared screens. */
let areValuesMasked = true;

function readEnvironmentsState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ENVIRONMENTS_KEY) ?? "{}");
    const environments = Array.isArray(parsed.environments) ? parsed.environments : [];
    const activeId = typeof parsed.activeId === "string" ? parsed.activeId : null;
    return {
      environments,
      activeId: environments.some((env) => env.id === activeId) ? activeId : null,
    };
  } catch {
    return { environments: [], activeId: null };
  }
}

function writeEnvironmentsState(state) {
  try {
    localStorage.setItem(ENVIRONMENTS_KEY, JSON.stringify(state));
  } catch {
    /* storage may be unavailable; environments just won't persist */
  }
}

function activeEnvironment(state = readEnvironmentsState()) {
  return state.environments.find((env) => env.id === state.activeId);
}

/** Variables of the active environment as a lookup map (empty when none). */
function activeVariableMap() {
  return toVariableMap(activeEnvironment()?.variables ?? []);
}

function suggestEnvironmentName(environments) {
  const names = new Set(environments.map((env) => env.name));
  for (const candidate of ["dev", "uat", "prod"]) {
    if (!names.has(candidate)) return candidate;
  }
  return `env-${environments.length + 1}`;
}

function createVariableRow(name = "", value = "") {
  const row = document.createElement("div");
  row.className = "header-row var-row";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "header-name var-name";
  nameInput.placeholder = "name";
  nameInput.spellcheck = false;
  nameInput.autocomplete = "off";
  nameInput.value = name;

  const valueInput = document.createElement("input");
  valueInput.type = areValuesMasked ? "password" : "text";
  valueInput.className = "header-value var-value";
  valueInput.placeholder = "value";
  valueInput.spellcheck = false;
  valueInput.autocomplete = "off";
  valueInput.value = value;

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn btn-small row-remove";
  remove.textContent = "✕";
  remove.setAttribute("aria-label", "Remove variable");

  const onEdit = () => {
    ensureTrailingVarRow();
    saveVariablesFromRows();
  };
  nameInput.addEventListener("input", onEdit);
  valueInput.addEventListener("input", onEdit);
  remove.addEventListener("click", () => {
    row.remove();
    if (els.varRows.children.length === 0) addVariableRow();
    saveVariablesFromRows();
  });

  row.append(nameInput, valueInput, remove);
  return row;
}

function addVariableRow(name = "", value = "") {
  els.varRows.appendChild(createVariableRow(name, value));
}

function ensureTrailingVarRow() {
  const rows = [...els.varRows.querySelectorAll(".var-row")];
  const last = rows[rows.length - 1];
  if (!last) {
    addVariableRow();
    return;
  }
  if (
    last.querySelector(".var-name").value.trim() !== "" ||
    last.querySelector(".var-value").value.trim() !== ""
  ) {
    addVariableRow();
  }
}

function readVariableRows() {
  return [...els.varRows.querySelectorAll(".var-row")]
    .map((row) => ({
      name: row.querySelector(".var-name").value,
      value: row.querySelector(".var-value").value,
    }))
    .filter((entry) => entry.name.trim() !== "" || entry.value.trim() !== "");
}

/** Persist row edits without rebuilding the rows (keeps focus while typing). */
function saveVariablesFromRows() {
  const state = readEnvironmentsState();
  const active = activeEnvironment(state);
  if (!active) return;
  active.variables = readVariableRows();
  writeEnvironmentsState(state);
  updateVariableCount(active.variables.length);
  refreshVariableChips();
}

function updateVariableCount(count) {
  els.varCount.textContent = `Variables (${count})`;
}

function renderEnvSelect(state = readEnvironmentsState()) {
  els.envSelect.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "no environment";
  els.envSelect.appendChild(none);
  for (const env of state.environments) {
    const option = document.createElement("option");
    option.value = env.id;
    option.textContent = `env: ${env.name}`;
    els.envSelect.appendChild(option);
  }
  els.envSelect.value = state.activeId ?? "";
}

function renderEnvironmentEditor(state = readEnvironmentsState()) {
  const active = activeEnvironment(state);
  els.envEmpty.hidden = active !== undefined;
  els.envEditor.hidden = active === undefined;
  if (!active) return;
  els.envName.value = active.name;
  els.varRows.innerHTML = "";
  for (const variable of active.variables) addVariableRow(variable.name, variable.value);
  addVariableRow(); // trailing empty row
  updateVariableCount(active.variables.length);
}

function renderEnvironments() {
  const state = readEnvironmentsState();
  renderEnvSelect(state);
  renderEnvironmentEditor(state);
  refreshVariableChips();
  updateInputStatus();
}

function createEnvironment(variables = []) {
  const state = readEnvironmentsState();
  const environment = {
    id: crypto.randomUUID(),
    name: suggestEnvironmentName(state.environments),
    variables,
  };
  state.environments.push(environment);
  state.activeId = environment.id;
  writeEnvironmentsState(state);
  renderEnvironments();
  els.envName.focus();
  els.envName.select();
}

/* -------------------------- variable autocomplete ------------------------ */
// Typing `{{` in any request field opens a small listbox with the active
// environment's variables. ↑↓ select, Enter/Tab accept, Esc closes.

const acMenu = document.createElement("div");
acMenu.className = "ac-menu";
acMenu.hidden = true;
acMenu.setAttribute("role", "listbox");
acMenu.setAttribute("aria-label", "Variable suggestions");
document.body.appendChild(acMenu);

/** Field the menu is currently attached to (undefined = closed). */
let acField;
/** @type {string[]} */
let acNames = [];
let acIndex = 0;

function isAutocompleteOpen() {
  return !acMenu.hidden;
}

function closeAutocomplete() {
  acMenu.hidden = true;
  acField = undefined;
}

function renderAutocomplete() {
  acMenu.innerHTML = "";
  acNames.forEach((name, index) => {
    const item = document.createElement("div");
    item.className = "ac-item" + (index === acIndex ? " is-active" : "");
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(index === acIndex));
    item.textContent = `{{${name}}}`;
    // mousedown (not click) so the field never blurs before we complete
    item.addEventListener("mousedown", (event) => {
      event.preventDefault();
      acceptAutocomplete(name);
    });
    acMenu.appendChild(item);
  });
}

function positionAutocomplete(field) {
  const rect = field.getBoundingClientRect();
  acMenu.style.left = `${rect.left + globalThis.scrollX}px`;
  acMenu.style.top = `${rect.bottom + globalThis.scrollY + 4}px`;
  acMenu.style.minWidth = `${Math.min(rect.width, 280)}px`;
}

function openAutocompleteFor(field) {
  const names = [...activeVariableMap().keys()];
  if (names.length === 0) {
    closeAutocomplete();
    return;
  }
  const caret = field.selectionStart ?? field.value.length;
  const token = findVariableToken(field.value, caret);
  if (!token) {
    closeAutocomplete();
    return;
  }
  acNames = filterVariableNames(names, token.prefix);
  if (acNames.length === 0) {
    closeAutocomplete();
    return;
  }
  acIndex = 0;
  acField = field;
  renderAutocomplete();
  positionAutocomplete(field);
  acMenu.hidden = false;
}

function acceptAutocomplete(name) {
  const field = acField;
  if (!field) return;
  const caret = field.selectionStart ?? field.value.length;
  const result = applyVariableCompletion(field.value, caret, name);
  field.value = result.text;
  field.setSelectionRange(result.caret, result.caret);
  closeAutocomplete();
  field.focus();
  // notify the regular listeners (chips, status, header trailing row, …)
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function onAutocompleteKeydown(event) {
  if (!isAutocompleteOpen() || event.target !== acField) return;
  if (event.key === "ArrowDown") {
    acIndex = (acIndex + 1) % acNames.length;
    renderAutocomplete();
    event.preventDefault();
  } else if (event.key === "ArrowUp") {
    acIndex = (acIndex - 1 + acNames.length) % acNames.length;
    renderAutocomplete();
    event.preventDefault();
  } else if (event.key === "Enter" || event.key === "Tab") {
    acceptAutocomplete(acNames[acIndex]);
    event.preventDefault();
  } else if (event.key === "Escape") {
    closeAutocomplete();
    event.preventDefault();
  }
}

/** Wire `{{` autocomplete onto one input or textarea. */
function attachVariableAutocomplete(field) {
  field.addEventListener("input", () => openAutocompleteFor(field));
  field.addEventListener("click", () => openAutocompleteFor(field));
  field.addEventListener("keydown", onAutocompleteKeydown);
  field.addEventListener("blur", () => setTimeout(closeAutocomplete, 120));
}

globalThis.addEventListener("scroll", closeAutocomplete, true);
globalThis.addEventListener("resize", closeAutocomplete);

/* ----------------------------- variable chips ---------------------------- */

/** Show every `{{variable}}` the request uses — green resolved, red missing. */
function refreshVariableChips() {
  const names = collectRequestVariables(readRequest());
  els.varChips.hidden = names.length === 0;
  els.varChips.innerHTML = "";
  const variables = activeVariableMap();
  for (const name of names) {
    const isResolved = variables.has(name);
    const chip = document.createElement("span");
    chip.className = `chip ${isResolved ? "resolved" : "missing"}`;
    chip.textContent = isResolved ? `${name} ✓` : `${name} — not set`;
    chip.title = isResolved
      ? `{{${name}}} resolves from the active environment`
      : `{{${name}}} is not set in the active environment`;
    els.varChips.appendChild(chip);
  }
}

/* ------------------------------ header rows ------------------------------ */

/** Refill the shared value datalist with suggestions for one header name. */
function refreshValueSuggestions(name) {
  els.headerValueList.innerHTML = "";
  for (const suggestion of suggestHeaderValues(name)) {
    const option = document.createElement("option");
    option.value = suggestion;
    els.headerValueList.appendChild(option);
  }
}

function createHeaderRow(name = "", value = "") {
  const row = document.createElement("div");
  row.className = "header-row";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "header-name";
  nameInput.placeholder = "Header";
  nameInput.spellcheck = false;
  nameInput.autocomplete = "off";
  nameInput.setAttribute("list", "header-name-list");
  nameInput.value = name;

  const valueInput = document.createElement("input");
  valueInput.type = "text";
  valueInput.className = "header-value";
  valueInput.placeholder = "value";
  valueInput.spellcheck = false;
  valueInput.autocomplete = "off";
  valueInput.setAttribute("list", "header-value-list");
  valueInput.value = value;

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn btn-small row-remove";
  remove.textContent = "✕";
  remove.setAttribute("aria-label", "Remove header");

  nameInput.addEventListener("input", () => {
    refreshValueSuggestions(nameInput.value);
    ensureTrailingRow();
    refreshVariableChips();
  });
  valueInput.addEventListener("focus", () => refreshValueSuggestions(nameInput.value));
  valueInput.addEventListener("input", () => {
    ensureTrailingRow();
    refreshVariableChips();
  });
  remove.addEventListener("click", () => {
    row.remove();
    if (els.headerRows.children.length === 0) addHeaderRow();
    refreshVariableChips();
  });
  attachVariableAutocomplete(valueInput);

  row.append(nameInput, valueInput, remove);
  return row;
}

function addHeaderRow(name = "", value = "") {
  els.headerRows.appendChild(createHeaderRow(name, value));
}

/** Keep one empty row at the bottom so the next header is one click away. */
function ensureTrailingRow() {
  const rows = [...els.headerRows.querySelectorAll(".header-row")];
  const last = rows[rows.length - 1];
  if (!last) {
    addHeaderRow();
    return;
  }
  const lastName = last.querySelector(".header-name").value.trim();
  const lastValue = last.querySelector(".header-value").value.trim();
  if (lastName !== "" || lastValue !== "") addHeaderRow();
}

function readHeaderText() {
  const rows = [...els.headerRows.querySelectorAll(".header-row")].map((row) => ({
    name: row.querySelector(".header-name").value,
    value: row.querySelector(".header-value").value,
  }));
  return serializeHeaderRows(rows);
}

/** Rebuild the rows from `Name: value` text (history entries, examples). */
function setHeadersFromText(text) {
  els.headerRows.innerHTML = "";
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) addHeaderRow(trimmed, "");
    else addHeaderRow(trimmed.slice(0, colon).trim(), trimmed.slice(colon + 1).trim());
  }
  addHeaderRow(); // trailing empty row
}

/* -------------------------------- history -------------------------------- */

function readHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeHistory(entries) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
  } catch {
    /* storage may be unavailable; history just won't persist */
  }
}

function rememberRequest(request) {
  const entries = readHistory();
  const entry = { ...request, env: activeEnvironment()?.name, at: Date.now() };
  const newest = entries[0];
  if (newest) {
    const { at: _a, ...restNewest } = newest;
    const { at: _b, ...restEntry } = entry;
    if (JSON.stringify(restNewest) === JSON.stringify(restEntry)) return; // consecutive duplicate
  }
  entries.unshift(entry);
  writeHistory(entries.slice(0, HISTORY_LIMIT));
  renderHistory();
}

function restoreRequest(entry) {
  els.method.value = REQUEST_METHODS.includes(entry.method) ? entry.method : "GET";
  els.url.value = entry.url ?? "";
  setHeadersFromText(entry.headerText ?? "");
  els.body.value = entry.body ?? "";
  const auth = entry.auth ?? { kind: "none" };
  els.authKind.value = ["none", "bearer", "basic"].includes(auth.kind) ? auth.kind : "none";
  els.authToken.value = auth.token ?? "";
  els.authUser.value = auth.username ?? "";
  els.authPass.value = auth.password ?? "";
  syncAuthInputs();
  syncBodyState();
  updateInputStatus();
  refreshVariableChips();
  els.inputError.textContent = "";
}

function describeAge(timestamp) {
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function renderHistory() {
  const entries = readHistory();
  els.history.innerHTML = "";
  els.historyEmpty.hidden = entries.length > 0;
  for (const entry of entries) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "hist-item";
    item.title = `${entry.method} ${entry.url}`;

    const method = document.createElement("span");
    method.className = "hist-method";
    method.textContent = entry.method;

    const url = document.createElement("span");
    url.className = "hist-url";
    url.textContent = (entry.url ?? "").replace(/^https?:\/\//, "");

    const age = document.createElement("span");
    age.className = "hist-age";
    age.textContent = describeAge(entry.at ?? Date.now());

    item.append(method, url);
    if (entry.env) {
      const env = document.createElement("span");
      env.className = "hist-env";
      env.textContent = entry.env;
      item.appendChild(env);
    }
    item.appendChild(age);
    item.addEventListener("click", () => restoreRequest(entry));
    els.history.appendChild(item);
  }
}

/* ------------------------------- responses ------------------------------- */

function resetResponse() {
  els.respLine.hidden = true;
  els.respHeadersBox.hidden = true;
  els.respError.textContent = "";
  els.respBody.innerHTML = `<span class="j-null">// sending…</span>`;
  lastBodyText = "";
  hideResponseTools();
}

/** Hide the JSON tree/capture tooling and fall back to the raw body view. */
function hideResponseTools() {
  lastJsonValue = undefined;
  els.respTools.hidden = true;
  els.respTree.hidden = true;
  els.respRaw.hidden = false;
}

/* --------------------------- response JSON tree --------------------------- */

/** Build the path of a child node, e.g. `$.items[0].id`. */
function childPath(parentPath, key) {
  if (typeof key === "number") return `${parentPath}[${key}]`;
  return /^[A-Za-z_$][\w$-]*$/.test(key) ? `${parentPath}.${key}` : `${parentPath}['${key}']`;
}

/** One-line preview of a value for tree meta / capture feedback. */
function shortPreview(value) {
  const text = variableStringFor(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/** Does this key/primitive match the tree search query? */
function matchesQuery(query, key, value) {
  if (String(key).toLowerCase().includes(query)) return true;
  return value !== undefined && !isContainer(value) &&
    variableStringFor(value).toLowerCase().includes(query);
}

function isContainer(value) {
  return value !== null && typeof value === "object";
}

/** Class used by the raw highlighter for a primitive, reused in the tree. */
function primitiveClass(value) {
  if (typeof value === "string") return "j-str";
  if (typeof value === "boolean") return "j-bool";
  if (value === null) return "j-null";
  return "j-num";
}

/**
 * Build one tree node. Returns undefined when a search query is active and
 * nothing in this branch matches. Containers render as <details>, leaves as
 * clickable rows that fill the capture-path input.
 */
function buildTreeNode(key, value, path, query, depth) {
  if (!isContainer(value)) {
    const isHit = query !== "" && matchesQuery(query, key, value);
    if (query !== "" && !isHit) return undefined;
    const row = document.createElement("div");
    row.className = "tree-row" + (isHit ? " hit" : "");
    row.title = `${path} — click to use this path`;
    const keySpan = document.createElement("span");
    keySpan.className = "tree-key";
    keySpan.textContent = String(key);
    const valueSpan = document.createElement("span");
    valueSpan.className = primitiveClass(value);
    valueSpan.textContent = typeof value === "string" ? `"${value}"` : String(value);
    row.append(keySpan, document.createTextNode(": "), valueSpan);
    row.addEventListener("click", () => {
      els.capturePath.value = path;
      refreshCapturePreview();
    });
    return row;
  }

  const entries = Array.isArray(value)
    ? value.map((item, index) => [index, item])
    : Object.entries(value);
  const children = [];
  for (const [childKey, childValue] of entries) {
    const child = buildTreeNode(
      childKey,
      childValue,
      childPath(path, childKey),
      query,
      depth + 1,
    );
    if (child) children.push(child);
  }
  const keyMatches = query !== "" && String(key).toLowerCase().includes(query);
  if (query !== "" && children.length === 0 && !keyMatches) return undefined;

  const node = document.createElement("details");
  node.className = "tree-node";
  node.open = query !== "" || depth < 2;
  const summary = document.createElement("summary");
  const keySpan = document.createElement("span");
  keySpan.className = "tree-key" + (keyMatches ? " hit" : "");
  keySpan.textContent = String(key);
  const meta = document.createElement("span");
  meta.className = "tree-meta";
  meta.textContent = Array.isArray(value) ? `[${value.length}]` : `{${entries.length}}`;
  summary.append(keySpan, document.createTextNode(" "), meta);
  summary.title = path;
  node.appendChild(summary);
  const box = document.createElement("div");
  box.className = "tree-children";
  if (children.length === 0) {
    const empty = document.createElement("div");
    empty.className = "tree-row";
    empty.innerHTML = `<span class="j-null">${Array.isArray(value) ? "[]" : "{}"}</span>`;
    box.appendChild(empty);
  }
  for (const child of children) box.appendChild(child);
  node.appendChild(box);
  return node;
}

function renderJsonTree() {
  els.respTree.innerHTML = "";
  const query = els.respSearch.value.trim().toLowerCase();
  const root = buildTreeNode("$", lastJsonValue, "$", query, 0);
  if (!root) {
    els.respTree.innerHTML = `<span class="j-null">// nothing matches the search</span>`;
    return;
  }
  els.respTree.appendChild(root);
}

/** Show tree or raw body according to the toggle and response type. */
function syncBodyView() {
  const hasJson = lastJsonValue !== undefined;
  const showTree = hasJson && respView === "tree";
  els.viewTree.classList.toggle("is-active", showTree);
  els.viewRaw.classList.toggle("is-active", !showTree);
  els.viewTree.setAttribute("aria-selected", String(showTree));
  els.viewRaw.setAttribute("aria-selected", String(!showTree));
  els.respTree.hidden = !showTree;
  els.respRaw.hidden = showTree;
  els.respSearch.disabled = !showTree;
  if (showTree) renderJsonTree();
}

/* --------------------------- capture into variable ------------------------ */

function refreshCapturePreview() {
  const path = els.capturePath.value.trim();
  if (path === "" || lastJsonValue === undefined) {
    els.capturePreview.textContent = "";
    els.capturePreview.className = "capture-preview";
    els.captureSave.disabled = true;
    return;
  }
  const result = extractJsonPath(lastJsonValue, path);
  els.capturePreview.textContent = result.ok
    ? `= ${shortPreview(result.value)}`
    : `✗ ${result.error}`;
  els.capturePreview.className = "capture-preview " + (result.ok ? "ok" : "bad");
  els.captureSave.disabled = !result.ok;
}

/** Save the extracted value as a variable in the active environment. */
function captureVariable() {
  const path = els.capturePath.value.trim();
  const name = els.captureName.value.trim();
  if (!/^[A-Za-z_][\w-]*$/.test(name)) {
    showToast("Give the variable a name (letters, digits, _ or -)");
    els.captureName.focus();
    return;
  }
  const result = extractJsonPath(lastJsonValue, path);
  if (!result.ok) {
    showToast(`Nothing to capture — ${result.error}`);
    return;
  }
  const state = readEnvironmentsState();
  let active = activeEnvironment(state);
  if (!active) {
    active = { id: crypto.randomUUID(), name: "dev", variables: [] };
    state.environments.push(active);
    state.activeId = active.id;
  }
  const value = variableStringFor(result.value);
  const existing = active.variables.find((variable) => variable.name === name);
  if (existing) existing.value = value;
  else active.variables.push({ name, value });
  writeEnvironmentsState(state);
  renderEnvironments();
  showToast(`Captured {{${name}}} into "${active.name}"`);
}

/* ------------------------------- curl import ------------------------------ */

function applyCurlImport(text) {
  const parsed = parseCurlCommand(text);
  if (!parsed.ok) {
    els.curlError.textContent = parsed.error;
    return false;
  }
  restoreRequest(parsed.request);
  els.curlError.textContent = "";
  els.curlBox.hidden = true;
  els.curlInput.value = "";
  showToast(
    parsed.notes.length > 0 ? `curl imported · ${parsed.notes.join(", ")}` : "curl imported",
  );
  return true;
}

function renderResponse(response, bodyBuffer, durationMs) {
  els.respLine.hidden = false;
  els.respStatus.textContent = `${response.status} ${response.statusText}`.trim();
  els.respStatus.className = "resp-status " +
    (response.status < 300 ? "ok" : response.status < 400 ? "warn" : "bad");
  els.respTime.textContent = formatDuration(durationMs);
  els.respSize.textContent = formatBytes(bodyBuffer.byteLength);

  const headerLines = [...response.headers.entries()]
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
  els.respHeadersBox.hidden = headerLines === "";
  els.respHeaders.textContent = headerLines;

  const contentType = response.headers.get("content-type") ?? "";
  if (!isTextualContentType(contentType)) {
    lastBodyText = "";
    els.respBody.innerHTML = `<span class="j-null">// binary response (${
      escapeHtml(contentType || "unknown type")
    }, ${formatBytes(bodyBuffer.byteLength)}) — not displayed</span>`;
    return;
  }

  let text = new TextDecoder().decode(bodyBuffer);
  let isTruncated = false;
  if (text.length > BODY_DISPLAY_LIMIT) {
    text = text.slice(0, BODY_DISPLAY_LIMIT);
    isTruncated = true;
  }

  lastBodyText = text;
  lastJsonValue = undefined;
  if (isJsonContentType(contentType)) {
    try {
      const parsed = JSON.parse(text);
      const pretty = JSON.stringify(parsed, null, 2);
      lastBodyText = pretty;
      lastJsonValue = parsed;
      els.respBody.innerHTML = highlightJson(pretty);
    } catch {
      els.respBody.textContent = text; // declared JSON but isn't — show raw
    }
  } else {
    els.respBody.textContent = text === "" ? "(empty body)" : text;
  }
  if (isTruncated) {
    els.respBody.innerHTML += `\n<span class="j-null">// … truncated for display</span>`;
  }
  els.respTools.hidden = lastJsonValue === undefined;
  refreshCapturePreview();
  syncBodyView();
}

/* --------------------------------- send ---------------------------------- */

async function send() {
  const template = readRequest();
  const { request, unresolved } = resolveRequest(template, activeVariableMap());
  if (unresolved.length > 0) {
    els.inputError.textContent = `Unresolved variable${unresolved.length === 1 ? "" : "s"}: ${
      unresolved.join(", ")
    } — set ${unresolved.length === 1 ? "it" : "them"} in the active environment.`;
    return;
  }
  const target = validateUrl(request.url);
  if (!target.ok) {
    els.inputError.textContent = target.error;
    return;
  }
  const { headers, errors } = buildRequestHeaders(request);
  if (errors.length > 0) {
    els.inputError.textContent = errors.join(" · ");
    return;
  }
  els.inputError.textContent = "";
  rememberRequest(template);
  resetResponse();

  inflight = new AbortController();
  els.send.disabled = true;
  els.abort.hidden = false;

  const startedAt = performance.now();
  try {
    const isBodySent = (request.body ?? "").trim() !== "" &&
      !BODYLESS_METHODS.has(request.method);
    const response = await fetch(target.url, {
      method: request.method,
      headers: headers.map(({ name, value }) => [name, value]),
      body: isBodySent ? request.body : undefined,
      signal: inflight.signal,
    });
    const bodyBuffer = await response.arrayBuffer();
    renderResponse(response, bodyBuffer, performance.now() - startedAt);
  } catch (error) {
    els.respLine.hidden = true;
    els.respHeadersBox.hidden = true;
    els.respBody.innerHTML = `<span class="j-null">// no response</span>`;
    els.respError.textContent = describeSendError(error);
    lastBodyText = "";
    hideResponseTools();
  } finally {
    inflight = undefined;
    els.send.disabled = false;
    els.abort.hidden = true;
  }
}

/* ------------------------------- actions --------------------------------- */

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${label} copied`);
  } catch {
    showToast("Copy failed — select and copy manually");
  }
}

function copyCurl() {
  const { request, unresolved } = resolveRequest(readRequest(), activeVariableMap());
  if (unresolved.length > 0) {
    els.inputError.textContent = `Unresolved variable${unresolved.length === 1 ? "" : "s"}: ${
      unresolved.join(", ")
    } — set ${unresolved.length === 1 ? "it" : "them"} in the active environment.`;
    return;
  }
  const target = validateUrl(request.url);
  if (!target.ok) {
    els.inputError.textContent = target.error;
    return;
  }
  const { headers, errors } = buildRequestHeaders(request);
  if (errors.length > 0) {
    els.inputError.textContent = errors.join(" · ");
    return;
  }
  els.inputError.textContent = "";
  copyText(
    buildCurlCommand({ ...request, url: target.url, headers, body: request.body ?? "" }),
    "curl command",
  );
}

/** Hand the response body to another tool — consumed on its page load. */
function sendResponseTo(target) {
  if (lastBodyText === "") return;
  if (!sendHandoff(sessionStorage, target, lastBodyText, "REST Client")) {
    showToast("Response too large to hand off — use Copy instead");
    return;
  }
  location.href = `../${target}/`;
}

function beautifyBody() {
  const result = formatJsonBody(els.body.value);
  if (!result.ok) {
    showToast(result.error);
    return;
  }
  if (result.text === els.body.value) {
    showToast("Body is already formatted");
    return;
  }
  els.body.value = result.text;
  els.body.dispatchEvent(new Event("input", { bubbles: true }));
  showToast("Body formatted");
}

function loadExample() {
  restoreRequest(EXAMPLE);
}

/* --------------------------------- wire ---------------------------------- */

for (const method of REQUEST_METHODS) {
  const option = document.createElement("option");
  option.value = method;
  option.textContent = method;
  els.method.appendChild(option);
}

for (const name of HEADER_NAME_SUGGESTIONS) {
  const option = document.createElement("option");
  option.value = name;
  els.headerNameList.appendChild(option);
}

els.method.addEventListener("change", () => {
  syncBodyState();
});
els.authKind.addEventListener("change", () => {
  syncAuthInputs();
  refreshVariableChips();
});
els.url.addEventListener("input", () => {
  updateInputStatus();
  refreshVariableChips();
});
els.body.addEventListener("input", refreshVariableChips);
for (const authInput of [els.authToken, els.authUser, els.authPass]) {
  authInput.addEventListener("input", refreshVariableChips);
}
els.url.addEventListener("keydown", (event) => {
  // when the autocomplete is open, Enter accepts a variable instead
  if (event.key === "Enter" && !isAutocompleteOpen()) send();
});
els.send.addEventListener("click", send);
els.abort.addEventListener("click", () => inflight?.abort());
els.copyCurl.addEventListener("click", copyCurl);
els.copyBody.addEventListener("click", () => {
  if (lastBodyText !== "") copyText(lastBodyText, "Response body");
});
els.sendSanitize.addEventListener("click", () => sendResponseTo("sanitize"));
els.sendDecode.addEventListener("click", () => sendResponseTo("decode"));

// curl import — via the toggle box, or by pasting a curl command into the URL
els.importCurl.addEventListener("click", () => {
  els.curlBox.hidden = !els.curlBox.hidden;
  if (!els.curlBox.hidden) els.curlInput.focus();
});
els.curlApply.addEventListener("click", () => applyCurlImport(els.curlInput.value));
els.curlCancel.addEventListener("click", () => {
  els.curlBox.hidden = true;
  els.curlError.textContent = "";
});
els.url.addEventListener("paste", (event) => {
  const pasted = event.clipboardData?.getData("text") ?? "";
  if (!/^\s*curl(\.exe)?\s/i.test(pasted)) return;
  if (!parseCurlCommand(pasted).ok) return; // let a broken command paste normally
  event.preventDefault();
  applyCurlImport(pasted);
});

// response tooling — tree/raw toggle, tree search, capture into a variable
els.viewTree.addEventListener("click", () => {
  respView = "tree";
  syncBodyView();
});
els.viewRaw.addEventListener("click", () => {
  respView = "raw";
  syncBodyView();
});
let searchTimer;
els.respSearch.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (!els.respTree.hidden) renderJsonTree();
  }, 150);
});
els.capturePath.addEventListener("input", refreshCapturePreview);
els.captureSave.addEventListener("click", captureVariable);
els.captureName.addEventListener("keydown", (event) => {
  if (event.key === "Enter") captureVariable();
});
els.capturePath.addEventListener("keydown", (event) => {
  if (event.key === "Enter") els.captureName.focus();
});
els.addHeader.addEventListener("click", () => addHeaderRow());
els.beautifyBody.addEventListener("click", beautifyBody);
els.loadExample.addEventListener("click", loadExample);
els.clearHistory.addEventListener("click", () => {
  writeHistory([]);
  renderHistory();
  showToast("History cleared");
});

els.envSelect.addEventListener("change", () => {
  const state = readEnvironmentsState();
  state.activeId = els.envSelect.value === "" ? null : els.envSelect.value;
  writeEnvironmentsState(state);
  renderEnvironments();
});
els.envNew.addEventListener("click", () => createEnvironment());
els.envNewFirst.addEventListener("click", () => createEnvironment());
els.envDuplicate.addEventListener("click", () => {
  const active = activeEnvironment();
  if (active) createEnvironment(active.variables.map((variable) => ({ ...variable })));
});
els.envDelete.addEventListener("click", () => {
  const state = readEnvironmentsState();
  const active = activeEnvironment(state);
  if (!active) return;
  state.environments = state.environments.filter((env) => env.id !== active.id);
  state.activeId = null;
  writeEnvironmentsState(state);
  renderEnvironments();
  showToast(`Environment "${active.name}" deleted`);
});
els.envName.addEventListener("input", () => {
  const state = readEnvironmentsState();
  const active = activeEnvironment(state);
  if (!active) return;
  active.name = els.envName.value.trim() || "unnamed";
  writeEnvironmentsState(state);
  const option = els.envSelect.querySelector(`option[value="${active.id}"]`);
  if (option) option.textContent = `env: ${active.name}`;
});
els.varMask.addEventListener("click", () => {
  areValuesMasked = !areValuesMasked;
  els.varMask.setAttribute("aria-pressed", String(areValuesMasked));
  els.varMask.textContent = areValuesMasked ? "👁 Show values" : "🙈 Hide values";
  for (const input of els.varRows.querySelectorAll(".var-value")) {
    input.type = areValuesMasked ? "password" : "text";
  }
});
// {{variable}} autocomplete — attached after the Enter-to-send handler above
// so the open-menu guard sees the menu state first.
for (const field of [els.url, els.body, els.authToken, els.authUser, els.authPass]) {
  attachVariableAutocomplete(field);
}
// (theme toggle is wired by the shared theme.js module)

registerCommands([
  { icon: "🚀", title: "Send request", hint: "action", keywords: ["fetch", "go"], run: send },
  { icon: "📋", title: "Copy as curl", hint: "action", keywords: ["export"], run: copyCurl },
  {
    icon: "📄",
    title: "Copy response body",
    hint: "action",
    run: () => {
      if (lastBodyText !== "") copyText(lastBodyText, "Response body");
    },
  },
  { icon: "✨", title: "Load example request", hint: "action", run: loadExample },
  {
    icon: "⤵️",
    title: "Import curl command",
    hint: "action",
    keywords: ["curl", "paste", "import"],
    run: () => {
      els.curlBox.hidden = false;
      els.curlInput.focus();
    },
  },
  {
    icon: "🧲",
    title: "Capture response value into a variable",
    hint: "action",
    keywords: ["capture", "extract", "token", "variable", "jsonpath"],
    run: () => els.capturePath.focus(),
  },
  {
    icon: "🔒",
    title: "Send response to Sanitize JSON",
    hint: "action",
    run: () => sendResponseTo("sanitize"),
  },
  {
    icon: "🔍",
    title: "Send response to Decode Anything",
    hint: "action",
    run: () => sendResponseTo("decode"),
  },
]);

setHeadersFromText("");
syncAuthInputs();
syncBodyState();
renderEnvironments();
renderHistory();

// An incoming handoff from another tool becomes the request body. GET/HEAD
// would ignore it, so a bodyless method is bumped to POST.
function receiveHandoff() {
  const handoff = takeHandoff(sessionStorage, "rest");
  if (!handoff) return;
  els.body.value = handoff.text;
  if (BODYLESS_METHODS.has(els.method.value)) els.method.value = "POST";
  syncBodyState();
  refreshVariableChips();
  showToast(`Received from ${handoff.from || "another tool"} — set as request body`);
}

// Re-check on back/forward-cache restores too (Send to → Back → Send to again
// revives this page without re-running the script).
globalThis.addEventListener("pageshow", (event) => {
  if (event.persisted) receiveHandoff();
});

receiveHandoff();
