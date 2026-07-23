// @ts-check
/**
 * Shortlink — pure logic for the personal shortlink tool.
 *
 * Links are a plain map `{ name: { url, group? } }` kept in localStorage by the
 * UI; a missing or empty `group` means ungrouped. No DOM, no storage access —
 * the browser UI and the Deno parity tests import this very file unchanged.
 */

/** localStorage key for the saved links. */
export const STORE_KEY = "meso-shortlinks";

/**
 * @typedef {{ url: string, group?: string, order?: number }} LinkEntry
 * @typedef {Record<string, LinkEntry>} Links
 */

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Validate a new shortlink name: lowercase letters, digits and single hyphens,
 * unique across all groups.
 * @param {string} name
 * @param {Links} links Existing links (for the uniqueness check).
 * @returns {{ ok: true, name: string } | { ok: false, error: string }}
 */
export function validateName(name, links) {
  const trimmed = String(name ?? "").trim();
  if (trimmed === "") return { ok: false, error: "Enter a name." };
  if (!NAME_PATTERN.test(trimmed)) {
    return { ok: false, error: "Use lowercase letters, digits and hyphens (e.g. sprint-board)." };
  }
  if (Object.hasOwn(links, trimmed)) return { ok: false, error: `"${trimmed}" is already taken.` };
  return { ok: true, name: trimmed };
}

/**
 * Validate a target URL: parseable, http(s) only (browsers block redirects to
 * other schemes such as file:).
 * @param {string} url
 * @returns {{ ok: true, url: string } | { ok: false, error: string }}
 */
export function validateUrl(url) {
  const trimmed = String(url ?? "").trim();
  if (trimmed === "") return { ok: false, error: "Enter a target URL." };
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "Enter a full URL, including https://." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Only http(s) targets can be redirected to." };
  }
  return { ok: true, url: trimmed };
}

/**
 * Add a link after validating the name and URL. Returns a new map — the input
 * is never mutated. An empty group means ungrouped and stores no `group` key.
 * @param {Links} links
 * @param {string} name
 * @param {string} url
 * @param {string} group
 * @returns {{ ok: true, links: Links } | { ok: false, error: string }}
 */
export function addLink(links, name, url, group) {
  const validName = validateName(name, links);
  if (!validName.ok) return validName;
  const validUrl = validateUrl(url);
  if (!validUrl.ok) return validUrl;
  const normalizedGroup = normalizeGroup(group);
  /** @type {LinkEntry} */
  const entry = normalizedGroup === ""
    ? { url: validUrl.url }
    : { url: validUrl.url, group: normalizedGroup };
  return { ok: true, links: { ...links, [validName.name]: entry } };
}

/**
 * Remove a link by name. Returns a new map — the input is never mutated.
 * @param {Links} links
 * @param {string} name
 * @returns {Links}
 */
export function removeLink(links, name) {
  const { [name]: _removed, ...rest } = links;
  return rest;
}

/**
 * The target URL for a name, or null when unknown.
 * @param {Links} links
 * @param {string} name
 * @returns {string | null}
 */
export function resolve(links, name) {
  return Object.hasOwn(links, name) ? links[name].url : null;
}

/**
 * The name of an existing link whose target is exactly `url`, or null — used to
 * warn before the same URL is saved under a second name. Ties break by name
 * (A→Z) so the hint is stable.
 * @param {Links} links
 * @param {string} url
 * @returns {string | null}
 */
export function findDuplicateTarget(links, url) {
  const target = String(url ?? "").trim();
  if (target === "") return null;
  for (const name of Object.keys(links).sort()) {
    if (links[name].url === target) return name;
  }
  return null;
}

/**
 * Resolve a hash that may be dynamic. Exact names win (a `{q}` in the target
 * is blanked). Otherwise `head/rest` resolves `head` and either substitutes
 * the URL-encoded rest for every `{q}` in the target (search-engine style) or
 * appends `/rest` to it.
 * @param {Links} links
 * @param {string} name
 * @returns {string | null}
 */
export function resolveDynamic(links, name) {
  const direct = resolve(links, name);
  if (direct !== null) return direct.replaceAll("{q}", "");
  const slash = name.indexOf("/");
  if (slash <= 0) return null;
  const target = resolve(links, name.slice(0, slash));
  if (target === null) return null;
  const rest = name.slice(slash + 1);
  if (target.includes("{q}")) return target.replaceAll("{q}", encodeURIComponent(rest));
  return `${target.replace(/\/+$/, "")}/${rest}`;
}

/**
 * The links whose name, target URL or group contains the query,
 * case-insensitively. A blank query returns the map unchanged.
 * @param {Links} links
 * @param {string} query
 * @returns {Links}
 */
export function filterLinks(links, query) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (needle === "") return links;
  /** @type {Links} */
  const filtered = {};
  for (const [name, entry] of Object.entries(links)) {
    const haystack = `${name}\n${entry.url}\n${entry.group ?? ""}`.toLowerCase();
    if (haystack.includes(needle)) filtered[name] = entry;
  }
  return filtered;
}

/**
 * The most-visited links: redirect counts are kept per name by the UI; names
 * with no count (or that no longer exist) are dropped, ties break by name.
 * @param {Links} links
 * @param {Record<string, number>} hits
 * @param {number} limit
 * @returns {{ name: string, url: string, count: number }[]}
 */
export function topLinks(links, hits, limit) {
  return Object.keys(links)
    .map((name) => ({ name, url: links[name].url, count: hits[name] ?? 0 }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * Encode links as a URL-safe blob for a share link (`#share=<blob>`):
 * base64url over the stable JSON export, no padding.
 * @param {Links} links
 * @returns {string}
 */
export function encodeShare(links) {
  const bytes = new TextEncoder().encode(serializeLinks(links));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * Decode a share blob back into links, with the same validation as a file
 * import.
 * @param {string} blob
 * @returns {{ ok: true, links: Links } | { ok: false, error: string }}
 */
export function decodeShare(blob) {
  try {
    const base64 = String(blob ?? "").replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return parseImport(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, error: "That share link is not valid." };
  }
}

/**
 * The shortlink name carried by a location hash: strips the leading `#` and
 * percent-decodes (an invalid encoding is returned as-is; it will simply not
 * resolve).
 * @param {string} hash
 * @returns {string}
 */
export function parseHash(hash) {
  const raw = String(hash ?? "").replace(/^#/, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Normalize a group as a `/`-separated path: segments trimmed, empty segments
 * dropped. `" Team / FE "` → `"Team/FE"`; a blank or separator-only value is
 * ungrouped (`""`).
 * @param {string} text
 * @returns {string}
 */
export function normalizeGroup(text) {
  return String(text ?? "")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "")
    .join("/");
}

/**
 * The directory ordering: groups A→Z with ungrouped (`group: ""`) last.
 * Inside a group, entries with an `order` (assigned by reordering) come first,
 * by that order; entries without one follow A→Z.
 * @param {Links} links
 * @returns {{ group: string, entries: { name: string, url: string }[] }[]}
 */
export function groupLinks(links) {
  /** @type {Map<string, { name: string, url: string }[]>} */
  const byGroup = new Map();
  for (const name of Object.keys(links).sort()) {
    const group = String(links[name].group ?? "").trim();
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group)?.push({ name, url: links[name].url });
  }
  for (const entries of byGroup.values()) {
    entries.sort((a, b) => {
      const orderA = links[a.name].order;
      const orderB = links[b.name].order;
      if (typeof orderA === "number" && typeof orderB === "number") return orderA - orderB;
      if (typeof orderA === "number") return -1;
      if (typeof orderB === "number") return 1;
      return a.name.localeCompare(b.name);
    });
  }
  const groups = [...byGroup.keys()].sort((a, b) =>
    a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)
  );
  return groups.map((group) => ({ group, entries: byGroup.get(group) ?? [] }));
}

/**
 * The subset of links in `path` and its sub-groups — the branch a "Share group"
 * action carries (`Team` also takes `Team/Frontend`). An empty path selects the
 * ungrouped links.
 * @param {Links} links
 * @param {string} path
 * @returns {Links}
 */
export function linksInGroup(links, path) {
  const base = normalizeGroup(path);
  /** @type {Links} */
  const subset = {};
  for (const [name, entry] of Object.entries(links)) {
    const group = normalizeGroup(entry.group ?? "");
    const inBranch = base === "" ? group === "" : group === base || group.startsWith(`${base}/`);
    if (inBranch) subset[name] = entry;
  }
  return subset;
}

/**
 * The hierarchical render order for the directory: `/` in a group name nests
 * (`Team/Frontend` sits under `Team`). Returns a preorder list of
 * `{ path, label, depth, entries }` — siblings A→Z, parents before children,
 * parents without direct links included with empty entries, ungrouped last.
 * `declaredGroups` are explicitly created group paths that render even while
 * empty (they merge with the groups implied by the links).
 * @param {Links} links
 * @param {string[]} [declaredGroups]
 * @returns {{ path: string, label: string, depth: number,
 *   entries: { name: string, url: string }[] }[]}
 */
export function groupTree(links, declaredGroups = []) {
  /** @typedef {{ children: Map<string, TreeNode>, entries: { name: string, url: string }[] }} TreeNode */
  /** @type {Map<string, TreeNode>} */
  const root = new Map();
  /** @type {{ name: string, url: string }[] | null} */
  let ungrouped = null;
  for (const { group, entries } of groupLinks(links)) {
    if (group === "") {
      ungrouped = entries;
      continue;
    }
    let level = root;
    /** @type {TreeNode | null} */
    let node = null;
    for (const segment of group.split("/")) {
      if (!level.has(segment)) level.set(segment, { children: new Map(), entries: [] });
      node = /** @type {TreeNode} */ (level.get(segment));
      level = node.children;
    }
    if (node) node.entries = entries;
  }
  for (const declared of declaredGroups) {
    const path = normalizeGroup(declared);
    if (path === "") continue;
    let level = root;
    for (const segment of path.split("/")) {
      if (!level.has(segment)) level.set(segment, { children: new Map(), entries: [] });
      level = /** @type {TreeNode} */ (level.get(segment)).children;
    }
  }
  /** @type {{ path: string, label: string, depth: number, entries: { name: string, url: string }[] }[]} */
  const result = [];
  /**
   * @param {Map<string, TreeNode>} level
   * @param {string} prefix
   * @param {number} depth
   */
  const walk = (level, prefix, depth) => {
    for (const label of [...level.keys()].sort((a, b) => a.localeCompare(b))) {
      const node = /** @type {TreeNode} */ (level.get(label));
      const path = prefix === "" ? label : `${prefix}/${label}`;
      result.push({ path, label, depth, entries: node.entries });
      walk(node.children, path, depth + 1);
    }
  };
  walk(root, "", 0);
  if (ungrouped) result.push({ path: "", label: "", depth: 0, entries: ungrouped });
  return result;
}

/**
 * Edit a link: rename it and/or change its target URL and group. The name is
 * validated against every other link (keeping the current name is fine); the
 * `order` survives while the group stays and is dropped on a group change,
 * like a drag between groups.
 * @param {Links} links
 * @param {string} oldName
 * @param {{ name: string, url: string, group: string }} changes
 * @returns {{ ok: true, links: Links } | { ok: false, error: string }}
 */
export function updateLink(links, oldName, changes) {
  if (!Object.hasOwn(links, oldName)) {
    return { ok: false, error: `"${oldName}" doesn't exist.` };
  }
  const others = removeLink(links, oldName);
  const validName = validateName(changes.name, others);
  if (!validName.ok) return validName;
  const validUrl = validateUrl(changes.url);
  if (!validUrl.ok) return validUrl;
  const group = normalizeGroup(changes.group);
  /** @type {LinkEntry} */
  const entry = { url: validUrl.url };
  if (group !== "") entry.group = group;
  const sameGroup = group === normalizeGroup(links[oldName].group ?? "");
  if (sameGroup && typeof links[oldName].order === "number") {
    entry.order = links[oldName].order;
  }
  return { ok: true, links: { ...others, [validName.name]: entry } };
}

/**
 * Rename a group: every link in it — and in its sub-groups, which keep their
 * sub-path under the new name — moves to the new path. Orders survive (the
 * arrangement moves as a whole). Renaming onto an existing group merges into
 * it.
 * @param {Links} links
 * @param {string} oldPath
 * @param {string} newPath
 * @returns {{ ok: true, links: Links } | { ok: false, error: string }}
 */
export function renameGroup(links, oldPath, newPath) {
  const from = normalizeGroup(oldPath);
  const to = normalizeGroup(newPath);
  if (to === "") return { ok: false, error: "Enter a group name." };
  if (to === from) return { ok: true, links };
  /** @type {Links} */
  const result = {};
  for (const [name, entry] of Object.entries(links)) {
    const group = normalizeGroup(entry.group ?? "");
    const renamed = group === from
      ? to
      : group.startsWith(`${from}/`)
      ? to + group.slice(from.length)
      : null;
    if (renamed === null) {
      result[name] = entry;
      continue;
    }
    /** @type {LinkEntry} */
    const moved = { url: entry.url, group: renamed };
    if (typeof entry.order === "number") moved.order = entry.order;
    result[name] = moved;
  }
  return { ok: true, links: result };
}

/**
 * Apply a group rename to a list of declared group paths: the renamed path and
 * its descendants follow, everything else is untouched. An empty target
 * returns the list unchanged (renameGroup rejects it for links).
 * @param {string[]} groups
 * @param {string} oldPath
 * @param {string} newPath
 * @returns {string[]}
 */
export function renameGroupList(groups, oldPath, newPath) {
  const from = normalizeGroup(oldPath);
  const to = normalizeGroup(newPath);
  if (to === "" || to === from) return groups;
  return groups.map((path) => {
    const group = normalizeGroup(path);
    if (group === from) return to;
    if (group.startsWith(`${from}/`)) return to + group.slice(from.length);
    return group;
  });
}

/**
 * Move a link to another group (an empty target makes it ungrouped). The old
 * `order` is dropped — position in the new group comes from a follow-up
 * `reorderLink` when the drop names one. Unknown names and the current group
 * return the map unchanged.
 * @param {Links} links
 * @param {string} name
 * @param {string} group
 * @returns {Links}
 */
export function moveToGroup(links, name, group) {
  if (!Object.hasOwn(links, name)) return links;
  const target = normalizeGroup(group);
  if (target === normalizeGroup(links[name].group ?? "")) return links;
  /** @type {LinkEntry} */
  const entry = target === "" ? { url: links[name].url } : { url: links[name].url, group: target };
  return { ...links, [name]: entry };
}

/**
 * Move a link within its group: before `beforeName`, or to the end when
 * `beforeName` is null. Every member of the group gets a sequential `order`
 * (0..n-1) so the arrangement is explicit from then on. Unknown names, a
 * target in another group or a self-target return the map unchanged.
 * @param {Links} links
 * @param {string} name
 * @param {string | null} beforeName
 * @returns {Links}
 */
export function reorderLink(links, name, beforeName) {
  if (!Object.hasOwn(links, name) || beforeName === name) return links;
  const group = String(links[name].group ?? "").trim();
  if (beforeName !== null) {
    if (!Object.hasOwn(links, beforeName)) return links;
    if (String(links[beforeName].group ?? "").trim() !== group) return links;
  }
  const entries = groupLinks(links).find((g) => g.group === group)?.entries ?? [];
  const names = entries.map((entry) => entry.name).filter((n) => n !== name);
  const insertAt = beforeName === null ? names.length : names.indexOf(beforeName);
  names.splice(insertAt, 0, name);
  /** @type {Links} */
  const result = { ...links };
  names.forEach((n, index) => {
    result[n] = { ...links[n], order: index };
  });
  return result;
}

/**
 * Stable pretty JSON for the export file: names sorted, so two exports of the
 * same links are byte-identical.
 * @param {Links} links
 * @returns {string}
 */
export function serializeLinks(links) {
  /** @type {Links} */
  const sorted = {};
  for (const name of Object.keys(links).sort()) sorted[name] = links[name];
  return JSON.stringify(sorted, null, 2);
}

/**
 * Parse and validate an imported shortlinks.json. Every entry must have a
 * valid name, an http(s) URL and — when present — a string group.
 * @param {string} text
 * @returns {{ ok: true, links: Links } | { ok: false, error: string }}
 */
export function parseImport(text) {
  let data;
  try {
    data = JSON.parse(String(text ?? ""));
  } catch {
    return { ok: false, error: "That file is not valid JSON." };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "Expected an object of { name: { url, group? } } entries." };
  }
  /** @type {Links} */
  const links = {};
  for (const [name, entry] of Object.entries(data)) {
    if (!NAME_PATTERN.test(name)) return { ok: false, error: `"${name}" is not a valid name.` };
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: `"${name}" is missing its { url } entry.` };
    }
    const validUrl = validateUrl(entry.url ?? "");
    if (!validUrl.ok) return { ok: false, error: `"${name}": ${validUrl.error}` };
    if (entry.group !== undefined && typeof entry.group !== "string") {
      return { ok: false, error: `"${name}": the group must be text.` };
    }
    if (entry.order !== undefined && typeof entry.order !== "number") {
      return { ok: false, error: `"${name}": the order must be a number.` };
    }
    const group = normalizeGroup(entry.group ?? "");
    /** @type {LinkEntry} */
    const parsed = { url: validUrl.url };
    if (group !== "") parsed.group = group;
    if (typeof entry.order === "number") parsed.order = entry.order;
    links[name] = parsed;
  }
  return { ok: true, links };
}

/**
 * Merge imported links into the existing map; imported entries win on a name
 * conflict. Returns a new map plus counts for the confirmation toast.
 * @param {Links} existing
 * @param {Links} imported
 * @returns {{ links: Links, added: number, replaced: number }}
 */
export function mergeLinks(existing, imported) {
  let added = 0;
  let replaced = 0;
  for (const name of Object.keys(imported)) {
    if (Object.hasOwn(existing, name)) replaced++;
    else added++;
  }
  return { links: { ...existing, ...imported }, added, replaced };
}

/**
 * Minimal HTML entity decoding for bookmark titles and folder names.
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Browser-generated root folder names that shouldn't become groups. */
const ROOT_FOLDER_NAMES = new Set([
  "bookmarks bar",
  "bookmarks toolbar",
  "bookmarks menu",
  "other bookmarks",
  "favorites",
  "favourites",
  "personal toolbar folder",
]);

/**
 * @typedef {{ title: string, url: string, folder: string }} Bookmark
 */

/**
 * Parse a browser's exported bookmarks file (the Netscape bookmark format all
 * browsers export). No DOM — a token scan over H3/DL/A keeps this module
 * loadable in the Deno parity tests. Only http(s) links are kept (bookmarklets
 * and file: links can't be redirected to); `folder` is the full folder trail
 * joined with `/` (a group path), with browser root folders ("Bookmarks bar",
 * …) excluded.
 * @param {string} text
 * @returns {{ ok: true, bookmarks: Bookmark[] } | { ok: false, error: string }}
 */
export function parseBookmarksHtml(text) {
  const html = String(text ?? "");
  if (!/NETSCAPE-Bookmark-file/i.test(html)) {
    return {
      ok: false,
      error: "That file is not a bookmarks export (expected the bookmarks.html " +
        "your browser's “Export bookmarks” produces).",
    };
  }
  /** @type {Bookmark[]} */
  const bookmarks = [];
  /** Folder-name stack; "" marks a root/unnamed level. */
  const stack = [];
  /** The most recent H3, adopted by the next <DL>. */
  let pending = "";
  const token = /<h3([^>]*)>([\s\S]*?)<\/h3>|<(dl)[^>]*>|<(\/dl)>|<a\s([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = token.exec(html)) !== null) {
    const [, h3Attrs, h3Text, dlOpen, dlClose, aAttrs, aText] = match;
    if (h3Text !== undefined) {
      const name = decodeEntities(h3Text).trim();
      const atRoot = stack.every((folder) => folder === "");
      const isRoot = /personal_toolbar_folder/i.test(h3Attrs) ||
        (atRoot && ROOT_FOLDER_NAMES.has(name.toLowerCase()));
      pending = isRoot ? "" : name;
    } else if (dlOpen !== undefined) {
      stack.push(pending);
      pending = "";
    } else if (dlClose !== undefined) {
      stack.pop();
    } else if (aAttrs !== undefined) {
      const href = /href="([^"]*)"/i.exec(aAttrs)?.[1] ?? "";
      if (!/^https?:\/\//i.test(href)) continue;
      // The full folder trail becomes a group path ("Work/Jira" → sub-group).
      const folder = stack.filter((name) => name !== "").join("/");
      bookmarks.push({ title: decodeEntities(aText).trim(), url: href, folder });
    }
  }
  if (bookmarks.length === 0) {
    return { ok: false, error: "No http(s) bookmarks found in that file." };
  }
  return { ok: true, bookmarks };
}

/**
 * A name-safe slug of arbitrary text: lowercase a-z/0-9 runs joined by "-".
 * @param {string} text
 * @returns {string}
 */
function slugify(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Turn parsed bookmarks into ready-to-import link candidates: names are
 * slugified from the title (falling back to the URL's hostname), deduped with
 * a -2/-3 suffix against the existing links and within the batch; the folder
 * becomes the group.
 * @param {Bookmark[]} bookmarks
 * @param {Links} existing
 * @returns {{ name: string, title: string, url: string, group: string }[]}
 */
export function bookmarksToLinks(bookmarks, existing) {
  const taken = new Set(Object.keys(existing));
  return bookmarks.map(({ title, url, folder }) => {
    let base = slugify(title);
    if (base === "") {
      try {
        base = slugify(new URL(url).hostname.replace(/^www\./, ""));
      } catch { /* fall through to the generic name */ }
    }
    if (base === "") base = "link";
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
    taken.add(name);
    return { name, title, url, group: folder };
  });
}

/**
 * Suggest a shortlink name from a target URL: the leading hostname label plus
 * the first path segment, slugified (`https://jira.mesoneer.io/browse` →
 * `jira-browse`). Deduped with a -2/-3 suffix against `links`, like a bookmark
 * import, so the suggestion is always free to take. Returns "" when the URL
 * can't be parsed as http(s).
 * @param {string} url
 * @param {Links} [links] Existing links, for the uniqueness suffix.
 * @returns {string}
 */
export function suggestName(url, links = {}) {
  let parsed;
  try {
    parsed = new URL(String(url ?? "").trim());
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  const label = parsed.hostname.replace(/^www\./, "").split(".")[0];
  const segment = parsed.pathname.split("/").find((part) => part !== "") ?? "";
  const base = slugify(`${label} ${segment}`);
  if (base === "") return "";
  let name = base;
  for (let i = 2; Object.hasOwn(links, name); i++) name = `${base}-${i}`;
  return name;
}

/**
 * A deterministic hue (0–359) for a piece of text — the same hostname or group
 * name gets the same color on every visit, which is what makes the grid view's
 * tiles recognizable. FNV-1a over the code points, folded onto the hue circle.
 * @param {string} text
 * @returns {number}
 */
export function hueForText(text) {
  let hash = 0x811c9dc5;
  for (const char of String(text ?? "")) {
    hash ^= /** @type {number} */ (char.codePointAt(0));
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 360;
}

/**
 * The compact host shown on a grid tile: hostname without a leading `www.`,
 * or the raw value when it isn't a parsable URL.
 * @param {string} url
 * @returns {string}
 */
export function displayHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return String(url ?? "");
  }
}

/**
 * The favicon URL for a grid tile: `https://<host>/favicon.ico` served by the
 * target's own origin — never a third-party icon service, so rendering the
 * directory only ever contacts hosts the user already has links to. Non-http(s)
 * targets and unparsable URLs get no favicon (the tile falls back to its
 * monogram). The scheme is preserved so plain-http intranet hosts aren't asked
 * for an https icon they can't serve.
 * @param {string} url
 * @returns {string | null}
 */
export function faviconUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return `${parsed.protocol}//${parsed.host}/favicon.ico`;
  } catch {
    return null;
  }
}

/**
 * The shareable shortlink URL for a name on the tool page: any existing hash
 * is replaced, an `index.html` suffix is dropped.
 * @param {string} pageHref The tool page's location.href.
 * @param {string} name
 * @returns {string}
 */
export function buildShortlinkUrl(pageHref, name) {
  const base = String(pageHref ?? "").split("#")[0].replace(/index\.html$/, "");
  return `${base}#${encodeURIComponent(name)}`;
}
